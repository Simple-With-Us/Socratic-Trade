# ST-5278 source remediation, November 18

Staging only. No provider process, login, model generation, listener, service, sandbox deployment or production setting was exercised or changed.

## Fixed offline

- Reconciled the preserved branch with current main b77fa8c6af858ec9faa56b45b1bbc467f11b98ac using a merge, preserving evolved application code.
- Removed the obsolete historical STATUS paragraph claiming the server-only import was wrong. The later corrected entry and current server-only boundary stay.
- Parse the final nonempty JSONL buffer as a frame at EOF. Malformed final frames, events after completion, missing completion and nonzero exit still refuse. Both adapter fixtures pass without a final newline.
- Generated native-exec arguments retain explicit Ask approval mode. The old MiniMax permission-off and Muse never/approval-judge-off flags are removed. This is an offline argument contract fix, not proof that an installed CLI enforces the gate. Pre-execution tool isolation and the observed empty-tool inventory remain activation requirements.

Verification: 43 offline broker, replay, egress and exec tests pass on Python 3.12. Subprocesses in these tests run only Python fixture programs, never a model CLI.

## Findings still open

1. reasoningEffort: current main's contract requires accepting and honoring a documented ladder, not merely putting an ignored field in a prompt. This historical adapter has no verified native effort-setting contract. Do not enable the opt-in or mark it implemented until exact CLI/protocol support is grounded and tested end to end.
2. Model IDs: current main's catalog uses MiniMax-M3.1-Flash and Muse contributor models, while these historical fixtures pin Preview and retired Spark. Do not silently map different model/tier identities, replace requested models with defaults or rewrite a fixture to claim real installed support. An explicit verified provider model inventory and exact mapping are needed.
3. Authentication: the review asks to replace a provider CLI login with an Infisical service token. Those are different principals and destinations. Current main docs/llm/code-cli-broker.md distinguishes the separate broker token from provider credentials and requires a dedicated non-root provider-authentication path. The source does not substitute a secret-store token for a provider credential. No credential is relocated and the finding is not dismissed; service-token requirements must be applied at their actual destination before activation.

The old README contains historical investigation reports, not fresh qualification. Missing auth renewal, final fixed launcher, disconnect cleanup, exact saved-login tools/output-cap proof and an approved bounded live test remain unfinished. The branch must stay a draft.
