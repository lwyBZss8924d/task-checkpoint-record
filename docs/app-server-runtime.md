# Optional Codex model runtime

The deterministic recorder and retrieval paths do not need a model. A record-service
worker may explicitly call `runAppServerTask` or `runSupervisor` from
`src/appserver.ts` for prepared synthetic or deliberately redacted text. A Hook
must never call this API directly or wait for its response.

Each call owns one `codex app-server --stdio --strict-config` child, one fresh
**persisted** thread, and one turn. Persistent authentication and model-job RAW stay
in the selected dedicated Codex home. The record service owns the child's lifetime
independently of the master Hook; v0.1 does not install the official Codex daemon,
bootstrap a Codex package, reuse a resident model process, or resume another job's
thread. Source tests use a fake stdio executable and temporary dedicated homes.

## Model and data contract

| Role | Default model | Reasoning effort |
| --- | --- | --- |
| Supervisor | `gpt-6-sol` | `medium` |
| Semantic worker | `gpt-6-luna` | `medium` |
| Live tests and evals | `gpt-6-luna` | `high` |

An explicit `selection` may choose either listed model and `medium` or `high`.
There is no adapter retry or model fallback. The adapter checks the native model
catalog, sends `allowProviderModelFallback: false`, and rejects a thread response
with different model or effort. These observations describe selected thread
configuration, not independently measured per-token backend execution.

The optional `usage` field preserves the last observed native
`tokenUsage.last` snapshot. It does not establish cumulative thread, turn or
provider-billing totals. Preserve that scope when exporting or aggregating
receipts; cached-input and reasoning-output fields are subsets, not extra tokens.

`dataClass` must be `synthetic` or `redacted`. This is a caller assertion, not a
redaction algorithm. The preparation/approval boundary must establish it before
calling the adapter; labelling private RAW as `redacted` does not sanitize it.
No RAW paths are loaded by this API. There is no native file-input, attachment,
remote-URL fetching, or generated validator execution.

```ts
import { runAppServerTask } from "../src/appserver.ts";

const receipt = await runAppServerTask({
  codexExecutable: "/absolute/path/to/codex",
  codexHome: "/absolute/dedicated/.codex-task-checkpoint-record",
  cwd: "/absolute/prepared-job-directory",
  role: "eval", // Explicit gpt-6-luna/high
  input: { dataClass: "synthetic", text: "Synthetic example: return {\"ok\":true}." },
  outputSchema: {
    type: "object", additionalProperties: false,
    required: ["ok"], properties: { ok: { type: "boolean" } },
  },
  validateOutput(value) {
    if (!value || typeof value !== "object" || Object.keys(value).length !== 1 ||
        !("ok" in value) || typeof value.ok !== "boolean") throw Error("invalid output");
    return { ok: value.ok };
  },
  limits: { deadlineMs: 120_000, maxInputBytes: 32_768, maxOutputBytes: 32_768 },
  signal: new AbortController().signal,
});
```

The native `outputSchema` request and the required caller-owned validator are
both used. A non-JSON, missing, oversized, conflicting, or invalid final answer
fails the job. Only an `agentMessage` with phase `final_answer` supplies output.
Commentary, reasoning summaries/deltas, raw response items, account details,
untrusted RPC error text and stderr content are not returned or persisted by the
adapter. The native Codex runtime can still persist its own RAW privately.

## Dedicated home and device login

For local development, tests, evals and formal use, select
`~/.codex-task-checkpoint-record`. Community users select their own dedicated home.
The adapter requires explicit absolute executable, home and cwd paths. It resolves
home aliases and rejects the user's ordinary `.codex`, `.codex-test`, `.claude`
and `.pi` homes and their descendants/ancestors. It does not create the directory,
read or copy credentials, alter another profile, install a service, or log in.

`dedicatedConfigText()` in `src/model-policy.ts` returns the complete reviewable
minimal profile. Render it to a candidate file before provisioning; do not
overwrite an existing profile. It selects file-backed ChatGPT auth, the default
supervisor model, restricted tool settings, disabled Hooks, and disabled export.
The profile belongs to the operator and remains persistent across process exits.

After provisioning the reviewed candidate with a private directory and file mode,
the operator runs the standard CLI flow using the same executable and home:

```sh
CODEX_HOME="$HOME/.codex-task-checkpoint-record" /absolute/path/to/codex login --device-auth
CODEX_HOME="$HOME/.codex-task-checkpoint-record" /absolute/path/to/codex login status
```

Complete the sign-in in the trusted authentication page. Do not put device codes,
tokens, credentials or account email in repository fixtures or receipts. The
adapter calls `account/read` after initialization, requires managed `chatgpt`
authentication, discards account details, and reports the bounded error
`dedicated_chatgpt_login_required` if unavailable. It never falls back to an
inherited API key, another profile or an interactive auth ceremony.

Doctor/review sequence before the first native probe:

1. Check the explicitly selected executable with `codex --version`; the adapter
   accepts exactly `0.157.1` and `0.158.0`. Generate that binary's schema with
   `codex app-server generate-json-schema --experimental --out <temporary-dir>`
   for a version upgrade review. This is an offline schema operation.
2. Render and inspect `dedicatedConfigText()`; provision only the dedicated home
   and a prepared job cwd. Verify intended file ownership/permissions. No PATH
   migration or global Hooks installation is part of this adapter.
3. Complete device authentication and run `login status` in that home. Login
   presence alone is not proof of model access.
4. Run one explicit synthetic `role: "eval"` call. Inspect the returned model,
   separate native session/thread/turn IDs, final validated answer, usage and
   process-close receipt. A successful fake-server test is not this native probe.

## Supported release contracts

