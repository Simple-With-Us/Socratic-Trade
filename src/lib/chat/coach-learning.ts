// Coach/chat → durable learning.
//
// When the owner uses console chat/coach to state a strategy directive in plain English
// ("I want the system to…", "prefer…", "avoid…", "from now on…") or pastes a useful article URL,
// capture that into durable learning instead of leaving it as ephemeral chat transcript.
//
// Safety:
//   - Explicit strategy directives queue as strategy-directive pending (human approval required
//     before they touch the strategy prompt). Origin "ingest" + source "owner-coach".
//   - Milder preferences route through ingestLearned(origin "ingest") so risk-tier can queue and
//     fact-tier can write; chat hard-cap is intentionally NOT used here so approval is possible.
//   - URL fetch is SSRF-safe: https only, public hosts, DNS-resolved private-IP reject, timeout,
//     size cap, no credentialed URLs.
//   - Fetched page text is containment-scanned AT INGEST (containPromptText, source "web"). A page
//     carrying an instruction-hijack idiom is dropped + audited, never written as durable learning:
//     the downstream risk classifier only knows financial-risk vocabulary, and the prompt-assembly
//     scan fires too late to keep a poisoned row out of the store.
//   - Never places orders or mutates numeric policy.

import { randomUUID } from "crypto";
import { lookup } from "dns/promises";
import { isIP } from "net";
import {
  audit,
  insertPendingLearnedContext
} from "../db";
import { hasPii } from "../learned-context/classify";
import { ingestLearned, type IngestLearnedOptions } from "../learned-context/store";
import { containPromptText } from "../prompt-safety";
import type { LearnedContextPendingRow } from "../types";
import { emitDashboardEvent } from "../events";
import { runWithUserWriteEpoch, type UserWriteEpoch } from "../user-write-fence";

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/gi;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 256_000;
const MAX_SUMMARY_CHARS = 480;

/** Strong directive cues — these become strategy-directive pending rows (approval required). */
const STRONG_DIRECTIVE_RE =
  /\b(?:i want the system to|from now on|going forward|the system should|please (?:always|never|remember)|make sure (?:we|you|the system)|remember to)\b/i;

/** Milder preference / avoidance language still worth capturing as coach learning. */
const MILD_DIRECTIVE_RE =
  /\b(?:prefer|avoid|do not|don't|never trade|always use|always prefer|always avoid|stop buying|start favoring)\b/i;

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata",
  "0.0.0.0"
]);

export type CoachLearningKind = "directive" | "url";

export interface CoachLearningDetection {
  kind: CoachLearningKind;
  /** For directives: the instruction text. For urls: first public https URL. */
  text: string;
  urls: string[];
  strong: boolean;
}

export interface CoachLearningCaptureResult {
  detected: boolean;
  kind: CoachLearningKind | null;
  /** Human-readable receipt for the chat reply. */
  receipt: string | null;
  writtenId: string | null;
  pendingId: string | null;
  tier: "fact" | "risk" | "strategy-directive" | null;
  dropped: string | null;
  url?: string;
  error?: string;
}

export interface CaptureCoachLearningArgs {
  userId: string;
  message: string;
  writeEpoch?: UserWriteEpoch;
  connectedAccountId?: string | null;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Skip vector index (tests / offline). Default true for optional path. */
  indexVectors?: boolean;
}

/**
 * Detect whether a chat message is a coach learning signal: an explicit strategy directive
 * and/or a message that pastes one or more http(s) URLs. When both are present, kind prefers
 * "directive" if a strong/mild cue matches, else "url" — `captureCoachLearning` still processes
 * both signals when both fire.
 */
export function detectCoachLearningIntent(message: string): CoachLearningDetection | null {
  const text = String(message ?? "").trim();
  if (!text) return null;

  const urls = extractUrls(text);
  const strong = STRONG_DIRECTIVE_RE.test(text);
  const mild = MILD_DIRECTIVE_RE.test(text);
  // Avoid capturing pure questions that only happen to include "prefer" casually.
  const directiveOk = (strong || mild) && !(!strong && /\?$/.test(text) && text.length < 80);

  if (directiveOk) {
    return { kind: "directive", text, urls, strong };
  }
  if (urls.length > 0) {
    return { kind: "url", text, urls, strong: false };
  }
  return null;
}

