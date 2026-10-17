# ST-4545: Code CLI (server)

This change prepares an application route and a broker wire contract. It does
not install or start a broker, move logins, refresh authentication, change
containers, or make a live CLI request. The option stays off by default.

## Placement and trust boundary

The broker runs on the server, outside the Socratic Trade container and outside
the owner's Mac. ST calls only its private HTTPS endpoint, using a separate,
rotatable broker token. That token is not a MiniMax or Meta credential. The
broker's network ACL must permit only the ST service. Do not publish the broker
through the public app proxy. ST never mounts the host root, Docker socket,
CLI home or subscription credential files.

The broker must run as a dedicated non-root identity in its own sandbox, not as
host root. A request starts a new session in an empty per-request scratch
workspace. No workspace, transcript, session ID or model state may be reused
between requests or users. Only the configured owner's exact app identity is
accepted; all other owners are denied before launching an adapter. Never
accept a command, executable path, working directory, home, environment, MCP
configuration or session ID from the request.

MiniMax's adapter uses its native ACP stdio mode. Muse Code uses its version-pinned
MSP-to-ACP bridge, not an assumed native ACP mode. Neither adapter exists in the
ST process. The broker must enforce tools, terminal, file access and MCP disabled
both at the protocol capability/permission layer and at the OS sandbox boundary.
Deny permission requests and agent tool calls. Model text is untrusted data,
never a command or a trade instruction. ST's existing JSON/schema and risk gates
still apply after text generation. If an adapter cannot guarantee these
restrictions, return an error rather than weaken them.

## Existing host session (read-only snapshot, October 16, 2026, 10:50 CT)

Muse Code 1.4.9 was already running as root in the foreground of tmux
`codex-session`, pane `%0`, in `/root` (PID 2997645, shell PID 40546), with an
attached client.  No running MiniMax Code process was found in that snapshot,
which does not invalidate the installed/authenticated CLI state.  Neither CLI
had a matching running system service.  No pane contents were read and no
session was attached to or changed.

The live Muse session is the owner's interactive session, not a broker.  Do
not feed requests into its terminal, attach to it, share its session state or
move its credentials as part of this app patch.  Establishing a dedicated
non-root broker identity/authentication path is a separate activation task.
The existing session is not evidence that a headless isolated adapter works.

## Activation, separately approved

All five settings are required:

- `CODE_CLI_ENABLED=true` (unset by default).
- `CODE_CLI_OWNER_EMAIL`: the verified primary owner's exact sign-in email.
- `CODE_CLI_OWNER_USER_ID`: its exact current app user ID. The email-to-account
  mapping is checked; a bare `local` without the explicit email binding is not authority.
- `CODE_CLI_BROKER_URL`: the private HTTPS generation endpoint, with no embedded
  credentials, query or fragment.
- `CODE_CLI_BROKER_TOKEN`: a distinct secret supplied through the secret manager.

Before setting these, verify authenticated CLI entitlement, subscription terms
for unattended use, the model IDs each installed CLI really supports, the
bridge's protocol version and sandbox behavior, egress restrictions, cancellation,
and quota/concurrency limits. Never silently replace a requested model with a
CLI's default. Never extract subscription tokens to call a vendor API directly.
Credential relocation and paid/quota-consuming smoke tests need separate approval.

Only a middleware-verified primary owner with the exact configured email can
select this route in Settings. Other administrators, admin tokens, tenants,
client user-ID hints and auth-unconfigured fallback are not sufficient. When
the feature is enabled, request identity resolution rejects unverified local
fallback throughout the app so it cannot inherit the scheduler owner's ID.
Scheduled runs use their persisted owner user ID and re-check the exact binding
and deployment gate at endpoint selection and at the shared fetch boundary.
Deleted/re-created account generations do not inherit the old identity binding.

## Contract v1

Request: authenticated `POST` to the configured endpoint, JSON only. It contains:

- `version: 1`, a fresh random `requestId`, `ownerUserId`.
- `adapter: minimax | muse`, explicit `model` (no implicit/default model).
- `messages`: at most 100 plain-text `system | user | assistant` messages.
- `maxOutputTokens`: bounded to 1..16000.
- Optional `responseFormat` containing the existing structured-output request.
- `capabilities: {tools:false, terminal:false, files:false, mcp:false}`.

ST reconstructs this allowlist instead of forwarding the HTTP body or headers.
It rejects tool messages, tool declarations, function calls, streaming and
multimodal contents. Input and response text are limited to 1 MB. Request
cancellation and the caller deadline are forwarded unchanged; a call with no
signal gets a 150-second bound.  The broker must
terminate the CLI session and its process group on cancellation or timeout,
clean up the workspace on every exit, limit request/response bytes while
streaming, and enforce one in-flight generation per owner across all ST replicas
plus a fixed queue bound and quota ceiling. Do not auto-renew or auto-purchase.

Successful response: `{version:1, text:"...", finishReason:"stop"|"length"}`.
Only the text and finish reason become an OpenAI-compatible completion in ST.
Token usage and monetary cost remain unknown, not zero or a vendor API price
estimate. CLI usage is marked `keyRef=code-cli`; no CLI secret enters the usage
ledger. Error responses must not include auth tokens, paths, transcripts or CLI
stderr. Failed/invalid broker responses stop that CLI call; Green and Red do not
advance to their configured API fallback chains. No automatic paid API fallback
is added by this feature. The owner can deliberately choose another route.

The Assistant uses a single text-only generation on this route, without invoking
its application tools. It cannot use the usual quote/search/order-draft tool
loop through this route. This restriction does not alter other routes.

## Release checks

The included tests use mock broker responses only. They cover default-off,
owner/email binding, tenant and local-fallback denial, selected-owner scheduler
resolution, shared/capturing fetch, unique request IDs, text-only reconstruction,
no key/session/path forwarding, and invalid broker failure. They do not prove an
external broker's OS isolation or a real authenticated CLI generation.

Before activation, the separately deployed broker must pass adversarial tests
for cross-owner replay, stale sessions, tool requests, prompt-injected terminal
commands, file reads, MCP setup, redirects, over-limit input/output, queue
exhaustion, adapter crash, timeout/cancellation and workspace cleanup. Verify
those controls from the broker's actual sandbox, not a self-reported response.


## Review hardening (October 16)

The credential-bearing module is marked server-only. Browser reasoning controls use the pure llm-reasoning module, not the HTTP transport. The broker request preserves the caller abort signal; without one it has a 150s bound, matching the strategy reasoning allowance rather than truncating at 60s. Only the known unavailable broker configuration error is skipped during API-primary fallback planning; other resolution errors propagate. No paid fallback is added to a CLI-primary request.