The supported-version set is explicit in `src/model-policy.ts`. The adapter reads
the build version from the leading native `initialize.userAgent` product token,
rejects unknown and prerelease versions before auth/thread requests, and returns
the observed value as `runtime.protocolVersion` (`codex-0.157.1` or
`codex-0.158.0`). A supported version mentioned only in a later user-agent suffix
does not qualify an unsupported build.

The OSS/Docker package targets the official stable
[Codex 0.158.0 release](https://github.com/openai/codex/releases/tag/rust-v0.158.0).
Use its complete platform package and verify the release asset checksum and
`codex-package.json` before execution. That manifest identifies the version,
platform target and `bin/codex` entrypoint; the full package also supplies the
matching code-mode host. The adapter still disables code mode by policy.

Offline verification of the official 0.158.0 full macOS arm64 package checked
its GitHub asset SHA-256, manifest, executable version, App Server help and
binary-generated experimental schemas. Fourteen adapter-facing schema types were
compared with 0.157.1. Their top-level fields and required sets are unchanged;
the changed nested definitions only add `flexUnavailable` error information and
the `promax` plan label. Neither changes the adapter's selected account/model or
final-output contract. The existing minimal configuration also validates against
the version-tagged 0.158.0 configuration schema.

This compatibility evidence is source/offline-contract inspection plus fake-stdio
tests for both versions. Native model probes, container execution and authenticated
account access are separate receipts; an offline schema comparison does not prove
them. Supporting the packaged release does not replace the host Codex executable
or modify existing runtime profiles.

## Actual enforcement and limits

The adapter completes `initialize` -> response -> `initialized` before other RPCs.
It negotiates experimental APIs because both thread and turn explicitly set
`environments: []`, removing environment-backed shell/file/image tools in the
inspected native source. It supplies no dynamic tools or capability roots.
Supported settings disable shell, apps/plugins, multi-agent, code mode, web search,
Hooks, memories, goals, image/browser/computer use, plan/user-input features,
automatic skill instructions and host skill discovery. Project instruction byte
allowance is zero. Approval policy is `never`, reviewer is `user`, sandbox is
`read-only` with network disabled for sandboxed tools. The child inherits a small
OS/proxy environment allowlist; model credential environment variables and parent
Codex identity variables are not inherited.

**This is not a verified universal no-tools mode.** The native public protocol
does not expose Rust's internal `ToolPolicy.allowed_tools=[]` ceiling. Catalog
driven utility tools may still exist. Every server-initiated request (including
approvals, elicitation, token-refresh and dynamic tools) receives an error and
fails the job; observed tool/unexpected items also fail it. Detection of an item
is not proof that an action was prevented before execution. Neither `read-only`
nor `dynamicTools: []` alone disables all native tools.

The adapter has no request/turn retry. It disables unbounded native connection
retries, but bounded native transport retries inside a turn remain a Codex
behavior. The inspected source ignores overrides of built-in `openai` provider
retry fields, so the profile does not advertise ineffective zero-retry settings.
There is no implicit external plugin/gateway/OTel collector activation. Disabled
export settings govern this profile; the application SQLite store is not an OTel
backend.

Defaults: 120-second turn deadline; 32 KiB prepared text and final output; 2 MiB
total wire input; 256 KiB per JSONL line; 64 KiB stderr; at most four model-catalog
pages. Hard maximums and types are checked before launch. The deadline covers
handshake/auth/catalog/thread/turn processing, followed by bounded shutdown.
Partial JSONL is buffered within the line cap. Only matching thread and turn
notifications enter a result; completion arriving before the `turn/start` response
is correlated after the returned turn ID is known.

Timeout, caller abort or failure sends best-effort `turn/interrupt` only when the
owned thread and turn were observed, then closes stdin. Shutdown waits 250 ms,
then signals only the child-owned process group on POSIX (child PID on Windows),
with bounded TERM/KILL escalation. No process-name search, global cleanup or
unrelated-session interruption occurs. A successful result requires process
closure. Windows descendant cleanup is not guaranteed by v0.1.

Native session, thread and turn IDs are separate values; absent session ID stays
null. A returned rollout path is accepted only under the selected home's
`sessions` subtree with `.jsonl` suffix. The adapter may check directory/file
types without reading content, and distinguishes `observed_not_verified` from
`regular_file_verified`. `contentBindingVerified` remains false: use the separate
lineage verifier for a bounded digest-and-identity binding. A path, native ID or
successful model answer does not establish task acceptance or resume authority.

## Inspected contracts

- [Official App Server documentation](https://learn.chatgpt.com/docs/app-server)
  for the handshake, RPC lifecycle, auth, model discovery and output schema.
- [Official CLI login reference](https://learn.chatgpt.com/docs/developer-commands#codex-login)
  for standard device authentication and login status.
- Installed `codex-cli 0.157.1` help and its generated experimental JSON schemas,
  inspected offline on 2026-09-28. The binary schema includes
  `allowProviderModelFallback`; the source checkout's generated TypeScript
  snapshot did not, so the installed binary schema takes precedence.
- Official `rust-v0.158.0` full-package help/schemas and version-tagged source,
  inspected offline on 2026-09-28. The macOS arm64 archive SHA-256 is
  `09f2a9fde318fbcd384f15b4850c1b90930678f4805647b6bded196ccf32f590`,
  verified against [official release metadata](https://api.github.com/repos/openai/codex/releases/tags/rust-v0.158.0).
- Codex source revision `1cc7e2361237ce7244430ee1d581c77f95c57ac8`:
  `codex-rs/core/config.schema.json`,
  `core/src/tools/spec_plan.rs`,
  `app-server-protocol/src/protocol/v2/thread.rs`, and
  `model-provider-info/src/lib.rs`. This is source-contract inspection, not a
  runtime enforcement receipt.