/** Extract raw URL strings from free text (trailing punctuation stripped). */
export function extractUrls(message: string): string[] {
  const found = String(message).match(URL_RE) ?? [];
  const cleaned = found.map((raw) => raw.replace(/[.,;:!?)]+$/, ""));
  return [...new Set(cleaned)];
}

/**
 * SSRF gate for a candidate URL. Returns a normalized https URL string on success, or an error
 * reason string on reject. Public hosts only; https only; no credentials; no private IPs
 * (literal or DNS-resolved).
 */
export async function assertPublicHttpsUrl(rawUrl: string): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "https_only" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "credentials_not_allowed" };
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || BLOCKED_HOSTNAMES.has(host)) {
    return { ok: false, reason: "blocked_host" };
  }
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) {
    return { ok: false, reason: "blocked_host" };
  }
  // Literal IP host
  if (isIP(host)) {
    if (isPrivateOrReservedIp(host)) return { ok: false, reason: "private_ip" };
  } else {
    // DNS resolve and reject private answers (basic SSRF protection; DNS rebinding residual accepted).
    try {
      const records = await lookup(host, { all: true, verbatim: true });
      if (records.length === 0) return { ok: false, reason: "dns_empty" };
      for (const rec of records) {
        if (isPrivateOrReservedIp(rec.address)) {
          return { ok: false, reason: "private_ip" };
        }
      }
    } catch {
      return { ok: false, reason: "dns_failed" };
    }
  }
  return { ok: true, url: parsed.toString() };
}

/** True for private, loopback, link-local, CGNAT, and other non-public addresses. */
export function isPrivateOrReservedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const parts = ip.split(".").map((p) => Number(p));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return true;
    const [a, b] = parts as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
    if (lower.startsWith("fe80")) return true; // link-local
    // IPv4-mapped
    if (lower.startsWith("::ffff:")) {
      const mapped = lower.slice("::ffff:".length);
      if (isIP(mapped) === 4) return isPrivateOrReservedIp(mapped);
    }
    return false;
  }
  return true;
}

/**
 * Fetch a public https URL with timeout + size cap. Returns plain-ish text (HTML stripped lightly).
 */
export async function fetchPublicHttpsText(
  rawUrl: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {}
): Promise<{ ok: true; url: string; text: string; contentType: string | null } | { ok: false; reason: string; url?: string }> {
  const gate = await assertPublicHttpsUrl(rawUrl);
  if (!gate.ok) return { ok: false, reason: gate.reason };

  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_BODY_BYTES;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(gate.url, {
      method: "GET",
      redirect: "error", // do not follow redirects (redirect-to-private SSRF class)
      signal: controller.signal,
      headers: {
        Accept: "text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.1",
        "User-Agent": "SocraticTrade-CoachLearning/1.0 (research; +https://socratictrade.com)"
      },
      cache: "no-store"
    });
    if (!res.ok) return { ok: false, reason: `http_${res.status}`, url: gate.url };
    const contentType = res.headers.get("content-type");
    // Soft reject non-text types when declared.
    if (contentType && !/text\/|json|xml|html|markdown|javascript/i.test(contentType)) {
      return { ok: false, reason: "unsupported_content_type", url: gate.url };
    }
    const buf = await readBodyCapped(res, maxBytes);
    if (!buf.ok) return { ok: false, reason: buf.reason, url: gate.url };
    const text = stripHtmlToText(buf.text);
    if (!text.trim()) return { ok: false, reason: "empty_body", url: gate.url };
    return { ok: true, url: gate.url, text, contentType };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/abort/i.test(msg)) return { ok: false, reason: "timeout", url: gate.url };
    return { ok: false, reason: "fetch_failed", url: gate.url };
  } finally {
    clearTimeout(timer);
  }
}

async function readBodyCapped(
  res: Response,
  maxBytes: number
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  // Prefer streaming when available so we never buffer an unbounded body.
  const body = res.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > maxBytes) {
            try {
              await reader.cancel();
            } catch {
              /* ignore */
            }
            return { ok: false, reason: "body_too_large" };
          }
          chunks.push(value);
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    return { ok: true, text: new TextDecoder("utf-8", { fatal: false }).decode(merged) };
  }
  const text = await res.text();
  if (text.length > maxBytes) return { ok: false, reason: "body_too_large" };
  return { ok: true, text };
}

