import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards the invariants that make `main`'s branch protection SOUND, rather than just present.
 *
 * `main` was unprotected until 2026-09-27, and the practical consequence was concrete: a merge
 * driver that read the PR-level `statusCheckRollup` saw "no pending, no failed" on a head whose CI
 * had not been dispatched yet, and would have merged a PR whose full test suite never ran. Branch
 * protection with `verify` + `gitleaks` as required contexts closes that hole at the platform
 * level, but only while the workflows keep producing those checks for every PR. If a future edit
 * breaks any invariant below, protection silently stops gating anything — a docs-only diff would
 * hang forever, or a lane failure would fail open — and the only symptom would be a PR that merges
 * (or never merges) with no obvious cause.
 *
 * These are static guards: they read the workflow YAML as text, exactly like
 * `test/ci-workflow-queue-safety.test.ts`. No network, no token.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function workflow(name: string): string {
  return readFileSync(join(repoRoot, ".github", "workflows", name), "utf8");
}

const ci = workflow("ci.yml");
const security = workflow("security.yml");

/**
 * Body of a top-level `on:` block — everything indented under it.
 *
 * Used only to assert on trigger NAMES and the presence/absence of path filters, never on nested
 * values: this block legitimately contains `push: branches: [main]`, so a bare
 * `expect(...).not.toMatch(/branches:/)` would fire on the push trigger and prove nothing. Use
 * `triggerBlock` when the assertion is about one specific trigger.
 */
function triggersBlock(source: string): string {
  return source.match(/^on:\s*\n((?:^[ \t].*(?:\n|$))*)/m)?.[1] ?? "";
}

/** Just the sub-block for one named trigger, e.g. `pull_request:` inside `on:`. */
function triggerBlock(source: string, trigger: string): string {
  const on = triggersBlock(source);
  const lines = on.split("\n");
  const start = lines.findIndex((l) => l === `  ${trigger}:`);
  if (start < 0) return "";
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    // A sibling trigger KEY (`  merge_group:`) ends the block. Its 2-space indent matches the
    // explanatory `#` comments that live in the same `on:` block, so indentation alone cannot
    // separate them — only the `key:` shape can.
    if (/^ {2}[A-Za-z0-9_-]+:/.test(line)) break;
    body.push(line);
  }
  return body.join("\n");
}

/**
 * Body of a named job block, e.g. `verify:` -> its `needs`/`if`/`steps`/shell script.
 *
 * Deliberately NOT the repo's simpler `^  job:\s*\n((?:^[ \t].*(?:\n|$))*)` pattern: that stops at
 * the first blank line, and a shell `run: |` body inside a job contains blank lines. The captured
 * block was silently truncated mid-script, which made assertions about the gate's logic fail for
 * the wrong reason. Indentation-relative capture is exact: a job body is everything blank or
 * indented deeper than its own 2-space key.
 */
function jobBlock(source: string, job: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => l === `  ${job}:`);
  if (start < 0) return "";
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() && !/^ {3,}/.test(line)) break;
    body.push(line);
  }
  return body.join("\n");
}

/** Drop whole-line YAML comments so assertions never match prose in a `#` note. */
function withoutComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/**
 * Body of the shell `if <cond>; then` block whose condition line is exactly `cond` (after
 * indentation), up to the `fi` at the SAME indentation — nested blocks stay inside. Undefined if
 * the condition is absent.
 */
function ifBody(script: string, cond: string): string | undefined {
  const lines = script.split("\n");
  const start = lines.findIndex((l) => l.trim() === cond);
  if (start < 0) return undefined;
  const indent = lines[start].match(/^\s*/)?.[0] ?? "";
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === `${indent}fi`) return body.join("\n");
    body.push(lines[i]);
  }
  return undefined;
}

/** Last non-blank, non-`fi` statement of a shell snippet, trimmed. */
function lastStatement(script: string): string {
  const lines = script
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l !== "fi");
  return lines[lines.length - 1] ?? "";
}

