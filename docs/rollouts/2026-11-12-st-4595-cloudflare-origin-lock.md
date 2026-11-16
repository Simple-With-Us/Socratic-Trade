# 2026-11-12 — ST-4595 Cloudflare origin lock

## Context & Objective

Audit item sec-02: the origin answers on the public IP, so a client can skip Cloudflare.  This change adds an in-app gate that admits only Cloudflare ingress, a shared origin secret, or the health and ops exceptions below.  The gate ships off.

## Changes Made

A pure decision function checks the TCP peer against Cloudflare's published ranges.  When the peer is a trusted proxy, only the appended forwarding hop is eligible, and client IP headers are stripped unless that hop is Cloudflare or the origin secret matched.  `http.Server` is wrapped from `instrumentation.ts` because Next.js middleware cannot see the socket.  Middleware repeats the decision when the stamp token is visible in that runtime.  `trustedCloudflareClientIp` keeps today's behavior while the flag is off, and refuses the header while the flag is on unless the hook marked the request.

- `src/lib/cloudflare-ip-ranges.data.ts`
- `src/lib/cloudflare-ip-ranges.ts`
- `src/lib/cloudflare-origin-lock.ts`
- `src/lib/rate-limit.ts`
- `middleware.ts`
- `instrumentation.ts`
- `scripts/refresh-cloudflare-ips.mjs`
- `test/cloudflare-origin-lock.test.ts`
- `docs/runbooks/cloudflare-origin-lock.md`
- `STATUS.md`
- `PLAN.md`

## Decisions & Trade-offs

`REQUIRE_CLOUDFLARE_ORIGIN` defaults off so a merge does not change who can connect.  The Hetzner firewall allowlist is documented and not applied.  Authenticated Origin Pulls are a TLS-terminator setting.  The in-app stand-in is `ORIGIN_LOCK_SECRET` plus the header `x-origin-lock`.  `GET` and `HEAD /api/live` stay open from any peer so Docker and Coolify probes keep working.  Loopback is fully allowed because that source cannot be spoofed from the network.  Tailscale `100.64.0.0/10` is allowed unless `ORIGIN_LOCK_ALLOW_CIDRS=none`.  Those exceptions do not make `CF-Connecting-IP` trusted.

Traefik must append its immediate peer onto `X-Forwarded-For`.  If it forwards only the visitor address, turn the flag on only with the origin secret, or fix the proxy first.  A proxy that neither appends nor overwrites forwarding headers can still be spoofed.  The firewall is what closes that hole.

## Verification State

```
npx vitest run test/cloudflare-origin-lock.test.ts test/middleware-auth.test.ts
npx tsc --noEmit
npm run lint
```

Origin-lock and middleware-auth tests passed (57).  `npx tsc --noEmit` passed.  Full `npm run lint` passed with 0 errors (869 existing warnings).  No deploy, no firewall change, no secret value.

## Next Steps & Blockers

Leave `REQUIRE_CLOUDFLARE_ORIGIN` unset in production until the Hetzner firewall allows 80 and 443 only from Cloudflare, and one proxied request shows a Cloudflare hop in the forwarded chain.  Then set the flag in Infisical and restart.  Do not set it from this branch.

## Zero-Code Findings

Next.js middleware has no TCP peer.  The socket is available on the Node HTTP server, which is where the stamp is written.