/** Lightweight HTML → text (title + body-ish content). No DOM dependency. */
export function stripHtmlToText(html: string): string {
  let s = String(html);
  const title = (s.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim();
  s = s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|h[1-6]|li|br|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  if (title && !s.toLowerCase().startsWith(title.toLowerCase())) {
    return `${title}\n\n${s}`;
  }
  return s;
}

/** Compress fetched article text into a short durable lesson string. */
export function summarizeArticleText(text: string, sourceUrl: string, maxChars: number = MAX_SUMMARY_CHARS): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const slice = cleaned.length > maxChars ? `${cleaned.slice(0, maxChars - 1).trimEnd()}…` : cleaned;
  return `Lesson from ${sourceUrl}: ${slice}`;
}

/**
 * Capture coach/chat learning from a single user message. Safe to call on every turn — no-ops when
 * the message is not a directive or URL paste. When both a directive and a URL appear, both are
 * captured; the primary receipt/kind reflects the directive (higher intent) with URL receipt appended.
 */
export async function captureCoachLearning(args: CaptureCoachLearningArgs): Promise<CoachLearningCaptureResult> {
  const detection = detectCoachLearningIntent(args.message);
  if (!detection) {
    return { detected: false, kind: null, receipt: null, writtenId: null, pendingId: null, tier: null, dropped: null };
  }

  const parts: CoachLearningCaptureResult[] = [];
  if (detection.kind === "directive") {
    parts.push(await captureDirective(args, detection));
  }
  if (detection.urls.length > 0) {
    parts.push(await captureUrlLesson(args, { ...detection, kind: "url" }));
  }

  if (parts.length === 0) {
    return { detected: false, kind: null, receipt: null, writtenId: null, pendingId: null, tier: null, dropped: null };
  }
  if (parts.length === 1) return parts[0]!;

  // Merge: prefer directive as primary kind; concatenate honest receipts.
  const primary = parts[0]!;
  const receipts = parts.map((p) => p.receipt).filter((r): r is string => Boolean(r));
  return {
    detected: true,
    kind: primary.kind,
    receipt: receipts.length > 0 ? receipts.join(" ") : null,
    writtenId: parts.map((p) => p.writtenId).find(Boolean) ?? null,
    pendingId: parts.map((p) => p.pendingId).find(Boolean) ?? null,
    tier: primary.tier ?? parts[1]?.tier ?? null,
    dropped: primary.dropped,
    url: parts.map((p) => p.url).find(Boolean),
    error: parts.map((p) => p.error).find(Boolean)
  };
}

async function captureDirective(
  args: CaptureCoachLearningArgs,
  detection: CoachLearningDetection
): Promise<CoachLearningCaptureResult> {
  const value = detection.text.slice(0, 500);
  if (hasPii(value)) {
    if (args.writeEpoch) {
      runWithUserWriteEpoch(args.userId, args.writeEpoch, () => {
        audit("learned_context.drop", { userId: args.userId, origin: "ingest", reason: "pii", source: "owner-coach" }, args.userId);
      });
    }
    return {
      detected: true,
      kind: "directive",
      receipt: null,
      writtenId: null,
      pendingId: null,
      tier: null,
      dropped: "pii"
    };
  }

  // Strong directives always go to the strategy-directive approval queue — never silent write.
  if (detection.strong) {
    const pending = queueStrategyDirective({
      userId: args.userId,
      value,
      writeEpoch: args.writeEpoch,
      connectedAccountId: args.connectedAccountId ?? null
    });
    return {
      detected: true,
      kind: "directive",
      receipt:
        "Captured your strategy directive for durable learning. It is queued for your approval before it can change the strategy prompt (Approvals → Learned context).",
      writtenId: null,
      pendingId: pending.id,
      tier: "strategy-directive",
      dropped: null
    };
  }

  // Mild preferences: classify + route via ingestLearned (origin ingest so risk can queue).
  const opts: IngestLearnedOptions = {
    writeEpoch: args.writeEpoch,
    learningScope: "portfolio"
  };
  const result = await ingestLearned(
    args.userId,
    {
      kind: "decision",
      subject: "coach-directive",
      value,
      source: "owner-coach",
      confidence: 0.85,
      intent: value.toLowerCase()
    },
    "ingest",
    opts
  );

  if (result.pending) {
    return {
      detected: true,
      kind: "directive",
      receipt:
        "Captured your preference for durable learning. It was classified as risk-adjacent and is queued for your approval before it can influence trading behavior (Approvals → Learned context).",
      writtenId: null,
      pendingId: result.pendingId,
      tier: result.tier,
      dropped: null
    };
  }
  if (result.written) {
    return {
      detected: true,
      kind: "directive",
      receipt: "Captured your preference as durable learned context (fact tier). Future strategy runs can surface it as advisory context.",
      writtenId: result.written.id,
      pendingId: null,
      tier: "fact",
      dropped: null
    };
  }
  return {
    detected: true,
    kind: "directive",
    receipt: null,
    writtenId: null,
    pendingId: null,
    tier: result.tier,
    dropped: result.dropped
  };
}