describe("branch protection is backed by a gate that always reports", () => {
  it("CI has no paths filter on pull_request, so `verify` is created for EVERY diff", () => {
    // THE critical invariant. A `paths:`/`paths-ignore:` filter would mean some diffs never create
    // the `verify` check-run at all. GitHub treats a required check that is expected-but-absent as
    // pending, so every such PR would hang at BLOCKED with no way to tell why. `classify` computes
    // a docs-only *output* instead of filtering the trigger, which is why this is empty.
    // Scoped to the pull_request trigger alone: `push: branches: [main]` legitimately appears in
    // the same `on:` block and asserting on it would prove nothing.
    const pr = triggerBlock(ci, "pull_request");
    expect(pr).not.toBe("");
    expect(pr).not.toMatch(/paths(-ignore)?:/);
    expect(pr).not.toMatch(/branches(-ignore)?:/);
  });

  it("both required-check workflows also trigger on merge_group", () => {
    // Without merge_group the merge queue cannot satisfy the ruleset and queued PRs hang forever
    // — the reason both workflows carry that trigger today.
    for (const source of [ci, security]) {
      expect(triggersBlock(source)).toMatch(/^\s{2}merge_group:\s*$/m);
    }
  });

  it("`verify` is an aggregate over the lanes, not a lane itself", () => {
    const verify = jobBlock(ci, "verify");
    expect(verify).toMatch(/^\s+needs:\s*\[[^\]]*classify[^\]]*\]/m);
    expect(verify).toMatch(/^\s+needs:\s*\[[^\]]*verify-hosted[^\]]*\]/m);
    expect(verify).toMatch(/^\s+needs:\s*\[[^\]]*verify-ios[^\]]*\]/m);
  });
});

describe("the `verify` gate cannot fail open", () => {
  it("does not use always(), which would let a cancelled/failed lane slip through", () => {
    // The workflow's own header records why (PR #370): a skipped required check can fail open, so
    // the aggregate must use `!cancelled()` so a superseded-run cancellation still cancels the
    // gate rather than quietly passing it. Matched against comment-stripped source, because the
    // header explicitly names `always()` while explaining why it is NOT used — asserting on raw
    // text would fail on the very comment that documents the rule.
    const verify = withoutComments(jobBlock(ci, "verify"));
    expect(verify).toMatch(/if: \$\{\{ !cancelled\(\) \}\}/);
    expect(verify).not.toContain("always()");
  });

  it("passes only on enumerated success states and fails otherwise", () => {
    const verify = withoutComments(jobBlock(ci, "verify"));

    // Each assertion is scoped to ONE `if ...; then` body (up to its own `fi`), so an `exit 0` /
    // `exit 1` from a later branch can never satisfy an earlier one (Kody review, PR #4231).
    const classify = ifBody(verify, 'if [ "$CLASSIFY_RESULT" != "success" ]; then');
    const docsOnly = ifBody(verify, 'if [ "$DOCS_ONLY" = "true" ]; then');
    const redundant = ifBody(verify, 'if [ "$REDUNDANT" = "true" ]; then');
    const hosted = ifBody(verify, 'if [ "$HOSTED_RESULT" != "success" ]; then');
    const iosRequired = ifBody(verify, 'if [ "${IOS_CHANGED:-}" = "true" ]; then');
    const iosRequiredOk = ifBody(iosRequired ?? "", 'if [ "$IOS_RESULT" = "success" ]; then');
    const iosOptional = ifBody(verify, 'if [ "$IOS_RESULT" = "skipped" ] || [ "$IOS_RESULT" = "success" ]; then');

    // FAIL branches: classify failure and a non-green hosted lane exit 1 and never exit 0.
    for (const body of [classify, hosted]) {
      expect(body).toBeDefined();
      expect(lastStatement(body!)).toBe("exit 1");
      expect(body).not.toMatch(/exit 0/);
    }
    // PASS fast paths: docs-only and the hourly backstop exit 0 and never exit 1.
    for (const body of [docsOnly, redundant]) {
      expect(body).toBeDefined();
      expect(lastStatement(body!)).toBe("exit 0");
      expect(body).not.toMatch(/exit 1/);
    }
    // iOS required (IOS_CHANGED=true): PASS only inside the IOS_RESULT=success sub-branch;
    // anything else falls through to the branch's own trailing `exit 1`.
    expect(iosRequired).toBeDefined();
    expect(iosRequiredOk).toBeDefined();
    expect(lastStatement(iosRequiredOk!)).toBe("exit 0");
    expect(iosRequiredOk).not.toMatch(/exit 1/);
    expect(lastStatement(iosRequired!)).toBe("exit 1");
    // iOS not required: a skipped or successful lane passes; nothing else in that branch fails.
    expect(iosOptional).toBeDefined();
    expect(lastStatement(iosOptional!)).toBe("exit 0");
    expect(iosOptional).not.toMatch(/exit 1/);

    // Order matters: classify -> docs-only -> backstop -> hosted -> iOS required -> iOS optional,
    // and anything that falls past the last enumerated PASS state is a FAIL.
    const order = [
      'if [ "$CLASSIFY_RESULT" != "success" ]; then',
      'if [ "$DOCS_ONLY" = "true" ]; then',
      'if [ "$REDUNDANT" = "true" ]; then',
      'if [ "$HOSTED_RESULT" != "success" ]; then',
      'if [ "${IOS_CHANGED:-}" = "true" ]; then',
      'if [ "$IOS_RESULT" = "skipped" ] || [ "$IOS_RESULT" = "success" ]; then',
    ].map((cond) => verify.indexOf(cond));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(lastStatement(verify)).toBe("exit 1");
  });

  it("keeps `set -euo pipefail` so an unset variable cannot quietly pass the gate", () => {
    expect(jobBlock(ci, "verify")).toMatch(/set -euo pipefail/);
  });
});

