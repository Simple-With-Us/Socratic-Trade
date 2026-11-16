import { beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "path";
import { randomUUID } from "crypto";
import { tmpdir } from "os";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function prepareDeletion(userId: string, generation = randomUUID()): Promise<string> {
  const [{ getDb }, { markUserDeletionPrepared }] = await Promise.all([
    import("../src/lib/db"),
    import("../src/lib/user-write-fence")
  ]);
  const database = getDb();
  const now = new Date().toISOString();
  database.transaction(() => markUserDeletionPrepared(database, userId, generation, now)).immediate();
  return generation;
}

async function completeDeletion(userId: string, generation: string): Promise<void> {
  const [{ getDb }, { markUserDeletionCompleted }] = await Promise.all([
    import("../src/lib/db"),
    import("../src/lib/user-write-fence")
  ]);
  const database = getDb();
  const now = new Date().toISOString();
  database.transaction(() => markUserDeletionCompleted(database, userId, generation, now)).immediate();
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-oauth-${randomUUID()}.db`)}`;
});

describe("mcp oauth", () => {
  it("builds an authorization URL with PKCE parameters", async () => {
    vi.stubEnv("ROBINHOOD_MCP_AUTHORIZATION_URL", "https://auth.example.test/authorize");
    vi.stubEnv("ROBINHOOD_MCP_TOKEN_URL", "https://auth.example.test/token");
    vi.stubEnv("ROBINHOOD_MCP_CLIENT_ID", "client-123");
    vi.stubEnv("ROBINHOOD_MCP_REDIRECT_URI", "http://localhost:3000/api/auth/robinhood/callback");
    vi.stubEnv("ROBINHOOD_MCP_RESOURCE", "https://mcp.example.test/trading");
    const { buildMcpAuthorizationUrl } = await import("../src/lib/mcp-oauth");

    const authorizationUrl = new URL(await buildMcpAuthorizationUrl("user-a"));

    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe("https://auth.example.test/authorize");
    expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizationUrl.searchParams.get("client_id")).toBe("client-123");
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("code_challenge")).toBeTruthy();
    expect(authorizationUrl.searchParams.get("resource")).toBe("https://mcp.example.test/trading");
    expect(authorizationUrl.searchParams.get("state")).toBeTruthy();
  });

  it("does not persist OAuth state when account deletion starts during async client registration", async () => {
    vi.stubEnv("ROBINHOOD_MCP_AUTHORIZATION_URL", "https://auth.example.test/authorize");
    vi.stubEnv("ROBINHOOD_MCP_TOKEN_URL", "https://auth.example.test/token");
    vi.stubEnv("ROBINHOOD_MCP_CLIENT_REGISTRATION_URL", "https://auth.example.test/register");
    const registrationStarted = deferred<void>();
    const registrationResponse = deferred<Response>();
    vi.stubGlobal("fetch", async () => {
      registrationStarted.resolve();
      return registrationResponse.promise;
    });
    const [{ buildMcpAuthorizationUrl }, { getDb }] = await Promise.all([
      import("../src/lib/mcp-oauth"),
      import("../src/lib/db")
    ]);

    const pending = buildMcpAuthorizationUrl("user-a");
    const rejected = expect(pending).rejects.toThrow(/write epoch changed|operation claim was lost/i);
    await registrationStarted.promise;
    await prepareDeletion("user-a");
    registrationResponse.resolve(new Response(JSON.stringify({ client_id: "client-after-delete" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));

    await rejected;
    const stateRows = getDb().prepare(
      "SELECT COUNT(*) AS count FROM settings WHERE substr(key, 1, ?) = ?"
    ).get("robinhood_mcp_oauth_state:".length, "robinhood_mcp_oauth_state:") as { count: number };
    expect(stateRows.count).toBe(0);
  });

  it("discovers OAuth endpoints from the documented Robinhood MCP link before manual endpoint env", async () => {
    vi.stubEnv("ROBINHOOD_MCP_URL", "https://agent.robinhood.com/mcp/trading");
    vi.stubEnv("ROBINHOOD_MCP_AUTHORIZATION_URL", "https://wrong.example.test/oauth");
    vi.stubEnv("ROBINHOOD_MCP_TOKEN_URL", "https://wrong.example.test/token");
    vi.stubEnv("ROBINHOOD_MCP_CLIENT_REGISTRATION_URL", "https://wrong.example.test/register");
    vi.stubEnv("ROBINHOOD_MCP_REDIRECT_URI", "https://socratictrade.com/api/auth/robinhood/callback");
    const requestedUrls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      requestedUrls.push(href);
      if (href === "https://agent.robinhood.com/mcp/trading") {
        return new Response("authentication required", {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer resource_metadata="https://agent.robinhood.com/.well-known/oauth-protected-resource/mcp/trading"'
          }
        });
      }
      if (href === "https://agent.robinhood.com/.well-known/oauth-protected-resource/mcp/trading") {
        return new Response(
          JSON.stringify({
            resource: "https://agent.robinhood.com/mcp/trading",
            authorization_servers: ["https://agent.robinhood.com/mcp/trading"],
            scopes_supported: ["internal"]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (href === "https://agent.robinhood.com/.well-known/oauth-authorization-server/mcp/trading") {
        return new Response(
          JSON.stringify({
            authorization_endpoint: "https://auth.discovered.test/authorize",
            token_endpoint: "https://auth.discovered.test/token",
            registration_endpoint: "https://auth.discovered.test/register",
            scopes_supported: ["internal"]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (href === "https://auth.discovered.test/register") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { redirect_uris?: string[] };
        expect(body.redirect_uris).toEqual(["https://socratictrade.com/api/auth/robinhood/callback"]);
        return new Response(JSON.stringify({ client_id: "discovered-client" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    });
    const { buildMcpAuthorizationUrl } = await import("../src/lib/mcp-oauth");

    const authorizationUrl = new URL(await buildMcpAuthorizationUrl("user-a"));

    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe("https://auth.discovered.test/authorize");
    expect(authorizationUrl.searchParams.get("client_id")).toBe("discovered-client");
    expect(authorizationUrl.searchParams.get("scope")).toBe("internal");
    expect(authorizationUrl.searchParams.get("resource")).toBe("https://agent.robinhood.com/mcp/trading");
    expect(requestedUrls).not.toContain("https://wrong.example.test/register");
  });

  it("uses a public callback URL instead of a loopback redirect for production-hosted OAuth", async () => {
    vi.stubEnv("ROBINHOOD_MCP_AUTHORIZATION_URL", "https://auth.example.test/authorize");
    vi.stubEnv("ROBINHOOD_MCP_TOKEN_URL", "https://auth.example.test/token");
    vi.stubEnv("ROBINHOOD_MCP_CLIENT_ID", "client-123");
    vi.stubEnv("ROBINHOOD_MCP_REDIRECT_URI", "http://localhost:4000/api/auth/robinhood/callback");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://socratictrade.com");
    const { buildMcpAuthorizationUrl, findMcpOAuthStateByRandom, resolveMcpOAuthRedirectUri } = await import("../src/lib/mcp-oauth");

    const request = new Request("http://localhost:4000/api/auth/robinhood/start", { headers: { host: "localhost:4000" } });
    const redirectUri = resolveMcpOAuthRedirectUri(request);
    const authorizationUrl = new URL(await buildMcpAuthorizationUrl("user-a", { redirectUri }));
    const randomPart = authorizationUrl.searchParams.get("state")!;
    const found = findMcpOAuthStateByRandom(randomPart);

    expect(redirectUri).toBe("https://socratictrade.com/api/auth/robinhood/callback");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe("https://socratictrade.com/api/auth/robinhood/callback");
    expect(found!.value.redirectUri).toBe("https://socratictrade.com/api/auth/robinhood/callback");
  });

  it("preserves a configured public callback URL", async () => {
    vi.stubEnv("ROBINHOOD_MCP_REDIRECT_URI", "https://broker.example.test/api/auth/robinhood/callback");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://socratictrade.com");
    const { resolveMcpOAuthRedirectUri } = await import("../src/lib/mcp-oauth");

    const request = new Request("https://socratictrade.com/api/auth/robinhood/start");

    expect(resolveMcpOAuthRedirectUri(request)).toBe("https://broker.example.test/api/auth/robinhood/callback");
  });

  it("keeps the local callback in development instead of trusting x-forwarded-host", async () => {
    vi.stubEnv("ROBINHOOD_MCP_REDIRECT_URI", "http://localhost:4000/api/auth/robinhood/callback");
    const { resolveMcpOAuthRedirectUri } = await import("../src/lib/mcp-oauth");

    const request = new Request("http://localhost:4000/api/auth/robinhood/start", {
      headers: { "x-forwarded-host": "socratictrade.com" }
    });

    expect(resolveMcpOAuthRedirectUri(request)).toBe("http://localhost:4000/api/auth/robinhood/callback");
  });

  it("does not let an untrusted forwarded host choose the OAuth callback origin", async () => {
    const { resolveMcpOAuthRedirectUri } = await import("../src/lib/mcp-oauth");
    const request = new Request("http://localhost:4000/api/auth/robinhood/start", {
      headers: {
        host: "localhost:4000",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "https"
      }
    });

    expect(resolveMcpOAuthRedirectUri(request)).toBe("http://localhost:4000/api/auth/robinhood/callback");
  });

  it("uses the canonical production fallback when forwarded host is untrusted", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { resolveMcpOAuthRedirectUri } = await import("../src/lib/mcp-oauth");
    const request = new Request("http://localhost:4000/api/auth/robinhood/start", {
      headers: {
        host: "localhost:4000",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "https"
      }
    });

    expect(resolveMcpOAuthRedirectUri(request)).toBe("https://socratictrade.com/api/auth/robinhood/callback");
  });

  it("honors the configured loopback callback when explicitly enabled for Robinhood OAuth", async () => {
    vi.stubEnv("ROBINHOOD_MCP_AUTHORIZATION_URL", "https://auth.example.test/authorize");
    vi.stubEnv("ROBINHOOD_MCP_TOKEN_URL", "https://auth.example.test/token");
    vi.stubEnv("ROBINHOOD_MCP_CLIENT_ID", "client-123");
    vi.stubEnv("ROBINHOOD_MCP_REDIRECT_URI", "http://localhost:4000/api/auth/robinhood/callback");
    vi.stubEnv("ROBINHOOD_MCP_ALLOW_LOOPBACK_REDIRECT", "on");
    const { buildMcpAuthorizationUrl, findMcpOAuthStateByRandom, resolveMcpOAuthRedirectUri } = await import("../src/lib/mcp-oauth");

    const request = new Request("https://socratictrade.com/api/auth/robinhood/start");
    const redirectUri = resolveMcpOAuthRedirectUri(request);
    const authorizationUrl = new URL(await buildMcpAuthorizationUrl("user-a", { redirectUri }));
    const randomPart = authorizationUrl.searchParams.get("state")!;
    const found = findMcpOAuthStateByRandom(randomPart);

    expect(redirectUri).toBe("http://localhost:4000/api/auth/robinhood/callback");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe("http://localhost:4000/api/auth/robinhood/callback");
    expect(found!.value.redirectUri).toBe("http://localhost:4000/api/auth/robinhood/callback");
  });

  it("re-registers a dynamic OAuth client when the callback redirect changes", async () => {
    vi.stubEnv("ROBINHOOD_MCP_AUTHORIZATION_URL", "https://auth.example.test/authorize");
    vi.stubEnv("ROBINHOOD_MCP_TOKEN_URL", "https://auth.example.test/token");
    vi.stubEnv("ROBINHOOD_MCP_CLIENT_REGISTRATION_URL", "https://auth.example.test/register");
    const registrationRedirects: string[] = [];
    let registrationCount = 0;
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      registrationCount += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as { redirect_uris?: string[] };
      registrationRedirects.push(body.redirect_uris?.[0] ?? "");
      return new Response(JSON.stringify({ client_id: `client-${registrationCount}` }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const { buildMcpAuthorizationUrl } = await import("../src/lib/mcp-oauth");

    const firstUrl = new URL(
      await buildMcpAuthorizationUrl("user-a", { redirectUri: "http://localhost:4000/api/auth/robinhood/callback" })
    );
    const secondUrl = new URL(
      await buildMcpAuthorizationUrl("user-a", { redirectUri: "https://socratictrade.com/api/auth/robinhood/callback" })
    );

    expect(firstUrl.searchParams.get("client_id")).toBe("client-1");
    expect(secondUrl.searchParams.get("client_id")).toBe("client-2");
    expect(registrationRedirects).toEqual([
      "http://localhost:4000/api/auth/robinhood/callback",
      "https://socratictrade.com/api/auth/robinhood/callback"
    ]);
  });

  it("uses dynamic OAuth client registration even when a stale static client id is configured", async () => {
    vi.stubEnv("ROBINHOOD_MCP_AUTHORIZATION_URL", "https://auth.example.test/authorize");
    vi.stubEnv("ROBINHOOD_MCP_TOKEN_URL", "https://auth.example.test/token");
    vi.stubEnv("ROBINHOOD_MCP_CLIENT_REGISTRATION_URL", "https://auth.example.test/register");
    vi.stubEnv("ROBINHOOD_MCP_CLIENT_ID", "stale-static-client");
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { redirect_uris?: string[] };
      expect(body.redirect_uris?.[0]).toBe("https://socratictrade.com/api/auth/robinhood/callback");
      return new Response(JSON.stringify({ client_id: "dynamic-client" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const { buildMcpAuthorizationUrl } = await import("../src/lib/mcp-oauth");

    const authorizationUrl = new URL(
      await buildMcpAuthorizationUrl("user-a", { redirectUri: "https://socratictrade.com/api/auth/robinhood/callback" })
    );

    expect(authorizationUrl.searchParams.get("client_id")).toBe("dynamic-client");
  });

  it("uses the stored callback redirect and client when completing OAuth", async () => {
    vi.stubEnv("ROBINHOOD_MCP_AUTHORIZATION_URL", "https://auth.example.test/authorize");
    vi.stubEnv("ROBINHOOD_MCP_TOKEN_URL", "https://auth.example.test/token");
    vi.stubEnv("ROBINHOOD_MCP_CLIENT_REGISTRATION_URL", "https://auth.example.test/register");
    vi.stubEnv("ROBINHOOD_MCP_RESOURCE", "https://agent.robinhood.com/mcp/trading");
    const publicRedirect = "https://socratictrade.com/api/auth/robinhood/callback";
    const registrationRedirects: string[] = [];
    let tokenRequest: URLSearchParams | undefined;
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (href === "https://auth.example.test/register") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { redirect_uris?: string[] };
        registrationRedirects.push(body.redirect_uris?.[0] ?? "");
        return new Response(JSON.stringify({ client_id: `client-${registrationRedirects.length}` }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      tokenRequest = new URLSearchParams(String(init?.body ?? ""));
      return new Response(JSON.stringify({ access_token: "broker-token", token_type: "Bearer" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const { buildMcpAuthorizationUrl, completeMcpOAuthCallback, getMcpAccessToken } = await import("../src/lib/mcp-oauth");
    const authorizationUrl = new URL(await buildMcpAuthorizationUrl("user-a", { redirectUri: publicRedirect }));
    const state = authorizationUrl.searchParams.get("state")!;

    await completeMcpOAuthCallback({ code: "oauth-code", state, expectedUserId: "user-a" });

    expect(registrationRedirects).toEqual([publicRedirect]);
    expect(tokenRequest?.get("client_id")).toBe("client-1");
    expect(tokenRequest?.get("redirect_uri")).toBe(publicRedirect);
    expect(tokenRequest?.get("resource")).toBe("https://agent.robinhood.com/mcp/trading");
    expect(await getMcpAccessToken("user-a")).toBe("broker-token");
  });

  it("cannot recreate OAuth tokens when deletion is prepared during callback exchange", async () => {
    vi.stubEnv("ROBINHOOD_MCP_AUTHORIZATION_URL", "https://auth.example.test/authorize");
    vi.stubEnv("ROBINHOOD_MCP_TOKEN_URL", "https://auth.example.test/token");
    vi.stubEnv("ROBINHOOD_MCP_CLIENT_ID", "client-123");
    const tokenExchangeStarted = deferred<void>();
    const tokenResponse = deferred<Response>();
    const { buildMcpAuthorizationUrl, completeMcpOAuthCallback, getStoredMcpOAuthTokens } = await import(
      "../src/lib/mcp-oauth"
    );
    const state = new URL(await buildMcpAuthorizationUrl("user-a")).searchParams.get("state")!;
    vi.stubGlobal("fetch", async () => {
      tokenExchangeStarted.resolve();
      return tokenResponse.promise;
    });

    const pending = completeMcpOAuthCallback({ code: "oauth-code", state, expectedUserId: "user-a" });
    const rejected = expect(pending).rejects.toThrow(/write epoch changed|operation claim was lost/i);
    await tokenExchangeStarted.promise;
    const generation = await prepareDeletion("user-a");
    tokenResponse.resolve(new Response(JSON.stringify({ access_token: "post-delete-token", token_type: "Bearer" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));

    await rejected;
    expect(getStoredMcpOAuthTokens("user-a")).toBeUndefined();
    await completeDeletion("user-a", generation);
    expect(getStoredMcpOAuthTokens("user-a")).toBeUndefined();
  });

  it("consumes callback state before exchange so a failed exchange cannot be replayed", async () => {
    vi.stubEnv("ROBINHOOD_MCP_AUTHORIZATION_URL", "https://auth.example.test/authorize");
    vi.stubEnv("ROBINHOOD_MCP_TOKEN_URL", "https://auth.example.test/token");
    vi.stubEnv("ROBINHOOD_MCP_CLIENT_ID", "client-123");
    let exchanges = 0;
    vi.stubGlobal("fetch", async () => {
      exchanges += 1;
      return new Response("unavailable", { status: 503 });
    });
    const { buildMcpAuthorizationUrl, completeMcpOAuthCallback, findMcpOAuthStateByRandom } = await import(
      "../src/lib/mcp-oauth"
    );
    const state = new URL(await buildMcpAuthorizationUrl("user-a")).searchParams.get("state")!;

    await expect(completeMcpOAuthCallback({ code: "oauth-code", state })).rejects.toThrow("HTTP 503");
    expect(findMcpOAuthStateByRandom(state)).toBeUndefined();
    await expect(completeMcpOAuthCallback({ code: "oauth-code", state })).rejects.toThrow("not found or already used");
    expect(exchanges).toBe(1);
  });

  it("sends the MCP resource indicator when refreshing OAuth tokens", async () => {
    vi.stubEnv("ROBINHOOD_MCP_AUTHORIZATION_URL", "https://auth.example.test/authorize");
    vi.stubEnv("ROBINHOOD_MCP_TOKEN_URL", "https://auth.example.test/token");
    vi.stubEnv("ROBINHOOD_MCP_CLIENT_ID", "client-123");
    vi.stubEnv("ROBINHOOD_MCP_RESOURCE", "https://agent.robinhood.com/mcp/trading");
    let tokenRequest: URLSearchParams | undefined;
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      tokenRequest = new URLSearchParams(String(init?.body ?? ""));
      return new Response(JSON.stringify({ access_token: "fresh-token", token_type: "Bearer" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const { getMcpAccessToken, setMcpOAuthTokens } = await import("../src/lib/mcp-oauth");

    setMcpOAuthTokens("user-a", {
      accessToken: "old-token",
      refreshToken: "refresh-token",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() - 60_000).toISOString()
    });

    expect(await getMcpAccessToken("user-a")).toBe("fresh-token");
    expect(tokenRequest?.get("grant_type")).toBe("refresh_token");
    expect(tokenRequest?.get("resource")).toBe("https://agent.robinhood.com/mcp/trading");
  });

  it("cannot write a refreshed token when deletion is prepared during the exchange", async () => {
    vi.stubEnv("ROBINHOOD_MCP_AUTHORIZATION_URL", "https://auth.example.test/authorize");
    vi.stubEnv("ROBINHOOD_MCP_TOKEN_URL", "https://auth.example.test/token");
    vi.stubEnv("ROBINHOOD_MCP_CLIENT_ID", "client-123");
    const tokenExchangeStarted = deferred<void>();
    const tokenResponse = deferred<Response>();
    vi.stubGlobal("fetch", async () => {
      tokenExchangeStarted.resolve();
      return tokenResponse.promise;
    });
    const { getMcpAccessToken, getStoredMcpOAuthTokens, setMcpOAuthTokens } = await import("../src/lib/mcp-oauth");
    setMcpOAuthTokens("user-a", {
      accessToken: "old-token",
      refreshToken: "refresh-token",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() - 60_000).toISOString()
    });

    const pending = getMcpAccessToken("user-a");
    const rejected = expect(pending).rejects.toThrow(/write epoch changed|operation claim was lost/i);
    await tokenExchangeStarted.promise;
    const generation = await prepareDeletion("user-a");
    tokenResponse.resolve(new Response(JSON.stringify({ access_token: "post-delete-refresh", token_type: "Bearer" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));

    await rejected;
    expect(getStoredMcpOAuthTokens("user-a")?.accessToken).toBe("old-token");
    const { clearMcpOAuthForUser } = await import("../src/lib/mcp-oauth");
    clearMcpOAuthForUser("user-a");
    await completeDeletion("user-a", generation);
    expect(getStoredMcpOAuthTokens("user-a")).toBeUndefined();
  });

  it("coalesces concurrent refreshes for the same user into a single token exchange (dashboard parallelization race)", async () => {
    vi.stubEnv("ROBINHOOD_MCP_AUTHORIZATION_URL", "https://auth.example.test/authorize");
    vi.stubEnv("ROBINHOOD_MCP_TOKEN_URL", "https://auth.example.test/token");
    vi.stubEnv("ROBINHOOD_MCP_CLIENT_ID", "client-123");
    let exchangeCount = 0;
    vi.stubGlobal("fetch", async () => {
      exchangeCount += 1;
      // Simulate real network latency so two concurrent getMcpAccessToken calls genuinely overlap
      // instead of resolving serially before the second one starts.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(JSON.stringify({ access_token: `fresh-${exchangeCount}`, token_type: "Bearer" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const { getMcpAccessToken, setMcpOAuthTokens } = await import("../src/lib/mcp-oauth");

    setMcpOAuthTokens("user-a", {
      accessToken: "old-token",
      refreshToken: "refresh-token",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() - 60_000).toISOString()
    });

    // Two "concurrent" callers — e.g. the dashboard's broker chain and its now-parallel Robinhood
    // MCP health check both resolving a token for the same expiring row at once.
    const [tokenA, tokenB] = await Promise.all([getMcpAccessToken("user-a"), getMcpAccessToken("user-a")]);

    expect(exchangeCount).toBe(1); // NOT 2 — a rotating refresh token would invalid_grant the second
    expect(tokenA).toBe("fresh-1");
    expect(tokenB).toBe("fresh-1");

    // A later call after the shared refresh has settled starts its own new exchange, not a stuck one.
    setMcpOAuthTokens("user-a", {
      accessToken: "fresh-1",
      refreshToken: "refresh-token-2",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() - 60_000).toISOString()
    });
    expect(await getMcpAccessToken("user-a")).toBe("fresh-2");
    expect(exchangeCount).toBe(2);
  });

  it("stores the state blob under a per-user key", async () => {
    vi.stubEnv("ROBINHOOD_MCP_AUTHORIZATION_URL", "https://auth.example.test/authorize");
    vi.stubEnv("ROBINHOOD_MCP_TOKEN_URL", "https://auth.example.test/token");
    vi.stubEnv("ROBINHOOD_MCP_CLIENT_ID", "client-123");
    const { buildMcpAuthorizationUrl, findMcpOAuthStateByRandom } = await import("../src/lib/mcp-oauth");

    const urlStr = await buildMcpAuthorizationUrl("user-a");
    const randomPart = new URL(urlStr).searchParams.get("state")!;
    const found = findMcpOAuthStateByRandom(randomPart);

    expect(found).toBeTruthy();
    expect(found!.value.userId).toBe("user-a");
    expect(found!.key).toMatch(/^robinhood_mcp_oauth_state:user-a:/);
  });

  it("treats base64url underscore as data, never as a SQL wildcard", async () => {
    vi.stubEnv("ROBINHOOD_MCP_AUTHORIZATION_URL", "https://auth.example.test/authorize");
    vi.stubEnv("ROBINHOOD_MCP_TOKEN_URL", "https://auth.example.test/token");
    vi.stubEnv("ROBINHOOD_MCP_CLIENT_ID", "client-123");
    const { buildMcpAuthorizationUrl, findMcpOAuthStateByRandom } = await import("../src/lib/mcp-oauth");

    const urlStr = await buildMcpAuthorizationUrl("user-a");
    const state = new URL(urlStr).searchParams.get("state")!;
    const replacementIndex = [...state.slice(0, -1)].findIndex((character) => character !== "_");
    expect(replacementIndex).toBeGreaterThanOrEqual(0);
    const wildcardLookalike = `${state.slice(0, replacementIndex)}_${state.slice(replacementIndex + 1)}`;

    expect(wildcardLookalike).not.toBe(state);
    expect(findMcpOAuthStateByRandom(wildcardLookalike)).toBeUndefined();
    expect(findMcpOAuthStateByRandom(`%${state.slice(1)}`)).toBeUndefined();
    expect(findMcpOAuthStateByRandom(state)?.value.userId).toBe("user-a");
  });

  it("atomically consumes state so concurrent callbacks exchange only one code", async () => {
    vi.stubEnv("ROBINHOOD_MCP_AUTHORIZATION_URL", "https://auth.example.test/authorize");
    vi.stubEnv("ROBINHOOD_MCP_TOKEN_URL", "https://auth.example.test/token");
    vi.stubEnv("ROBINHOOD_MCP_CLIENT_ID", "client-123");
    let exchanges = 0;
    vi.stubGlobal("fetch", async () => {
      exchanges += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(JSON.stringify({ access_token: "once", token_type: "Bearer" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const { buildMcpAuthorizationUrl, completeMcpOAuthCallback, getStoredMcpOAuthTokens } = await import("../src/lib/mcp-oauth");
    const state = new URL(await buildMcpAuthorizationUrl("user-a")).searchParams.get("state")!;

    const results = await Promise.allSettled([
      completeMcpOAuthCallback({ code: "code-a", state }),
      completeMcpOAuthCallback({ code: "code-b", state })
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(exchanges).toBe(1);
    expect(getStoredMcpOAuthTokens("user-a")?.accessToken).toBe("once");
  });

  it("isolates tokens per user — user-b cannot read user-a token", async () => {
    vi.stubEnv("ROBINHOOD_MCP_AUTHORIZATION_URL", "https://auth.example.test/authorize");
    vi.stubEnv("ROBINHOOD_MCP_TOKEN_URL", "https://auth.example.test/token");
    vi.stubEnv("ROBINHOOD_MCP_CLIENT_ID", "client-123");
    const { setMcpOAuthTokens, getMcpAccessToken } = await import("../src/lib/mcp-oauth");

    setMcpOAuthTokens("user-a", { accessToken: "tok-a", tokenType: "Bearer" });

    // user-b has no token stored
    const tokenB = await getMcpAccessToken("user-b");
    expect(tokenB).toBeUndefined();

    // user-a gets their own token
    const tokenA = await getMcpAccessToken("user-a");
    expect(tokenA).toBe("tok-a");
  });

  it("never reads the env override directly; the boot migration seeds local's token, tenants get none", async () => {
    vi.stubEnv("ROBINHOOD_MCP_AUTH_TOKEN", "operator-token");
    const { getMcpAccessToken, migrateLocalRobinhoodToken } = await import("../src/lib/mcp-oauth");

    // No env special-case in resolution: before migration even `local` has no token.
    expect(await getMcpAccessToken("local")).toBeUndefined();
    // The boot migration moves the legacy env override into local's stored OAuth token.
    expect(migrateLocalRobinhoodToken()).toBe(true);
    expect(await getMcpAccessToken("local")).toBe("operator-token");
    // A tenant never resolves the operator's token.
    expect(await getMcpAccessToken("user-b")).toBeUndefined();
  });

  it("never re-seeds the legacy env token after deletion is prepared or completed", async () => {
    vi.stubEnv("ROBINHOOD_MCP_AUTH_TOKEN", "operator-token");
    const { getMcpAccessToken, migrateLocalRobinhoodToken } = await import("../src/lib/mcp-oauth");
    const generation = await prepareDeletion("local");

    expect(migrateLocalRobinhoodToken()).toBe(false);
    expect(await getMcpAccessToken("local")).toBeUndefined();

    await completeDeletion("local", generation);
    expect(migrateLocalRobinhoodToken()).toBe(false);
    expect(await getMcpAccessToken("local")).toBeUndefined();
  });

  it("clears only the calling user token on disconnect", async () => {
    const { setMcpOAuthTokens, clearMcpOAuthTokens, getMcpAccessToken } = await import("../src/lib/mcp-oauth");

    setMcpOAuthTokens("user-a", { accessToken: "tok-a", tokenType: "Bearer" });
    setMcpOAuthTokens("user-b", { accessToken: "tok-b", tokenType: "Bearer" });

    clearMcpOAuthTokens("user-a");

    expect(await getMcpAccessToken("user-a")).toBeUndefined();
    expect(await getMcpAccessToken("user-b")).toBe("tok-b");
  });

  it("normalizes token responses and preserves refresh tokens on refresh", async () => {
    const { tokenResponseToTokens } = await import("../src/lib/mcp-oauth");

    const initial = tokenResponseToTokens({ access_token: "one", refresh_token: "refresh", expires_in: 3600, token_type: "Bearer" });
    const refreshed = tokenResponseToTokens({ access_token: "two", expires_in: 3600, token_type: "Bearer" }, initial);

    expect(initial.refreshToken).toBe("refresh");
    expect(refreshed.accessToken).toBe("two");
    expect(refreshed.refreshToken).toBe("refresh");
    expect(refreshed.expiresAt).toBeTruthy();
  });

  it("re-registers client dynamically if redirectUri changes", async () => {
    vi.stubEnv("ROBINHOOD_MCP_AUTHORIZATION_URL", "https://auth.example.test/authorize");
    vi.stubEnv("ROBINHOOD_MCP_TOKEN_URL", "https://auth.example.test/token");
    vi.stubEnv("ROBINHOOD_MCP_CLIENT_REGISTRATION_URL", "https://auth.example.test/register");

    const { buildMcpAuthorizationUrl } = await import("../src/lib/mcp-oauth");

    // Mock global fetch for dynamic client registration
    let fetchCallCount = 0;
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockImplementation(async (url, options) => {
      if (url === "https://auth.example.test/register") {
        fetchCallCount++;
        return {
          ok: true,
          json: async () => ({
            client_id: `dynamic-client-${fetchCallCount}`,
            client_secret: "secret",
            token_endpoint_auth_method: "client_secret_post"
          })
        };
      }
      return originalFetch(url, options);
    });

    try {
      // First, register with redirectUri 1
      vi.stubEnv("ROBINHOOD_MCP_REDIRECT_URI", "http://localhost:3000/callback-1");
      const url1 = new URL(await buildMcpAuthorizationUrl("user-a"));
      expect(url1.searchParams.get("client_id")).toBe("dynamic-client-1");
      expect(url1.searchParams.get("redirect_uri")).toBe("http://localhost:3000/callback-1");
      expect(fetchCallCount).toBe(1);

      // Now build again with the SAME redirectUri, should reuse the cached client without fetching again
      const url1Reuse = new URL(await buildMcpAuthorizationUrl("user-a"));
      expect(url1Reuse.searchParams.get("client_id")).toBe("dynamic-client-1");
      expect(fetchCallCount).toBe(1);

      // Now change the redirectUri, should trigger a new registration
      vi.stubEnv("ROBINHOOD_MCP_REDIRECT_URI", "http://localhost:3000/callback-2");
      const url2 = new URL(await buildMcpAuthorizationUrl("user-a"));
      expect(url2.searchParams.get("client_id")).toBe("dynamic-client-2");
      expect(url2.searchParams.get("redirect_uri")).toBe("http://localhost:3000/callback-2");
      expect(fetchCallCount).toBe(2);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
