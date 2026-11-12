# R2 historic Litestream prune plan (`trading-live/**` only)

**Board:** `242c350e07ac45808eaf5eeeebdca255` (GB-HOUSEKEEPER).  
**Status:** Plan + read-only tooling only.  **No deletes in this lane.**  Extra-ship no.

## Context

Socratic Trade production Litestream replication moved from Cloudflare R2 to Backblaze B2 on
2026-08-07.  B2 restore has been **proven** (2026-08-20).  The **live** replica is B2 only —
see `litestream.coolify.yml` and `docs/litestream.md`.

Cloudflare R2 bucket **`socratic-trade-bucket`** (~9 GiB on the free tier as of 2026-10-05) still
holds the **pre-cutover** Litestream object tree under `trading-live/**` (tens of thousands of LTX
objects in addition to weekly DR).  That prefix is **dead history**: nothing in production writes
there anymore.

R2 remains in use for **weekly cold DR** under `cold-snapshots/**` (`src/lib/r2-cold-snapshot.ts`).
That prefix is **live** and must not be deleted in a `trading-live` cleanup.

## The footgun (read before any future delete)

Both replicas use the **identical** Litestream object path `trading-live/app.db`.  Only **bucket +
endpoint** differ:

| Target | State | Bucket (expected) | Endpoint (expected) |
|--------|--------|-------------------|---------------------|
| Cloudflare R2 | **DEAD** — prune candidate | `socratic-trade-bucket` | `*.r2.cloudflarestorage.com` |
| Backblaze B2 | **LIVE** — do not touch | `[REDACTED]` (Infisical prod `AWS_S3_BUCKET_NAME`) | `s3.eu-central-003.backblazeb2.com` |

Deleting `trading-live/**` against the **wrong** endpoint destroys the **active** backup.

**Never** use production Infisical `AWS_*` (B2) credentials for an R2 prune.  Use historic R2
scoped tokens via `AWS_R2_HISTORIC_*` only (see below).

Canonical warnings: `litestream.coolify.yml` (lines 17–25), `scripts/litestream-restore-drill.sh`,
`docs/audits/2026-08-20-deepseek-backend-ops-docs.md`.

## Scope of a future prune (not executed here)

**In scope (dead):**

- All object keys with prefix `trading-live/` on **`socratic-trade-bucket`** at the R2 endpoint.

**Out of scope (keep):**

- `cold-snapshots/**` on R2 (live weekly gzip DR; owner approval still required for any
  `cold-snapshots` delete — see `docs/litestream.md`).
- `weekly/**` if present (legacy archive lane; list first; do not assume empty).
- **Any** object on B2 / any bucket other than `socratic-trade-bucket` on R2.
- Production container, `litestream.coolify.yml`, Coolify env, or Infisical prod `AWS_*`.

## Preconditions (human gate)

Before **any** delete operation (future, owner-approved):

1. **Jay explicit written approval** for deleting `trading-live/**` on R2 (this plan does not
   constitute approval).
2. **B2 live replica healthy** — recent Litestream sync, restore drill within policy
   (`docs/litestream.md`, `scripts/ops/verify-b2-ltx-restore.mjs`).
3. **Endpoint + bucket echo** — operator prints bucket name and endpoint **host** (not secrets)
   and confirms:
   - bucket === `socratic-trade-bucket`
   - host matches `*.r2.cloudflarestorage.com` (not `backblazeb2.com`)
4. **Inventory receipt** — save stdout from the read-only scripts below; compare
   `trading-live/` byte count to expectation; confirm `cold-snapshots/` still present.
5. **R2 free-tier headroom** — optional: check R2 usage dashboard after listing; pruning is for
   capacity, not backup depth (B2 + Hetzner volume remain the recovery paths).

## Phase 0 — Read-only inventory (safe anytime)

Credentials: `AWS_R2_HISTORIC_BUCKET_NAME`, `AWS_R2_HISTORIC_ENDPOINT`,
`AWS_R2_HISTORIC_REGION` (default `auto`), `AWS_R2_HISTORIC_ACCESS_KEY_ID`,
`AWS_R2_HISTORIC_SECRET_ACCESS_KEY`.  Scoped to R2 **read** is sufficient for inventory; use a
token that cannot write if possible.

### A. Whole-bucket prefix summary (tracked prefixes)

```bash
node scripts/ops/r2-cold-snapshot-inventory.mjs
```

Prints `cold-snapshots/`, `trading-live/`, `weekly/` counts and sizes.  **No deletes.**

### B. Dead-history candidate listing (`trading-live/**` only)

```bash
# Summary only (default)
node scripts/ops/r2-trading-live-dead-history-inventory.mjs

# Full key list (still no deletes; acknowledgment flag)
node scripts/ops/r2-trading-live-dead-history-inventory.mjs --i-understand-r2-dead-history
```

Exit codes: `0` ok, `1` missing creds / usage, `2` AccessDenied.

### C. Optional — AWS CLI dry-run list (operator machine)

Replace placeholders; **do not** paste secrets into tickets or chat.

```bash
export AWS_ACCESS_KEY_ID="..."          # R2 historic token only
export AWS_SECRET_ACCESS_KEY="..."
export AWS_ENDPOINT_URL="https://<account-id>.r2.cloudflarestorage.com"

# List first page under dead prefix (no delete)
aws s3api list-objects-v2 \
  --bucket socratic-trade-bucket \
  --prefix trading-live/ \
  --max-keys 100 \
  --endpoint-url "$AWS_ENDPOINT_URL"

# Human: confirm ContinuationToken paging until IsTruncated=false before trusting totals
```

### D. Optional — rclone (read-only)

```bash
rclone lsf r2historic:socratic-trade-bucket/trading-live/ --dirs-only
rclone size r2historic:socratic-trade-bucket/trading-live/
```

(`r2historic` remote must point at R2, not B2.)

## Phase 1 — Delete (DEFERRED; not in this PR)

**Do not run** `aws s3 rm`, `rclone delete`, bulk DeleteObject, or lifecycle rules from an agent
lane.

When approved, a **separate** owner-operated runbook should:

1. Re-run Phase 0 the same day.
2. Delete **only** `trading-live/` on **R2** `socratic-trade-bucket` (batch deletes, rate limits).
3. Re-run inventory; expect `trading-live/` count `0`, `cold-snapshots/` unchanged.
4. Record object counts and GiB freed in `docs/rollouts/`.

Lifecycle rule on `trading-live/` is an alternative to one-shot delete; still requires the same
endpoint/bucket checks.

## Verification after a future prune

- `node scripts/ops/r2-cold-snapshot-inventory.mjs` → `prefix=trading-live/ count=0`.
- R2 dashboard: storage drops roughly by pre-prune `trading-live/` total (allow CDN/metadata lag).
- Production: unchanged B2 Litestream path; `GET /api/health` storage checks still green.
- **No** change to `cold-snapshots/` keys unless a separate approved freshen/prune.

## References

- `litestream.coolify.yml` — live B2 replica config + R2 footgun comment block
- `docs/litestream.md` — backup tiers, cold snapshot gzip, B2 retention
- `docs/rollouts/2026-08-07-litestream-b2-backup.md`
- `docs/rollouts/2026-08-17-litestream-restore-drill.md`
- `scripts/ops/r2-cold-snapshot-inventory.mjs` — read-only whole-bucket inventory
- `scripts/ops/r2-trading-live-dead-history-inventory.mjs` — read-only `trading-live/` inventory
