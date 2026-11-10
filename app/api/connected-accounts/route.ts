import { getActiveConnectedAccount, listConnectedAccounts, upsertConnectedAccount } from "@/lib/db";
import { getRobinhoodGateway } from "@/lib/robinhood";
import { resolveRequestUserId } from "@/lib/request-user";
import { ALPACA_ALLOWED_HOSTS, validateBrokerBaseUrl } from "@/lib/egress-guard";
import { NextResponse } from "next/server";
import crypto from "crypto";
import { mergeAccountCapabilities } from "@/lib/venue-contract";

export const dynamic = "force-dynamic";

function isAlpacaPaperCredential(input: { accountNumber?: unknown; apiKey?: unknown }): boolean {
  const accountNumber = typeof input.accountNumber === "string" ? input.accountNumber.trim().toUpperCase() : "";
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim().toUpperCase() : "";
  return accountNumber.startsWith("PA") || apiKey.startsWith("PK");
}

// List the user's connected accounts for the UI (e.g. the copy-strategy-to-account picker).
// listConnectedAccounts never includes secrets; we still project an explicit safe subset.
export async function GET(req: Request) {
  const userId = resolveRequestUserId(req);
  const accounts = listConnectedAccounts(userId)
    // `broker: "test"` remains an internal unit-test adapter, never a product account.
    .filter((a) => a.broker !== "test")
    .map((a) => ({
    id: a.id,
    broker: a.broker,
    environment: a.environment,
    accountNumber: a.accountNumber,
    label: a.label,
    taxationType: a.taxationType,
    isActive: a.isActive
    }));
  return NextResponse.json({ accounts });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const userId = resolveRequestUserId(req, body);
    if (body.broker === "test") {
      return new NextResponse("Test broker accounts are test infrastructure and cannot be added.", { status: 400 });
    }
    const broker =
      body.broker === "alpaca" ||
      body.broker === "alpaca-mcp" ||
      body.broker === "robinhood" ||
      body.broker === "tradier" ||
      body.broker === "etoro" ||
      body.broker === "public" ||
      body.broker === "webull" ||
      body.broker === "kalshi"
        ? body.broker
        : undefined;
    if (!broker) {
      return new NextResponse("broker is required (alpaca | alpaca-mcp | robinhood | tradier | etoro | public | webull | kalshi)", { status: 400 });
    }
    const taxationType =
      body.taxationType === "roth_ira" || body.taxationType === "traditional_ira" || body.taxationType === "taxable"
        ? body.taxationType
        : undefined;

    // Robinhood: sync the real agentic (read+write) account from the live MCP — never a
    // hand-typed number, and never the read-only Investing/Roth IRA accounts. Requires the
    // Robinhood MCP to already be connected (OAuth complete).
    if (broker === "robinhood") {
      const accounts = await getRobinhoodGateway(userId).getAccounts();
      // Prefer the account labeled "agentic". With only one eligible account the choice is
      // unambiguous. With multiple, fall back is unsafe: every non-IRA brokerage is now
      // agenticAllowed by default (Robinhood MCP omits the flag), so picking the wrong
      // account could attach live trading to a read-only Investing account — fail closed.
      const agenticAccounts = accounts.filter((a) => a.agenticAllowed);
      const labelMatch = agenticAccounts.find((a) => a.label.toLowerCase().includes("agentic"));
      const agentic = labelMatch ?? (agenticAccounts.length === 1 ? agenticAccounts[0] : undefined);
      if (!agentic) {
        const msg =
          agenticAccounts.length > 1
            ? 'Multiple Robinhood accounts are eligible but none is labeled "Agentic". Nickname the correct account "Agentic" in the Robinhood app and try again.'
            : "No agentic-enabled Robinhood account found. Connect your Robinhood agentic account first.";
        return new NextResponse(msg, { status: 400 });
      }
      // Idempotent: reuse the existing row for this account if already synced (no duplicate
      // rows on re-sync), and activate it on first connect (when nothing else is active yet).
      const existing = listConnectedAccounts(userId).find(
        (a) => a.broker === "robinhood" && a.accountNumber === agentic.accountNumber
      );
      upsertConnectedAccount({
        id: existing?.id ?? body.id ?? crypto.randomUUID(),
        userId,
        broker: "robinhood",
        environment: "live",
        accountNumber: agentic.accountNumber,
        // Preserve a user-customized in-app name across re-sync/reconnect: the Settings rename
        // control is the authority for the cosmetic label, so only take the broker label when
        // FIRST creating the row (Codex review, PR #1727). Otherwise a routine Sync Robinhood or
        // an OAuth return would silently revert a renamed account to "Robinhood Agentic".
        label: existing?.label ?? (agentic.label || "Robinhood Agentic"),
        taxationType: taxationType ?? existing?.taxationType,
        // Persist live capabilities from the broker so the UI can display them
        // and policy can enforce them without a round-trip on each strategy run.
        capabilities: mergeAccountCapabilities("robinhood", agentic.capabilities ?? existing?.capabilities),
        isActive: body.isActive ?? existing?.isActive ?? !getActiveConnectedAccount(userId)
      });
      return NextResponse.json({ ok: true, accountNumber: agentic.accountNumber, label: agentic.label });
    }

    // Alpaca Paper is inferred from either the account number ("PA...") or API
    // key ("PK...").
    if ((broker === "alpaca" || broker === "alpaca-mcp") && (!body.accountNumber || !body.accountNumber.trim())) {
      return new NextResponse("Account number is required for Alpaca", { status: 400 });
    }

    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    let environment: "paper" | "live" = "paper";
    if (broker === "tradier") {
      // Tradier has NO PK/PA-style credential prefix — each token is environment-scoped, so the
      // environment is an EXPLICIT selector (sandbox=paper / production=live), never inferred. A
      // single bearer token is required; no apiSecret, no forced accountNumber (probed/user-supplied).
      if (!apiKey) {
        return new NextResponse("Tradier access token is required", { status: 400 });
      }
      environment = body.environment === "live" ? "live" : "paper";
      // `environment` is the authority for the venue. Reject a baseUrl whose host doesn't match the
      // selected environment so a paper-labeled account can never be pointed at the live
      // api.tradier.com (or a live account at sandbox). The gateway also ignores a mismatched stored
      // baseUrl at read time; this rejects it at write time so the bad value never persists.
      if (typeof body.baseUrl === "string" && body.baseUrl.trim()) {
        const expectedHost = environment === "live" ? "api.tradier.com" : "sandbox.tradier.com";
        let host: string | undefined;
        try {
          host = new URL(body.baseUrl.trim()).host.toLowerCase();
        } catch {
          host = undefined;
        }
        if (host !== expectedHost) {
          return new NextResponse(
            `Tradier ${environment} accounts must use ${expectedHost}; the provided base URL host does not match the selected environment.`,
            { status: 400 }
          );
        }
      }
    } else if (broker === "etoro") {
      const userKey = typeof body.apiSecret === "string" ? body.apiSecret.trim() : "";
      if (!apiKey || !userKey) {
        return new NextResponse("eToro requires x-api-key and x-user-key (Settings → Trading → API Key Management).", { status: 400 });
      }
      environment = body.environment === "paper" ? "paper" : "live";
    } else if (broker === "public") {
      const secret = typeof body.apiSecret === "string" ? body.apiSecret.trim() : apiKey;
      if (!secret) {
        return new NextResponse("Public.com requires the Individual API secret from Account Settings → Security → API.", { status: 400 });
      }
      environment = "live";
    } else if (broker === "webull") {
      const secret = typeof body.apiSecret === "string" ? body.apiSecret.trim() : "";
      if (!apiKey || !secret) {
        return new NextResponse("Webull requires OpenAPI App Key and App Secret from Developer Tool → My Application.", { status: 400 });
      }
      environment = body.environment === "paper" ? "paper" : "live";
    } else if (broker === "kalshi") {
      const secret = typeof body.apiSecret === "string" ? body.apiSecret.trim() : "";
      if (!apiKey || !secret) {
        return new NextResponse("Kalshi requires API Key ID (UUID) and Private Key PEM.", { status: 400 });
      }
      environment = body.environment === "live" ? "live" : "paper";
    } else if (broker === "alpaca" || broker === "alpaca-mcp") {
      environment = isAlpacaPaperCredential({ accountNumber: body.accountNumber, apiKey }) ? "paper" : "live";
      // A user-supplied baseUrl is trusted with the account's API credentials on every broker
      // call, so it must be an official Alpaca host (or an owner-approved extra host — see
      // EGRESS_EXTRA_ALLOWED_HOSTS) rather than an arbitrary attacker/typo-controlled endpoint
      // (SSRF / credential-exfiltration hardening — src/lib/egress-guard.ts).
      if (typeof body.baseUrl === "string" && body.baseUrl.trim()) {
        const check = validateBrokerBaseUrl(body.baseUrl.trim(), ALPACA_ALLOWED_HOSTS);
        if (!check.ok) {
          return new NextResponse(check.error ?? "baseUrl is not an allowed broker endpoint.", { status: 400 });
        }
      }
    } else {
      environment = body.environment === "live" ? "live" : "paper";
    }

    const defaultLabel =
      broker === "kalshi"
        ? `Kalshi ${environment === "paper" ? "Demo" : "Live"}`
        : broker === "tradier"
          ? `Tradier ${environment === "paper" ? "Sandbox" : "Brokerage"}`
          : broker === "etoro"
            ? `eToro ${environment === "paper" ? "Demo" : "Real"}`
            : broker === "public"
              ? "Public Brokerage"
              : broker === "webull"
                ? `Webull ${environment === "paper" ? "Sandbox" : "Brokerage"}`
                : broker === "alpaca-mcp"
                  ? `Alpaca MCP ${environment === "paper" ? "Paper" : "Brokerage"}`
                  : `Alpaca ${environment === "paper" ? "Paper" : "Brokerage"}`;
    let accountNumber = typeof body.accountNumber === "string" ? body.accountNumber.trim() || undefined : (broker === "kalshi" ? (apiKey ? `kalshi-${apiKey.slice(0, 8)}` : "kalshi-account") : undefined);

    const connectedAccountId = body.id ?? crypto.randomUUID();
    const connectedAccountLabel = typeof body.label === "string" ? body.label.trim() || defaultLabel : defaultLabel;
    upsertConnectedAccount({
      id: connectedAccountId,
      userId,
      broker,
      environment,
      accountNumber,
      label: connectedAccountLabel,
      apiKey: apiKey || undefined,
      apiSecret: typeof body.apiSecret === "string" ? body.apiSecret.trim() || undefined : undefined,
      baseUrl: typeof body.baseUrl === "string" && body.baseUrl.trim()
        ? body.baseUrl.trim()
        : broker === "kalshi"
          ? environment === "live"
            ? "https://external-api.kalshi.com/trade-api/v2"
            : "https://external-api.demo.kalshi.co/trade-api/v2"
          : broker === "tradier"
            ? environment === "paper"
              ? "https://sandbox.tradier.com/v1"
              : "https://api.tradier.com/v1"
            : (broker === "alpaca" || broker === "alpaca-mcp")
              ? environment === "paper"
                ? "https://paper-api.alpaca.markets/v2"
                : "https://api.alpaca.markets"
              : undefined,
      taxationType,
      capabilities: mergeAccountCapabilities(broker),
      isActive: body.isActive ?? false
    });

    // Tradier: resolve the account number from the token's profile if not provided by the user.
    // This avoids the "No account selected" rejection in strategy.ts when the policy copies a
    // missing accountNumber from the connected-account row.
    if (broker === "tradier" && !accountNumber) {
      let ambiguousError: Error | undefined;
      try {
        const { getTradierGateway } = await import("@/lib/tradier");
        const gw = getTradierGateway(userId, connectedAccountId);
        const brokerAccounts = await gw.getAccounts();
        if (brokerAccounts.length > 1) {
          ambiguousError = new Error("Multiple Tradier accounts found in profile. You must explicitly provide the Account Number to connect.");
        } else if (brokerAccounts.length === 1 && brokerAccounts[0].accountNumber) {
          accountNumber = brokerAccounts[0].accountNumber;
          upsertConnectedAccount({
            id: connectedAccountId,
            userId,
            broker,
            environment,
            accountNumber,
            label: connectedAccountLabel,
            apiKey: apiKey || undefined,
            capabilities: mergeAccountCapabilities("tradier", brokerAccounts[0].capabilities),
            baseUrl: broker === "tradier"
              ? environment === "paper"
                ? "https://sandbox.tradier.com/v1"
                : "https://api.tradier.com/v1"
              : undefined,
            isActive: body.isActive ?? false
          });
        }
      } catch {
        // Best-effort — the profile probe may fail (e.g. network blip) and the
        // account number stays undefined; the user can provide it on re-connect.
      }
      if (ambiguousError) throw ambiguousError;
    }

    return NextResponse.json({ ok: true, accountNumber, label: connectedAccountLabel });
  } catch (err) {
    return new NextResponse(err instanceof Error ? err.message : "Error", { status: 400 });
  }
}
