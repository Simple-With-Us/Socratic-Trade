# Cloudflare origin lock

## What this is

Clients must reach Socratic Trade through Cloudflare.  A direct request to the Hetzner origin skips the WAF, the upload cap, and every header Cloudflare overwrites.  This check closes that path inside the app.  It is off until `REQUIRE_CLOUDFLARE_ORIGIN` is set, so merging it does not change live traffic.

The Node server reads the TCP peer.  Middleware cannot see that socket, so the server stamps the peer with a per-process token and middleware repeats the same decision.  A caller-supplied stamp is ignored.  `CF-Connecting-IP` and `X-Forwarded-For` are not trusted unless that peer is Cloudflare, or the origin secret below matched.  While the flag is off those headers are left as they are today.

## How a request is admitted

With the flag on, a request is admitted when any of these is true.

- The TCP peer is a published Cloudflare address.
- The TCP peer is a trusted proxy (Traefik on the docker bridge, by default loopback, RFC1918, IPv6 ULA, and link-local) and the hop that proxy appended is a Cloudflare address. The rightmost `X-Forwarded-For` entry that is not itself a trusted proxy is that hop. A spoofed address to the left of it does not count. `X-Real-IP` is consulted only when `X-Forwarded-For` has no such hop.
- The request header `x-origin-lock` matches `ORIGIN_LOCK_SECRET`.
- The TCP peer is loopback. In-container probes use this. It does not make client IP headers trusted.
- The TCP peer is in `ORIGIN_LOCK_ALLOW_CIDRS`. The default is Tailscale `100.64.0.0/10`. Set the variable to `none` to clear it. These peers do not make client IP headers trusted.
- `GET` or `HEAD /api/live`. Docker `HEALTHCHECK` and the Coolify HTTP probe stay on this path. The probe does not make client IP headers trusted.

Anything else is HTTP 403 with a plain `Forbidden` body.  The same rule applies to WebSocket upgrades.

## Enable it

Do this only after the firewall step below is in place.  This repository does not set the flag and does not restart production.

1. Confirm Traefik appends its immediate peer to `X-Forwarded-For`. On this host that peer is a Cloudflare edge address, so the rightmost non-proxy hop is in the published ranges. If Traefik forwards only the visitor address, every real user will get 403. Fix the proxy, or use the secret in the next step.
2. Optional. Put `ORIGIN_LOCK_SECRET` in Infisical for this app. Use at least 16 characters. Add a Cloudflare Transform Rule that sets the request header `x-origin-lock` to that value. Do not commit the value. A short secret is ignored.
3. Set `REQUIRE_CLOUDFLARE_ORIGIN=1` in the app environment. Accepted values are `1`, `true`, `yes`, and `on`. Restart the app so the process sees it.
4. Keep the Coolify and Docker health path on `GET /api/live`. `GET /api/health` is not exempt.
5. Override the proxy list with `ORIGIN_TRUSTED_PROXIES` only if the default private ranges are wrong. A comma-separated CIDR list replaces the default. `none` clears it.

Authenticated Origin Pulls are checked at the TLS terminator, not in this Node process.  The shared header is the in-app stand-in.  Enable Authenticated Origin Pulls on the zone and on Traefik later if you want that TLS check.  This change does not turn it on.

## Refresh the ranges

The lists live in `src/lib/cloudflare-ip-ranges.data.ts`.  They were retrieved on 2026-11-12 from `https://www.cloudflare.com/ips-v4` and `https://www.cloudflare.com/ips-v6`.  Refresh with `node scripts/refresh-cloudflare-ips.mjs` and commit the data file.  Update the Hetzner firewall in the same pass.  The app does not fetch the lists at runtime.

## Hetzner firewall (not done here)

The app check is not a substitute for a host firewall.  A packet that never reaches Node is the control you want.  Applying it is an operator step on the Hetzner Cloud firewall for `fleet-hetzner-nbg1`.  This change does not call the Hetzner API and does not edit the live firewall.

- Allow inbound TCP 80 and TCP 443 only from the Cloudflare IPv4 and IPv6 CIDRs in `src/lib/cloudflare-ip-ranges.data.ts`.
- Keep the host's existing admin path (SSH and Tailscale). Do not open 80 or 443 to `0.0.0.0/0` or `::/0`.
- When Cloudflare publishes new ranges, update the firewall and the data file together.
- Tailscale `100.64.0.0/10` can stay if operators reach the box that way. The app allows that range while the lock is on, and it does not treat it as Cloudflare.
