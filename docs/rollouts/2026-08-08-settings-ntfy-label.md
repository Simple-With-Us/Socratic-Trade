# Context & Objective

Owner asked to clean Settings → Delivery: remove the "recommended · free" badge next to the first push channel and stop calling it "Phone Push" (it is ntfy, not exclusive to phone).

# Changes Made

- Channel label `Phone push (ntfy)` / status label `Phone push` → **`ntfy.sh`** (lowercase).
- Removed the green "recommended · free" pill next to that option (Pushover provider badge kept when server is in pushover mode).
- Tooltips/title copy no longer say "Phone push".

Touched files:
- `src/lib/notify.ts`
- `src/lib/notifications.ts`
- `app/console/settings/delivery.tsx`
- `test/notification-status-truth.test.ts`

# Decisions & Trade-offs

- Kept separate **Pushover** channel row as-is; only the default ntfy channel was renamed.
- Error strings that used the old CHANNEL_LABELS name now say `ntfy.sh` so Activity/delivery failures match the settings label.

# Verification State

```bash
npm test -- test/notification-status-truth.test.ts test/notify.test.ts
npx tsc --noEmit
```

# Next Steps & Blockers

None — pure UI/copy.

# Zero-Code Findings

N/A
