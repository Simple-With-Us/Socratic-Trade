# Owner Decisions — 2026-08-19 (from the full-app review)

Four items in the review were owner calls, not engineering calls.  These are the answers, given
2026-08-19.  They are binding: implement to these, and do not re-litigate them in a later review.
Each names the finding it resolves and what "done" looks like.

## 1. Autopilot typed phrase gets the same off-switch as cap raises

**Decision:** the Ask-First → Autopilot switch honors the existing **Typed Confirm** preference,
exactly like raising a cap on a live account.  Typed Confirm stays ON by default, so nothing
changes until the owner turns it off — and then switching to Autopilot is one tap.

**Resolves:** `LIVE-17` (Part I §2).  The cap path already respected Typed Confirm
(`ios/SocraticTrade/PolicyTightening.swift`); the Autopilot phrase (`AUTOPILOT`) did not, which
made it the one guardrail with no override — against the standing ruling that guardrails are the
owner's adjustable preferences, never a scolding ritual.

**Done looks like:** with Typed Confirm off, Ask-First → Autopilot is a normal confirm (no typing),
on web and iOS.  With it on, behavior is unchanged.  One preference drives both the cap-raise and
the Autopilot path — not two settings.

## 2. The 5% opening headroom becomes an editable policy field

**Decision:** the hard-coded 5% headroom gate becomes a real policy field, surfaced in Guardrails,
defaulting to 5%, editable, and settable to **0 to disable**.  The owner's cap means the owner's cap
unless they choose otherwise.

**Resolves:** `trading-money-path:tsx-11` — `src/lib/policy.ts:567` silently shrinks the owner's own
per-order cap with no toggle anywhere, so a human-approved order can be trimmed below the limit the
owner set.

**Done looks like:** a `openingHeadroomPct` (or similarly named) field on the policy with a 5%
default, honest help text saying what it does and that 0 turns it off, and the gate reading the
field instead of a literal.  Existing accounts keep 5% behavior on migration.

## 3. Stopped allows reject and annotate, and QUEUES approvals

**Decision:** while Stopped, rejecting and annotating proposals works normally.  Approving is also
allowed, but it **queues** — the order is staged and placed when the agent is started.  The approve
control must make that unmistakable at the moment of the click ("Queued — will not place until you
start the agent", or equivalent), and the queued state must be visible afterwards, not just in a
toast that disappears.

**Resolves:** `LIVE-05` (Part I §2).  Today the server refuses BOTH approve and reject while
Stopped, even though the Proposals page says "Rejections are data, not failures" and rejections feed
the learning loop — so a pause silently costs training signal.

**Done looks like:** reject/annotate unaffected by run state; approve while Stopped produces a
clearly-labelled queued proposal, surfaced on the Proposals list and on Home, with an obvious way to
cancel the queue; starting the agent places the queued orders through the normal placement path
(including the usual policy gates re-evaluated at placement time, since prices will have moved).
Owner note: queued approvals must never place while Stopped — that is the one hard line here.

## 4. Sessions get server-side revocation and "Sign out everywhere"

**Decision:** implement real revocation — server-side session records, a revocation check on
authentication, a **Sign out everywhere** control, and an absolute session lifetime.

**Resolves:** `security-auth:sec-04` — sessions are 30-day stateless JWTs; signing out only deletes
the cookie, so a stolen or still-open session stays valid until expiry and cannot be revoked.

**Done looks like:** a session table keyed to the user with issued/last-seen/revoked timestamps,
an auth path that rejects a revoked or over-age session, a Sign out everywhere control in Settings
that revokes all sessions including iOS, and iOS handling a revoked session as a clean sign-out
rather than an error loop.  Rotating `AUTH_SECRET` remains the break-glass path and should stay
documented.

---

*Source: `docs/reviews/2026-08-18-full-app-expert-review.md` (Parts I + II).  Work items and plans:
`docs/reviews/2026-08-18-work-items.json`.*
