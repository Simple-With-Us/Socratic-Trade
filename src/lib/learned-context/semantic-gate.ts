// SECOND LAYER of the learned-context risk classifier (the expert panel's medium-term recommendation:
// a keyword blocklist can be paraphrased around). This adds a SEMANTIC GATE plus a templated-fact
// ALLOWLIST on top of the sync keyword classifier in classify.ts.
//
// ── STRICTLY ADDITIVE — read before touching anything below ──────────────────────────────────────
// The gate may only catch MORE risk. It NEVER lets through something the keyword classifier already
// flags as 'risk' (or 'strategy-directive'), and it NEVER weakens the fail-closed default. Concretely:
//   1. Run the existing sync classifyRiskTier() FIRST. If it returns 'risk' or 'strategy-directive',
//      return that immediately — the keyword layer is AUTHORITATIVE for catching risk; the gate can
//      only ever UPGRADE a keyword 'fact' → 'risk', never DOWNGRADE a keyword 'risk' → 'fact'.
//   2. Keyword 'fact' that matches a KNOWN-SAFE structural template (index membership, sole/primary
//      supplier/customer, sector classification, earnings-date, identity facts) is DEFINITIVELY 'fact'
//      → return 'fact' WITHOUT calling the LLM (cheap + deterministic + no spend on obvious facts).
//   3. Otherwise (keyword 'fact', not allowlisted) call the LLM gate. If it says 'risk', UPGRADE to
//      'risk' (so the ingest path routes it to the pending queue). If it says 'fact', keep 'fact'.
//   4. FAIL-SAFE: if the LLM is unavailable / errors / times out / returns unparseable output, FALL
//      BACK to the keyword result (which on this path is 'fact'). The gate must NEVER block all fact
//      ingestion when the LLM is down, and must NEVER silently downgrade a keyword 'risk'. It degrades
//      to today's behavior (keyword + allowlist).
//   5. FLAG: env LEARNED_CONTEXT_SEMANTIC_GATE (default "on"; any value !== "off" = on). When "off",
//      skip the LLM gate entirely → exactly today's behavior plus the (safe) allowlist.
//   6. HONESTY: when no chat credential resolves for the user, getLLM hands back MockLLM and this
//      "on by default" second layer silently does not run at all. That is audited
//      ("semantic_gate_mock_llm_fallback", deduped — it is a standing condition, not a per-candidate
//      event) rather than inferred. It is a receipt, not a gate — the tier still degrades to the
//      keyword result and ingestion is never blocked.
//
// The chat-origin HARD-CAP is enforced in store.ts, not here: a chat candidate the gate upgrades to
// 'risk' is still DROPPED (never queued). This module only decides the tier; routing stays in the store.
//
// ── PROVENANCE BYPASS (step 1b, 2026-09-27) ─────────────────────────────────────────────────────
// One narrow case sits between the keyword layer and the LLM call: a candidate the producer has
// stamped `provenance: "system-postmortem"`. That text is a statement the app derived from its OWN
// already-closed, already-measured trade outcomes, so the gate's question ("would this influence
// position sizing … or trading behavior?") is not a meaningful test of it — a post-mortem lesson
// about sizing will answer "yes" by construction and be parked in the human queue forever. Those
// rows skip the LLM LAYER only. The keyword layer above still runs and is still authoritative, so a
// lesson naming a risk knob is still routed to the confirmation queue. See step 1b for the full
// list of things this does not do.

import type { ChatLLM } from "../chat/types";
import { getLLM, MockLLM } from "../chat/llm";
import { auditDeduped } from "../audit-dedupe";
import type { LearnedContextCandidate, LearnedContextRiskTier } from "../types";
import { classifyRiskTier } from "./classify";

export interface SemanticGateOptions {
  /** Injectable LLM for offline/unit testing. Defaults to getLLM(userId) (MockLLM when no key). */
  llm?: ChatLLM;
  /** The requesting user — threaded to getLLM so the gate's LLM call is per-user keyed + usage-attributed. */
  userId?: string;
}

/** Flag: the LLM gate is ON unless the env var is explicitly "off". Any other value (incl. unset) = on. */
export function semanticGateEnabled(): boolean {
  return process.env.LEARNED_CONTEXT_SEMANTIC_GATE !== "off";
}

/**
 * TEMPLATED-FACT ALLOWLIST: known-safe STRUCTURAL fact shapes that are DEFINITIVELY non-risk and must
 * never spend an LLM call. These describe identity / classification / relationships / scheduled events —
 * none of which touch position sizing, exposure, leverage, stops, or risk tolerance. Matching is on the
 * lowercased full text (subject + value + intent). Each template is a tight regex anchored on a
 * structural cue, not a loose keyword, so risk-adjacent prose cannot ride in on a benign substring.
 */