function queueStrategyDirective(input: {
  userId: string;
  value: string;
  writeEpoch?: UserWriteEpoch;
  connectedAccountId: string | null;
}): LearnedContextPendingRow {
  const pending: LearnedContextPendingRow = {
    id: randomUUID(),
    userId: input.userId,
    scope: "private",
    kind: "decision",
    subject: "coach-strategy-directive",
    symbol: null,
    value: input.value,
    source: "owner-coach",
    origin: "ingest",
    riskTier: "strategy-directive",
    connectedAccountId: input.connectedAccountId,
    accountEnvironment: null,
    learningScope: "portfolio",
    transferState: "not_applicable",
    classifierReason: "coach chat: strong strategy directive; queued for human confirmation",
    createdAt: new Date().toISOString(),
    status: "pending",
    resolvedAt: null
  };
  const write = () => {
    insertPendingLearnedContext(pending);
    audit(
      "learned_context.pending",
      {
        userId: input.userId,
        origin: "ingest",
        source: "owner-coach",
        tier: "strategy-directive",
        pendingId: pending.id,
        subject: pending.subject
      },
      input.userId,
      input.connectedAccountId ?? undefined
    );
    emitDashboardEvent({
      type: "pending-learned-change",
      userId: input.userId,
      at: new Date().toISOString(),
      detail: { pendingId: pending.id }
    });
  };
  if (input.writeEpoch) {
    runWithUserWriteEpoch(input.userId, input.writeEpoch, write);
  } else {
    write();
  }
  return pending;
}

