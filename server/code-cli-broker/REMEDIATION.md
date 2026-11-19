# ST-5278 source remediation, November 18

Staging only. No provider process, login, model generation, listener, service, sandbox deployment or production setting was exercised or changed.

## Fixed offline

- Reconciled the preserved branch with current main b77fa8c6af858ec9faa56b45b1bbc467f11b98ac using a merge, preserving evolved application code.
- Removed the obsolete historical STATUS paragraph claiming the server-only import was wrong. The later corrected entry and current server-only boundary stay.
- Parse the final nonempty JSONL buffer as a frame at EOF. Malformed final frames, events after completion, missing completion and nonzero exit still refuse. Both adapter fixtures pass without a final newline.
- Removed the approval-bypass switches, but do not claim native headless Ask support. Official MiniMax docs explicitly reject headless `--permission ask`; the initial Ask patch was withdrawn and its review thread reopened. Native exec now checks a trusted-launcher empty-tool inventory prerequisite before spawning. It defaults to unqualified and cannot be set by request JSON. This follows the review's alternative of verifying the empty-tool invariant before enabling exec. The prerequisite itself remains unqualified in production. Fixture tests opt in only for fixed local Python fixture programs; this is not an activation switch or evidence that an installed CLI has no tools.

Official sources: https://code.minimax.io/docs/cli/automation and https://code.minimax.io/docs/cli/security (headless smart/full/off, no Ask); https://dev.meta.ai/docs/muse-code/extending (headless approval boundaries). No default headless permission mode is treated as a no-tool guarantee.

Verification: 54 offline broker, replay, egress and exec tests pass on Python 3.12. Subprocesses in these tests run only Python fixture programs, never a model CLI.

## Findings still open

1. reasoningEffort: the broker now accepts exactly the documented string ladder and rejects malformed types/values and contributor max without silently clamping. Both serializers preserve the optional field, and the native argument builder emits the documented MiniMax `--effort` or Muse `--reasoning-effort` override. Absent effort produces no invented default. The final fixed native launcher is still missing: merely placing effort in prompt JSON is not an actual provider setting. Do not enable the opt-in or call end-to-end effort support qualified until the launcher applies these exact arguments and runtime behavior is checked. Protocol adapters refuse explicit effort before starting a subprocess until an observed effort-setting contract exists; they never silently ignore it.
2. Model IDs: the native builder now accepts exactly current client-catalog native IDs: MiniMax-M3.1-Flash and the three Muse contributor IDs. No Preview/base-tier aliases or retired models are substituted. Muse contributor models emit explicit contributor-mode on, not a hidden saved/default tier choice. Broker authorization still requires the exact per-adapter model in its configured allowlist. Updated JSONL fixtures are synthetic schema examples, not observations of installed/provider model availability. Current installed entitlement, exact protocol inventory and final launcher mapping remain unqualified.
3. Authentication: the review asks to replace a provider CLI login with an Infisical service token. Those are different principals and destinations. Current main docs/llm/code-cli-broker.md distinguishes the separate broker token from provider credentials and requires a dedicated non-root provider-authentication path. The source does not substitute a secret-store token for a provider credential. No credential is relocated and the finding is not dismissed; service-token requirements must be applied at their actual destination before activation.

The old README contains historical investigation reports, not fresh qualification. Missing auth renewal, final fixed launcher, disconnect cleanup, exact saved-login tools/output-cap proof and an approved bounded live test remain unfinished. The branch must stay a draft.

## Current contract evidence

Current source `src/lib/llm-model-catalog.ts` and `docs/llm/code-cli-broker.md` define the client IDs and effort ladder. The added `test_client_contract.py` checks exact catalog membership, no retired aliases/tier substitution, contributor max refusal, runner/serializer preservation and native argv forwarding. Official native flags were read at https://code.minimax.io/docs/cli/automation and https://dev.meta.ai/docs/muse-code/interactive . Explicit contributor per-run control was read at https://dev.meta.ai/docs/muse-code/subscriptions . These sources establish the staged argument contract, not installed-version entitlement or successful live generation.

Current exec cleanup regressions: stdout EOF with a still-live child maps its wait timeout to the fixed incomplete denial; cleanup wait timeout cannot replace the primary denial. Both post-terminal tests now append a structurally valid terminal event with the next valid sequence, not an independently malformed object. A temporary offline mutation removing the completion guard makes both tests fail. All54 offline tests pass; no provider process ran.
