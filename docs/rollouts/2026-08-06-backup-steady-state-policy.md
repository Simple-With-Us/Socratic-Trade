# 2026-08-06 — Fleet backup steady-state policy (stop daily retunes) [GROK]

## Policy (binding)

Owner: free tier, continuous all month, shallow history OK, no week-long pause.

| App | R2 litestream sync | Snapshot retention | Local DB copies |
|-----|--------------------|--------------------|-----------------|
| **Socratic Trade** | **15m** (well backed up) | **24h** | live only (+ tiny litestream cache) |
| **Congress.Trade** | **15m** | **24h** | live only |
| **Usage Monitor** | **1h** | **24h** | **1** pre-migrate + **1** deploy backup max |

### Do not

- Stop R2 for weeks to "save headroom"
- Keep multi-day multi-copy full DB clones on disk
- Use sub-minute litestream sync
- Confuse **product PDFs** (CT `raw/`) with DB backup cadence — PDFs are storage; sync interval is Class A

### PDFs vs 15m vs 30m

CT product filings/PDFs in R2 count toward **storage GiB**, not toward how often the DB should sync. Keep CT at **15m**. Only move to 30m if Class A pace is still hot after a real 15m singular-`replica` config (verified in litestream log: `sync-interval=15m0s`).

### Free tier targets

- Storage: stay under **~70% of 10 GiB** absolute when practical; short LTX retention does the work
- Class A: continuous low cadence all month; never thrash then pause

### Host applied 2026-08-05/06

- CT: litestream active, singular replica, **15m**
- ST: kill cleared, litestream parent of next, **15m**
- UM: kill cleared, config **1h**; local pruned to 1+1 full copies
- Local disk pruned (was multi-GB deploy farm on UM)

## Resume / change checklist

1. Edit config (ST `litestream.coolify.yml`, UM `litestream.yml`, CT `/etc/litestream/congress.yml`)
2. Confirm log line `sync-interval=…`
3. Do not invent new cadences without measuring Class A daily delta
