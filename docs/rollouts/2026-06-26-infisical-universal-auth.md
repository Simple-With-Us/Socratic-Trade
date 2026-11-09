# 2026-06-26 — Infisical universal auth (Client ID + Client Secret), end the token confusion

## Summary

The operator could not complete the production cutover. Two errors, same root cause:

1. **403 "The provided access token is malformed"** — `INFISICAL_TOKEN` was set to a 64-char
   machine-identity **Client Secret**. That env var expects a short-lived **access token** (a JWT),
   not the Client Secret. Our own `docs/secrets.md` mislabeled it (`INFISICAL_TOKEN='…' # the client
   SECRET`), which led directly to the wrong value being pasted.
2. **401 "Invalid credentials"** when minting a token via `infisical login` — the shared identity's
   Client ID was paired with the wrong Client Secret (two projects, easy to swap), and the box's
   `set -u` shared-verify block then crashed with `SHARED_PROJECT_ID: unbound variable`.

Fix: make the machine-identity **Client ID + Client Secret** (Universal Auth — long-lived) the primary
credential across the runner, the cutover script, deploy, and docs. The CLI/runner exchange them for a
fresh access token on every launch, so nothing in `deploy.env` expires and operators never handle raw
tokens.

## Why

- A Client Secret ≠ an access token. Persisting a minted token is also wrong: the identity's Access
  Token TTL is finite (the operator's is 2,592,000s = 30 days), so a stored token would silently die.
  Storing the **Client ID + Client Secret** and minting per-launch removes the whole failure class.
- The `set -u` crash and the silent "malformed token" 403 both needed to become clear, actionable
  messages.

## What changed

- **`scripts/infisical-run.mjs`** — per-project auth resolves Client ID + Client Secret first
  (`INFISICAL_CLIENT_ID`/`INFISICAL_CLIENT_SECRET`, and `INFISICAL_SHARED_CLIENT_ID`/`…_SECRET`) and
  **exchanges them for a short-lived access token** via `infisical login --method=universal-auth …
  --plain`, then passes that token to the single-project `infisical run` path and each `infisical
  export` in the app+shared overlay. (Initially this mapped the client creds onto the CLI's
  `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID`/`…_CLIENT_SECRET` env vars; Codex review #177 P1 flagged that
  `run`/`export` aren't guaranteed to auto-auth from those — the documented machine-identity flow is
  to mint a token — so the runner now mints explicitly.) App and shared identities stay distinct
  (shared falls back to the app identity only when it has no creds of its own); the Client Secret is
  never leaked into the spawned app process. A pre-minted `INFISICAL_TOKEN` still works as a fallback.
- **`scripts/infisical-prod-cutover.sh`** — accepts the Client ID/Secret (env → prior `deploy.env` →
  interactive prompt: Client ID visible, Client Secret hidden); mints a token the same way for its own
  verify/import calls while persisting the **long-lived** creds to `deploy.env`; **detects a 64-hex
  value in a token field and dies with the explanation** (app + shared — per Codex review #177 P2, an
  explicitly-set-but-malformed `INFISICAL_SHARED_TOKEN` now fails closed instead of silently
  restarting prod app-only); and hardens the shared overlay so it cleanly skips when not requested (no
  `set -u` unbound-variable crash).
- **`.github/workflows/deploy.yml`** — the `build:secrets` gate fires on Client ID + Client Secret (or
  a token), so a client-creds box still builds with secrets. The bootstrap is sourced in **subshells
  scoped to the build and restart steps only — never around `npm ci`**, so the long-lived Client
  Secret is not exposed to dependency install/lifecycle scripts (Codex review #177 round 2).
- **`.env.example`, `docs/secrets.md`, `docs/deployment.md`** — corrected the token-vs-Client-Secret
  conflation; documented `INFISICAL_CLIENT_ID`/`INFISICAL_CLIENT_SECRET` (+ shared) as the primary
  bootstrap.

### Security hardening (Codex review #177 rounds 2–6)

Round 2:
- **Mint via env, not argv:** both `mintToken` (runner) and `mint_token` (cutover) now pass the
  Client ID/Secret to `infisical login` through `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID`/`…_CLIENT_SECRET`
  in the child env instead of `--client-secret=` on the command line, so the long-lived secret never
  appears in `ps`/`/proc/<pid>/cmdline`.
- **Fail closed on a partial shared identity (cutover):** setting only one of
  `INFISICAL_SHARED_CLIENT_ID`/`INFISICAL_SHARED_CLIENT_SECRET` now dies (mirroring the app path)
  rather than silently restarting prod without the shared overlay.
- **Scope the bootstrap away from `npm ci`** (deploy.yml subshells, above).

Round 3:
- **Sanitize the `infisical export` subprocess env (runner):** `fetchProject` now builds its env via
  `childEnv` (which strips every client secret / universal-auth var), so each overlay export
  authenticates with only the short-lived token — no client secrets in the export child's env.
- **Fail closed on partial runner credentials:** `infisical-run.mjs` validates the app pair (always)
  and the shared pair (when the overlay is on) up front — exactly one of id/secret → exit 2, instead
  of silently falling back to a stale token or a cached CLI login while still setting
  `SECRETS_SOURCE=infisical`.
- **Fail the deploy on a present-but-unusable bootstrap:** when `deploy.env` exists (the cutover
  signal, with `REQUIRE_SECRETS_MANAGER=1`) but the `infisical` CLI is missing or no complete
  credential is present, `deploy.yml` now errors instead of doing a silent plain build that would then
  restart a `start:secrets` service that can't boot.

Round 4:
- **Cutover: fail closed on a lone app Client Secret.** The app validation previously caught only
  `CLIENT_ID`-without-secret; a lone `INFISICAL_CLIENT_SECRET` (no id) plus a stale `INFISICAL_TOKEN`
  in `deploy.env` would fall back to the expiring token and persist *that*. The app path now does the
  same full XOR check as the runner/shared paths — either half without the other dies.

Round 5:
- **Sanitize the cutover's own `infisical` children.** When invoked the documented way
  (`INFISICAL_CLIENT_SECRET=… bash …` / exported), `infisical_app`/`infisical_shared` set the token but
  the exported long-lived Client Secret was still inherited by every `infisical secrets`/`secrets set`
  verify/import child. New `infisical_tok` helper runs them via `env -u …` so they authenticate with
  only the short-lived token — same scoping as the runner's `childEnv`.

Round 6 (cross-identity + parent-shell isolation):
- **Per-identity login env.** Each `infisical login` mint now runs from a sanitized base plus ONLY its
  own universal-auth pair — runner via `sanitizedBase()` (a shared `CREDENTIAL_ENV_KEYS` strip), cutover
  via `env -u …` — so the app mint never sees the shared Client Secret and vice versa.
- **Cutover parent shell sanitized.** After the creds are copied into the script's own
  `APP_*`/`SHARED_*` vars, the operator-supplied credential ENV vars are `unset`, and the restart
  sources `deploy.env` **inside the PM2 subshell** — so the health-check loop and `--scrub` never
  inherit the long-lived secret; only the PM2 start does. Secret-scoping is now complete across every
  child-process AND parent-shell surface.

## Files

- `scripts/infisical-run.mjs`
- `scripts/infisical-prod-cutover.sh`
- `.github/workflows/deploy.yml`
- `.env.example`
- `docs/secrets.md`, `docs/deployment.md`
- `STATUS.md`, `PLAN.md`, this rollout note.

## Verification

- `node --check scripts/infisical-run.mjs` ✓; `bash -n scripts/infisical-prod-cutover.sh` ✓.
- **Round-2 hardening, re-proven with shims:** runner mints via env (login `argv` contains no
  `--client-secret`, creds arrive as `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID/SECRET`), the minted token
  flows to run/export, and no Client Secret leaks into the spawned process; cutover fails closed on a
  partial shared identity and on a Client-Secret-as-token, happy path still writes long-lived creds to
  `deploy.env`; a deploy.yml simulation confirms `npm ci` sees **no** Client Secret while
  `build:secrets` + `pm2 restart --update-env` do. `tsc` clean.
- **Fake `infisical` shim** (real CLI absent in the sandbox): single-project client-creds → CLI gets
  `UA_CLIENT_ID/SECRET`, no `INFISICAL_TOKEN`, `SECRETS_SOURCE=infisical`; token-only → token passed
  through; stale token + client creds → universal auth wins and token is dropped; app+shared overlay →
  each `export` runs under its own identity, **app wins the overlapping key**, app-only/shared-only
  keys both present, exit codes propagate; shared-without-creds → borrows the app identity. (One test
  assertion was written against multi-line stdout and mis-flagged; the captured output shows
  `FOO=app_foo` + `app wins 1 overlap(s)`, i.e. correct.)
- Trio: `npx tsc --noEmit` ✓ · `npm test` **1250/1250** ✓ · `npm run build` ✓ (reverted the
  `next-env.d.ts` / `tsconfig.json` build churn).

## Operator notes / follow-ups

- **In-flight cutover unblock:** the app verify already passes; the crash was the shared block running
  because the shared **Client Secret** was exported as `INFISICAL_SHARED_TOKEN`. `unset
  INFISICAL_SHARED_TOKEN` and re-run to complete the app-only cutover now; after this PR deploys, the
  hardened script catches that case itself.
- **Auth going forward:** set `INFISICAL_CLIENT_ID` + `INFISICAL_CLIENT_SECRET` (app) and, for the
  overlay, `INFISICAL_SHARED_CLIENT_ID` + `INFISICAL_SHARED_CLIENT_SECRET` (shared-at-ct). Pair each
  Client Secret with **its own** identity's Client ID. The runner mints tokens itself.
- **Security:** the Client Secrets pasted in chat earlier are compromised — rotate both in the
  Infisical dashboard (each identity → Universal Auth → roll the Client Secret).
- The live Infisical CLI couldn't be exercised here; the universal-auth env-var mechanism is per
  Infisical's CLI docs. Operator should confirm on the box (the hardened script fails loudly if auth
  is wrong, before changing anything).

## Follow-up (same day) — the *actual* root cause of `SHARED_PROJECT_ID?: unbound variable`

The "unset `INFISICAL_SHARED_TOKEN`" unblock above was a **red herring for this specific crash.** After
this PR landed (box at `d103766`), the operator restored a pristine script (`git diff` clean, identical
to `origin/main` byte-for-byte) and *still* hit, during the shared-overlay verify:

```
scripts/infisical-prod-cutover.sh: line 200: SHARED_PROJECT_ID?: unbound variable
```

**Why it's not what it looks like.**
- Committed line 43 unconditionally defaults the var: `SHARED_PROJECT_ID="${INFISICAL_SHARED_PROJECT_ID:-18f563a3-…}"`.
  It is bound before line 200 in *every* committed version (checked back to the first overlay commit
  `d8fa8a3`); there is no `?`-form anywhere in the file.
- Reproduced line 200 with the exact bytes from `d103766` under bash 5.2 in UTF-8 *and* C locales:
  bound → prints fine; unset → `SHARED_PROJECT_ID: unbound variable` with a **clean** name. No bash
  construct on a modern shell yields a `?` in the name.

**Root cause.** Line 200 was the **only** line in the script with a non-ASCII character (`…`, U+2026 =
`e2 80 a6`) **directly adjacent** to a `$VAR`: `"...$SHARED_PROJECT_ID…"`. The production box is a Mac,
so `bash scripts/…` runs Apple's `/bin/bash` **3.2.57**, which mis-parses the multibyte sequence into
the identifier — producing an unbound name the terminal renders as `SHARED_PROJECT_ID?`. The cutover
printed lines 161/188/194 first (those also contain `…`, but *not* adjacent to a variable) and then
died on 200 — precisely the observed symptom. The `?` is the stray byte, the "unbound" is a real
*different* name, and a clean checkout still fails because the bug is in the shell, not the file.

**Fix.** ASCII-converted `scripts/infisical-prod-cutover.sh` end-to-end (`…`→`...`, `—`→`-`, `─`→`-`,
`→`→`->`): 33 lines, character-swaps only, **zero logic change**. `grep -cP '[^\x00-\x7F]'` → 0,
`bash -n` ✓. Swept all `scripts/*.sh` for the `\$\{?\w+\}?[^\x00-\x7F]` adjacency pattern — only this
one line matched; the other scripts' non-ASCII is decorative box-drawing/em-dashes (not var-adjacent),
so they don't trip the 3.2 bug. Added a durable trap to `AGENTS.md` (operator/deploy `*.sh` stay ASCII).

**Files:** `scripts/infisical-prod-cutover.sh`, `STATUS.md`, `AGENTS.md`, this note.
**Verify:** `bash -n scripts/infisical-prod-cutover.sh` ✓ · `grep -cP '[^\x00-\x7F]' scripts/infisical-prod-cutover.sh`
→ `0` · reproduced the bash error semantics locally with the real bytes (bound vs unset × UTF-8 vs C).

**Operator follow-ups (unchanged + new):**
- `git pull` in `~/apps/trading-live` (or let the next deploy `git reset --hard origin/main`), then
  re-run with the app + shared **Client ID/Secret** pairs (overlay on). The crash is gone.
- Still rotate the two compromised Client Secrets; still don't `--scrub .env.local` until the app boots
  healthy with the shared keys present.
