# Server broker implementation staging

`broker.py` implements strict owner/token/model/input admission, one in-flight
request, replay refusal within one process lifetime, a request ceiling, bounded
JSON-RPC output/deadline, process-group cleanup and fail-closed tool/permission
callbacks. `adapters.py` implements native MiniMax ACP and a narrow MSP bridge for
Muse. Neither file starts a listener or launches a CLI on import. No service is
enabled by this patch.

These adapters are not live-generation verified. MiniMax's selected model must
be advertised by the installed ACP server, and its config-option ID must be
confirmed by a no-generation session handshake. Muse's embedded 1.4.9 schema is
the field contract; the adapter still needs a no-generation handshake fixture
from the sandbox. Tool denial by callbacks is an additional gate, never the
OS sandbox. The full tool set must be empty before a real turn.

The server staging identity is `st-code-cli`, UID995, private home
`/var/lib/st-code-cli`, pinned binaries in `/opt/st-code-cli`. The existing root
Muse tmux session remains unrelated and untouched. Only dedicated-user auth may
be mapped into per-request sandboxes, one adapter at a time. MiniMax refresh
writes must persist safely rather than being discarded with scratch state.

## Verified without generation

A transient systemd probe ran as UID995 inside RootDirectory, private home/work
tmpfs, read-only runtime mounts, no capabilities, NoNewPrivileges and a no-exec
mount policy with an explicit probe-interpreter exception. It confirmed:

- Host `/app`, Docker socket, dedicated auth and root auth were inaccessible.
- Scratch was writable; `/usr` was read-only.
- `/bin/sh` could not execute.

The probe used PrivateNetwork and dummy data. It did not verify provider egress,
actual CLI filesystem needs, protocol tool inventory, or authenticated generation.
Those remain required before calling the broker ready.

## Remaining activation gates

- Finalize a root-owned fixed-argument sandbox launcher with exact read-only
  runtime mounts and adapter-only authentication mapping, no request-derived
  paths/commands/env, hard process/memory/time limits, process-group cleanup and
  private scratch removal.
- Restrict network egress to vendor/auth endpoints. Never expose host networking
  or credentials to a general agent shell.
- Verify empty tools, no hooks/skills/plugins/MCP, model selection and session
  isolation with offline handshakes under the actual sandbox.
- Verify cancellation on client disconnect, including whole systemd unit cleanup.
- Use durable replay/quota accounting across broker restarts before enabling
  live unattended service. Current in-memory ceiling is not durable accounting.
- Bind privately with service authentication and TLS termination; current HTTP
  helper only permits loopback, and no listener is running.
- Run the separately approved one-shot generation tests only after the sandbox
  gates pass. ST activation still requires a separate owner decision.

Tests: `cd server/code-cli-broker && python3 -m unittest -v`.

## Current stop point (October 16, 2026, 11:02 CT)

MiniMax 0.6.12's shipped config loader adds `task_query`, `task_output` and
`task_stop` even when `agents.default.tools`, `builtinTools` and `skills` are
empty and all capability features are false. The offline resolver check failed
the empty-tool invariant. Do not proceed to real-auth generation based only on
the YAML. A supported suppression or separately reviewed adaptation is needed.

The dedicated MiniMax access credential expires at 2026-10-16T16:53:01.415Z,
about one hour after sign-in. A refresh credential and refresh-grant code are
present, but no full unattended expiry/renewal cycle was observed. Muse's Meta
auth record has no expiry or refresh field. Neither is proven across a trading
day. Do not conclude that rotation requires hourly sign-in or that it never does.

Server SSH from the Mac began returning connection refused at 11:01 CT, including
a fresh non-multiplexed retry. No SSH/firewall/restart change was made. Further
host verification is blocked. No real-auth generation or broker activation has
occurred. The root interactive Muse session was last verified untouched.


## Tailnet recovery and offline MSP check (11:04 CT)

Host access recovered via the existing server tailnet node with strict reuse of
the public host key pin. Public SSH remains unused. A real Muse 1.4.9 MSP
initialize handshake passed inside the no-network/no-auth sandbox and returned
zero granted capabilities, ephemeral sessions and sandbox available. No
session prompt or turn was sent. Optional settings/skill materialization failed
closed due to the masked home; this is not proof of an empty final tool set.
The private-home layout still needs correction and tool posture verification.
MiniMax agent configuration exposes disallowedTools, a possible supported way
to remove the forced task tools, but it has not been validated at execution.


## Latest integration stop point (11:13 CT)

MiniMax's OAuth store derives its credential namespace from the data directory
path. Mapping the dedicated auth at a different sandbox path reports missing
authentication. Preserving the dedicated data-dir path no longer returns that
immediate error, but no-network startup hangs before initialize. The cause is
not proven. The probe's runtime limit triggered, but graceful stop did not
settle promptly; only that transient unit was SIGKILLed, confirmed dead, and its
private scratch removed. Final launchers must set TimeoutStopSec and whole-unit
kill cleanup explicitly. Root Muse remained unchanged.

Pinned MiniMax 0.6.12 contains the built-in model constant
`MiniMax-M3.1-Flash-Preview`. This is a grounded candidate, not yet a verified
account-entitled model inventory. The target is M3.1, never a fallback to M3.
No CLI update is needed just to discover that string.

Do not publish these incomplete broker files as ready. Protocol adapters,
egress, authenticated session/tool inventory and cancellation still need actual
verification. No broker listener, real generation or ST activation has occurred.

## Restricted-egress checkpoint (11:18 CT)

