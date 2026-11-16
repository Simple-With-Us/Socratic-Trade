# 2026-07-08 - Effort log assignment rules

**Summary:** Owner-directed rule change: agent tags on effort-log rows now mean
active ownership only. Stripped inactive tags from the Planned section.

**Why:** The effort board had many Planned rows with agent tags (CLAUDE/CODEX/AG/
MONET/CURSOR) that dated from the 2026-07-04 exhaustiveness pass but didn't
reflect any agent actively working on them. This made the board appear more
"claimed" than it was and gave a false sense of progress. Owner: "they should
not be assigned unless the agent is actively working on the effort."

**Rule added (live board + repo mirror):**
- "Never assign an effort to an agent unless that agent is actively working on it."
- Agent tags are live claims, not reservations.
- Planned rows: agent tags only valid if agent has claimed the work and plans to start imminently.
- If an agent stops working on an effort, remove the tag or move back to unassigned.

**Files:**
- `/Users/jay/apps/TRADING-EFFORT-LOG.md` — rules updated, Planned-section tags stripped
- `docs/EFFORT-LOG.md` — mirror synced
- `docs/rollouts/2026-07-08-effort-log-assignment-rules.md` — this note

**Slack message:** Posted (or queued for posting) to #ag***-s**c — see below.

**Verification:** Manual review of the live board confirms no inactive agent tags
remain in the Planned section.

**Follow-ups:**
- Slack message to #ag***-s**c needs posting (SLACK_BOT_TOKEN unavailable in this session)
- Owner-decision items compiled below need owner response