const TEMPLATED_FACT_PATTERNS: readonly RegExp[] = [
  // Index membership: "is in the S&P 500", "is a member of the Nasdaq 100", "added to the Dow".
  /\b(?:is\s+(?:in|a\s+member\s+of|part\s+of|a\s+constituent\s+of)|member\s+of|constituent\s+of|added\s+to|included\s+in|listed\s+(?:in|on))\b[^.]{0,40}\b(?:s&p|s\s*and\s*p|sp)\s*\d{2,4}\b/i,
  /\b(?:is\s+(?:in|a\s+member\s+of|part\s+of|a\s+constituent\s+of)|member\s+of|constituent\s+of|added\s+to|included\s+in|listed\s+(?:in|on))\b[^.]{0,40}\bnasdaq[\s-]*\d{2,4}\b/i,
  /\b(?:is\s+(?:in|a\s+member\s+of|part\s+of|a\s+constituent\s+of)|member\s+of|constituent\s+of|added\s+to|included\s+in|listed\s+(?:in|on))\b[^.]{0,40}\b(?:dow(?:\s+jones)?|russell\s*\d{3,4}|ftse\s*\d{2,4})\b/i,
  // Sole / only / primary supplier OR customer relationship.
  /\bis\s+the\s+(?:sole|only|primary|main|largest|dominant|leading|exclusive)\s+(?:euv\s+)?(?:supplier|vendor|provider|manufacturer|producer|customer|buyer|distributor)\b/i,
  // Sector / industry classification.
  /\bis\s+(?:a|an|in|classified\s+as|part\s+of)\s+(?:the\s+)?[a-z\s/&-]{0,30}\b(?:sector|industry|gics\b)/i,
  /\b(?:sector|industry)\s*[:=]\s*[a-z]/i,
  // Earnings / report DATE statements (a scheduled-event fact, not a sizing knob).
  /\b(?:reports?|reporting|announces?|releases?)\s+(?:its\s+)?(?:q[1-4]\s+)?earnings\b/i,
  /\bearnings\s+(?:date|call|report)\b[^.]{0,30}\b(?:on|is|scheduled)\b/i,
  // Identity facts: HQ, ticker symbol, CUSIP, ISIN.
  /\b(?:is\s+)?headquartered\s+in\b/i,
  /\b(?:hq|headquarters)\s+(?:is\s+)?(?:in|located)\b/i,
  /\btrades?\s+under\s+(?:the\s+)?ticker\b/i,
  /\bticker\s+(?:symbol\s+)?(?:is\s+)?[:=]?\s*[a-z.]{1,6}\b/i,
  /\bcusip\b\s*[:=]?\s*[0-9a-z]{6,9}\b/i,
  /\bisin\b\s*[:=]?\s*[a-z]{2}[0-9a-z]{9,10}\b/i
];

/** True if the candidate matches a known-safe templated-fact shape (allowlist). */
export function matchesTemplatedFact(candidate: LearnedContextCandidate): boolean {
  const subject = String(candidate.subject ?? "").toLowerCase();
  const value = String(candidate.value ?? "").toLowerCase();
  const intent = String(candidate.intent ?? "").toLowerCase();
  const haystack = `${subject} ${value} ${intent}`;
  return TEMPLATED_FACT_PATTERNS.some((re) => re.test(haystack));
}

const GATE_SYSTEM_PROMPT =
  "You are a risk gate for an autonomous trading agent. You are given a single learned observation. " +
  "Decide whether it touches RISK — i.e. whether it would influence position sizing, exposure, " +
  "leverage, stops, risk tolerance, concentration, or trading behavior — as opposed to being a neutral " +
  "factual observation about a company or market structure. Be strict: anything risk-adjacent is 'risk'. " +
  'Respond with ONLY a JSON object, no prose: {"tier":"fact"} or {"tier":"risk"}.';

/** Parse the LLM's reply into a tier. Returns null if the text is missing/unparseable (→ fail-safe). */
function parseGateTier(text: string): "fact" | "risk" | null {
  if (!text) return null;
  // Prefer a strict JSON object anywhere in the reply; tolerate surrounding prose.
  const match = text.match(/\{[^{}]*"tier"\s*:\s*"(fact|risk)"[^{}]*\}/i);
  if (match && match[1]) {
    const tier = match[1].toLowerCase();
    return tier === "risk" ? "risk" : "fact";
  }
  return null;
}

/**
 * The async second-layer classifier used by the ingest path. Returns 'fact' | 'risk' |
 * 'strategy-directive'. STRICTLY ADDITIVE — see the file header for the full contract.
 *
 * Order: keyword (authoritative for risk) → provenance bypass (system-postmortem: skip the LLM)
 * → allowlist (definitive fact, no LLM) → LLM gate (may upgrade fact→risk) → fail-safe to the
 * keyword result on any LLM failure or when the flag is off.
 */