describe("required contexts are not renamed out from under the ruleset", () => {
  it("still defines a `verify` job in ci.yml and a `gitleaks` job in security.yml", () => {
    // These two strings are the required contexts configured on main's protection. Renaming either
    // job would make every PR BLOCKED forever against a check that can never report — a fleet-wide
    // wedge that looks like nothing at all in CI logs.
    expect(ci).toMatch(/^  verify:\s*$/m);
    expect(security).toMatch(/^  gitleaks:\s*$/m);
  });

  it("gitleaks is not skipped on any pull_request path", () => {
    // `gitleaks` is a required context. If its only job ever skips, the required check never
    // reports success and every PR blocks. It must run on pull_request with no path filter.
    const triggers = triggersBlock(security);
    expect(triggers).toMatch(/^\s{2}pull_request:\s*$/m);
    expect(triggers).not.toMatch(/^\s+paths(-ignore)?:/m);
  });

  it("the do-not-automerge hold still works, so protection does not remove the owner's brake", () => {
    // `disable-on-hold` is the escape hatch: applying the `do-not-automerge` label turns merging
    // off. Branch protection is a floor, not a replacement for it.
    const auto = workflow("auto-merge-prs.yml");
    expect(auto).toMatch(/^  disable-on-hold:\s*$/m);
    expect(auto).toContain("do-not-automerge");
  });

  it("auto-merge skips CODEOWNERS trading paths so money-path PRs need a human merge", () => {
    const auto = workflow("auto-merge-prs.yml");
    expect(auto).toMatch(/^  classify-protected:\s*$/m);
    expect(auto).toMatch(/^  disable-on-protected:\s*$/m);
    expect(auto).toMatch(/^  disable-on-skip-automerge:\s*$/m);
    expect(auto).toContain("pr-touches-codeowners-paths.sh");
    expect(auto).toMatch(/skip_automerge != 'true'/);
    expect(auto).toMatch(/contents\/\.github\/CODEOWNERS\?ref=\$BASE/);
    expect(auto).toMatch(/compare\/\$\{BASE\}\.\.\.\$\{HEAD\}/);
    expect(auto).toContain("--paginate");
    expect(auto).toContain("CODEOWNERS Contents API error -- fail closed");
    expect(auto).toContain("Compare API returned no changed files -- fail closed");
    expect(auto).not.toMatch(/fetch-depth:\s*0/);
    expect(auto).toContain(".github/CODEOWNERS|");
  });
});
