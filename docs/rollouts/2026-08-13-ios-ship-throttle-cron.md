# Context & Objective
The `ios-ship.yml` workflow enforces a 2.5 hour throttle to avoid spamming TestFlight when multiple commits land in quick succession. However, this caused an issue where trailing commits merged during the throttle window were silently skipped and never built if no subsequent commits followed to trigger the workflow again.

# Changes Made
- Lowered the minimum throttle interval in `ios-ship.yml` from 2.5 hours (`9000s`) to 1 hour (`3600s`) via `IOS_TF_MIN_INTERVAL_SEC`.
- Added a `schedule: - cron: '*/30 * * * *'` trigger to `ios-ship.yml`. This ensures that every 30 minutes the workflow wakes up, checks if there is any pending unshipped code, and processes it if the throttle window has expired.

# Decisions & Trade-offs
- The cron approach ensures no trailing commit is ever forgotten.
- Because `ship-testflight.sh` exits early (taking ~20s) if the `head_sha` matches the last successfully shipped SHA, the 30-minute cron won't generate any actual TestFlight build spam or meaningful Mac runner overhead.

# Verification State
- Modified workflow syntax is valid.
- The `ship_gate` properly short-circuits unchanged SHAs.

# Next Steps & Blockers
None.