export async function classifyWithSemanticGate(
  candidate: LearnedContextCandidate,
  opts: SemanticGateOptions = {}
): Promise<LearnedContextRiskTier> {
  // 1. Keyword layer is authoritative for catching risk. Never override a risk verdict down to fact.
  const keywordTier = classifyRiskTier(candidate);
  if (keywordTier !== "fact") return keywordTier;

  // 1b. EXPLICIT AUTONOMOUS PROVENANCE (2026-09-27). A candidate stamped `provenance:
  // "system-postmortem"` was derived by this app from its OWN already-measured, already-closed trade
  // outcomes. GATE_SYSTEM_PROMPT then asks a model whether the text "would influence … trading
  // behavior" — and the answer for "size down after failed breakouts" is yes, every time, which is
  // why the app's own post-mortem lessons were being upgraded fact→risk and parked in
  // learned_context_pending instead of the brain they are read from. The system observing its own
  // losses is not a claim about how it *should* trade; asking a model to grade it is a category
  // error, and the queue it lands in is read by nobody until a human clicks or a nightly LLM pass
  // runs. So the LLM LAYER is skipped here.
  //
  // WHAT THIS DOES NOT DO — read before widening it:
  //   - It does NOT bypass the keyword layer. Step 1 already ran, so a lesson that names a risk knob
  //     ("raise max position", "double down", "30% of the book") is still 'risk' and still routes to
  //     the human confirmation queue. Only gate-upgrades are skipped, never gate-substitutions.
  //   - It does NOT touch the PII gate (store.ts, earlier) or the chat hard-cap.
  //   - It does NOT change the ingested row's ability to influence anything numeric: a learned
  //     learned_context row is advisory prompt DATA. See the SEMANTIC-channel note in classify.ts.
  //   - It is NOT keyed off `origin`. `origin: "autonomous"` is used by several unrelated producers
  //     (chat-coach ingest, research transfer); keying off it would silently disable the gate for
  //     text this app did not derive from its own outcomes. The marker is per-candidate and opt-in.
  //   It is also strictly cheaper: this is the only path that no longer spends an LLM call per lesson.
  if (candidate.provenance === "system-postmortem") return keywordTier;

  // 2. Templated-fact allowlist: definitively a fact → never call the LLM.
  if (matchesTemplatedFact(candidate)) return "fact";

  // 5 (flag). Gate OFF → today's behavior plus the (safe) allowlist; never call the LLM.
  if (!semanticGateEnabled()) return "fact";

  // 3. LLM semantic gate. May UPGRADE keyword 'fact' → 'risk'; otherwise keeps 'fact'.
  // 4. FAIL-SAFE: any throw / unparseable output falls back to the keyword result ('fact').
  try {
    const llm = opts.llm ?? getLLM(opts.userId);
    // OBSERVABILITY (not a behavior change): getLLM falls back to MockLLM whenever no real chat
    // credential resolves for this user, and a mock's prose reply parses to null → keyword 'fact'.
    // So the second-layer classifier is not merely degraded, it is ABSENT — and, until this audit
    // row existed, absent with no trace. Nothing here fails closed or blocks ingestion; the point
    // is that "the safety net did not run" is now a fact you can look up rather than infer.
    if (!opts.llm && llm instanceof MockLLM) {
      try {
        // Deduped: this is a STANDING condition (no key configured), not a per-candidate event, and
        // one row per ingest is the write-amplification pattern audit-dedupe.ts exists to prevent.
        auditDeduped(
          "semantic_gate_mock_llm_fallback",
          { userId: opts.userId ?? null, subject: candidate.subject ?? null, resolvedModel: llm.modelName },
          [opts.userId ?? "local"],
          { userId: opts.userId }
        );
      } catch {
        // An audit-write failure must never take down classification. Degrade silently.
      }
      return keywordTier;
    }
    const userMessage = JSON.stringify({
      subject: candidate.subject ?? "",
      value: candidate.value ?? "",
      intent: candidate.intent ?? ""
    });
    const result = await llm.run({
      system: GATE_SYSTEM_PROMPT,
      message: userMessage,
      tools: [],
      executeTool: async () => ({ error: "NO_TOOLS" })
    });
    const gateTier = parseGateTier(result?.text ?? "");
    if (gateTier === "risk") return "risk";
    // gateTier === 'fact' (keep) OR null (unparseable → fail-safe to keyword 'fact').
    return "fact";
  } catch {
    // LLM unavailable / threw / timed out → fail-safe to the keyword result ('fact'). Never block.
    return keywordTier;
  }
}