`egress.py` and `sandbox_probe.py` are staging only. A no-auth CLI namespace
had no direct Internet route, could not reach an unlisted HTTPS destination,
and could reach the exact public account.minimax.io TLS endpoint through a
private Unix-socket gateway. The gateway has independent unit-level IP denies,
fixed adapter hostnames, exact CONNECT/SNI admission, no ECH, public-only DNS
validation with literal address pinning, byte/time ceilings, and no payload logs.
Both transient units ended inactive with empty cgroups. Five offline egress
tests passed. This does not prove either CLI honors proxy settings yet.

A separate process+fork adversarial test ignored SIGTERM. RuntimeMaxSec=2,
TimeoutStopSec=1, KillMode=control-group and SendSIGKILL=yes removed both PIDs
in3.39seconds. The ACP probe cleanup now stops/kills the whole unit explicitly.

The installed MiniMax exported runtime selector (`Fve`, export `lc`) retained
three task tools with its forced capability ceiling, then returned zero when
configSelection used empty tools and explicit disallowedTools. No shipped
vendor code was changed. How to put that configSelection into the ACP primary
profile remains unverified, so generation is still gated.

## Authenticated no-generation ACP checkpoint (11:29 CT)

The MiniMax authenticated initialize/session-new handshake succeeds with the
restricted gateway. Node's own proxy fetch got TLS200 from the fixed public
auth domain. The previous startup hang was traced (file/connect syscalls only)
to attempts to create the sibling `.minimax.lock` on a read-only parent. Mapping
an entirely private scratch parent at the original dedicated home path fixes
that without exposing the host home. Only the dedicated MiniMax auth subtree
is separately bound; no root auth is copied or exposed.

ACP advertises exact M3.1 value `m:minimax:MiniMax-M3.1-Flash-Preview:v:` plus a
thinking variant. Existing adapter target matching must be updated to this
observed value before use. This is advertised, not generation-entitled proof.

Editing the scratch built-in primary agent.md with empty tools, explicit
three-task disallowedTools, empty MCP and empty skills is accepted across a
session-new handshake. Source traces the canonical definition into the runtime
selector, but the final full model tool inventory is not yet observed. The
source-verified local `/context` diagnostic returns no snapshot before a turn,
so it does not close that gate. No model prompt or generation was sent. Auto
permission mode is still advertised; any eventual launcher should select Ask
explicitly in addition to zero tools and broker callback denial.

Gateway denied a few unlisted destinations without logging their payloads.
Do not expand the allowlist on a runtime request. Research the shipped source
first and add only the vendor/auth endpoints the assigned model needs.

The authenticated debug harness remains server staging only at
/opt/st-code-cli/staging/acp_session_probe.py. It is not a production launcher.
Its per-request scratch, local agent override and transient cgroups are cleaned
on exit. Remaining blockers: observed final empty tool inventory, Muse sandbox
session setup, final immutable launcher, durable admission/accounting,
disconnect cancellation, auth renewal and end-to-end generation test. All broker
files remain unpublished staging, and no ST route is enabled.

Muse no-auth/no-network session-start now passes with private XDG dirs,
--disable-write, --disable-shell, --disable-request-user-input and ephemeral
session logging. Session is idle/turnCount0, approval denyUnmatched. This is not
zero-tool proof; serve rejects the global empty preset, so do not reuse that
unsupported launch syntax. `mcpServers` is an object, not an array. Adapter now
uses that observed schema shape and MiniMax's advertised model encoding.
15 offline tests pass. No real generation or service enablement occurred.

## Durable admission staging (11:31 CT)

`replay.py` reserves request UUIDs before execution in a private SQLite file,
FULL synchronous commits, BEGIN IMMEDIATE uniqueness/ceiling checks and no
automatic refunds after an uncertain outcome. Restart and concurrent replay
tests pass; the HTTP helper now refuses to listen without a supplied durable
store. Nothing starts automatically. A fixed total request ceiling is not a
provider's real token/quota accounting.19 offline tests pass. No server store or
listener was created. Effective tool inventory and disconnect cancellation are
still unresolved; this patch is not ready to activate.

## Native-exec redesign checkpoint (October 16, 2026, 12:33 CT)

This is unpublished staging, not an active broker. Native exec replaces the
ACP/MSP plan. exec_adapters.py and fixtures have 14 offline parser/command tests.
MiniMax-only is the candidate; Muse remains disabled because no supported output
cap was found (actual default wire max_output_tokens was 128000).

MiniMax 0.6.12 native exec internally permits five retries after the first
attempt. ReplayStore therefore atomically reserves SIX attempt-units for every
admitted generation, before execution. The configured ceiling is attempt-units,
not generation count. All outcomes, including timeout, disconnect and unknown,
remain consumed forever. No automatic replay, retry or quota refund is allowed.
Existing legacy reservations are conservatively migrated as six units each.
This is a conservative admission bound, not a provider billing/token ledger.

An isolated dummy minimax_api request demonstrated actual tools:[] and actual
max_tokens:123 with provider model limit.output:123. That is not proof of the
production saved-login route. A wholly synthetic OAuth store was accepted by
the minimax managed route, but the public package pins managed production
endpoints; localhost override only exists in test builds and --env test is
rejected by the public package. PrivateNetwork=yes prevented any external call.
Do not claim the saved-login wire cap/tools proof has passed.

Never extract the CLI's saved subscription credentials into API-key input or
custom HTTP calls. No real-auth generation, ST activation or listener has run.
Root Muse is untouched. The exec runner is not yet wired into broker.py; the
old adapters remain historical staging. Final fixed launcher, isolated saved-
auth renewal, whole-unit disconnect cancellation, and exact saved-login wire
proof remain gates before requesting owner approval for one real smoke test.

Offline replay/parser/egress suite: 27 tests pass. Replay tests include restart,
concurrent same-UUID denial, concurrent six-unit ceiling, legacy migration,
unknown-outcome consumption and refusal of understated reservations.