async function captureUrlLesson(
  args: CaptureCoachLearningArgs,
  detection: CoachLearningDetection
): Promise<CoachLearningCaptureResult> {
  // Prefer the first URL that passes the SSRF gate.
  let chosen: string | null = null;
  let lastReject = "no_url";
  for (const candidate of detection.urls) {
    const gate = await assertPublicHttpsUrl(candidate);
    if (gate.ok) {
      chosen = gate.url;
      break;
    }
    lastReject = gate.reason;
  }
  if (!chosen) {
    return {
      detected: true,
      kind: "url",
      receipt: `I noticed a URL but could not fetch it safely (${lastReject.replace(/_/g, " ")}). Only public https URLs are accepted.`,
      writtenId: null,
      pendingId: null,
      tier: null,
      dropped: lastReject,
      error: lastReject
    };
  }

  const fetched = await fetchPublicHttpsText(chosen, { fetchImpl: args.fetchImpl });
  if (!fetched.ok) {
    return {
      detected: true,
      kind: "url",
      receipt: `I could not fetch that URL for durable learning (${fetched.reason.replace(/_/g, " ")}).`,
      writtenId: null,
      pendingId: null,
      tier: null,
      dropped: fetched.reason,
      url: chosen,
      error: fetched.reason
    };
  }

  const lesson = summarizeArticleText(fetched.text, fetched.url);
  if (hasPii(lesson)) {
    return {
      detected: true,
      kind: "url",
      receipt: null,
      writtenId: null,
      pendingId: null,
      tier: null,
      dropped: "pii",
      url: fetched.url
    };
  }

  // TRUST BOUNDARY: this text came off an arbitrary host, and the risk classifier downstream only
  // knows FINANCIAL risk vocabulary — it has no notion of instruction-hijack phrasing. Scan HERE,
  // at ingest, before anything durable is written. The prompt-assembly scan alone is too late: a
  // poisoned row would already be sitting in the store, resurfacing on unrelated future turns.
  // Trigger on an actual instruction-like SPAN, not merely on a non-clean status: a bare length
  // truncation is not an injection and must not produce the "this page tried to instruct you"
  // receipt. (Today the lesson is capped at 480 chars upstream, so truncation cannot fire here at
  // all — this keeps the trigger honest if that cap ever moves.)
  const contained = containPromptText({ source: "web", text: lesson });
  if (contained.quarantinedExcerpts.length > 0) {
    const dropAudit = () =>
      audit(
        "learned_context.drop",
        {
          userId: args.userId,
          origin: "ingest",
          reason: "prompt_injection",
          source: `owner-coach-url:${fetched.url}`,
          status: contained.status,
          patterns: contained.findings.map((finding) => finding.pattern),
          quarantined: contained.quarantinedExcerpts.map((excerpt) => excerpt.excerpt)
        },
        args.userId
      );
    if (args.writeEpoch) {
      runWithUserWriteEpoch(args.userId, args.writeEpoch, dropAudit);
    } else {
      dropAudit();
    }
    return {
      detected: true,
      kind: "url",
      receipt: `I fetched ${fetched.url}, but the page carries instruction-like text aimed at the assistant, so I did not save it as durable learning.  Tell me the lesson in your own words and I will capture that instead.`,
      writtenId: null,
      pendingId: null,
      tier: null,
      dropped: "prompt_injection",
      url: fetched.url
    };
  }

  const result = await ingestLearned(
    args.userId,
    {
      kind: "fact",
      subject: "coach-url-lesson",
      value: lesson.slice(0, 800),
      source: `owner-coach-url:${fetched.url}`,
      confidence: 0.7,
      intent: "article lesson"
    },
    "ingest",
    {
      writeEpoch: args.writeEpoch,
      learningScope: "portfolio"
    }
  );

  // Best-effort lesson vector so episodic retrieval can surface it (fire-and-forget safe).
  if (args.indexVectors !== false && result.written) {
    void indexStandaloneLesson({
      userId: args.userId,
      lesson: lesson.slice(0, 800),
      sourceUrl: fetched.url,
      connectedAccountId: args.connectedAccountId ?? null
    }).catch((err) => {
      console.warn("[coach-learning] lesson vector write failed:", err instanceof Error ? err.message : err);
    });
  }

  if (result.pending) {
    return {
      detected: true,
      kind: "url",
      receipt:
        "Fetched the article and drafted a short lesson, but it was classified as risk-adjacent and is queued for your approval (Approvals → Learned context).",
      writtenId: null,
      pendingId: result.pendingId,
      tier: result.tier,
      dropped: null,
      url: fetched.url
    };
  }
  if (result.written) {
    return {
      detected: true,
      kind: "url",
      receipt: `Captured a short lesson from ${fetched.url} into durable learned context.`,
      writtenId: result.written.id,
      pendingId: null,
      tier: "fact",
      dropped: null,
      url: fetched.url
    };
  }
  return {
    detected: true,
    kind: "url",
    receipt: null,
    writtenId: null,
    pendingId: null,
    tier: result.tier,
    dropped: result.dropped,
    url: fetched.url
  };
}

async function indexStandaloneLesson(input: {
  userId: string;
  lesson: string;
  sourceUrl: string;
  connectedAccountId: string | null;
}): Promise<void> {
  const { storeContexts } = await import("../vector-db");
  const accession = `coach-url:${randomUUID()}`;
  await storeContexts(
    [
      {
        text: [
          "Durable lesson from an owner-shared article (coach chat)",
          `source_url: ${input.sourceUrl}`,
          `lesson: ${input.lesson}`
        ].join("\n"),
        metadata: {
          symbol: "PORTFOLIO",
          source: "owner-coach-url",
          timestamp: new Date().toISOString(),
          accession,
          doc_type: "lesson",
          memory_scope: "account",
          url: input.sourceUrl,
          ...(input.connectedAccountId ? { connected_account_id: input.connectedAccountId } : {})
        }
      }
    ],
    input.userId,
    { dedupKeyPrefix: "lesson", scope: "private" }
  );
}
