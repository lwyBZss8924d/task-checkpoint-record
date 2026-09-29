> Package reference from `docs/configuration.md`. Run repository-relative examples from a selected source or release directory; installed CLI commands use the installed executable.

# One configuration for recorder, helper and native Codex

`task-checkpoint.config.v1` is the same portable JSON contract in both packages.
Keep one explicit file and pass it to either CLI. The standalone helper and the
combined distribution include the schema, examples and an embedded validator;
neither needs the other source checkout to load configuration.

```sh
task-checkpoint-record config init --file "$PWD/task-checkpoint.json"
task-checkpoint-record config check --config "$PWD/task-checkpoint.json"
task-checkpoint-record config schema
ultrafast-atif-helper config-check --config "$PWD/task-checkpoint.json"
```

Initialization creates a new mode-0600 file in an existing directory. It refuses
replacement. Checking validates configuration without creating state, reading a
credential, logging in or calling a provider. The default template leaves the
native executable and dedicated home null until the operator selects them.

## Fields and actual consumers

| Section | Fields | Consumer |
| --- | --- | --- |
| `recorder` | `state_dir`, `helper_command`, `concurrency`, `max_jobs`, `timeout_ms`, `lease_ms`, `page_bytes`, `page_limit`, `stdout_bytes` | Recorder state commands and explicit `service once/run/start` |
| `codex` | `executable`, `home`, optional `qualification_receipt`, `supervisor`, `semantic_worker`, `eval` | Explicit `auth` commands and configured native APIs; a pinned future version needs its verified receipt |
| `scoring` | `provider`, `model`, `api_key_env`, `limits` | Helper's explicit `prepare-score` / `score-prepared` workflow |
| `agent_service` | `execution_mode`, `runtime_update`, native-turn/worker/tool/round ceilings, deadline and prepared-data policy | Explicit native-agent activation and service commands |

The deterministic recorder worker extracts local metadata and does not launch a
model because a `codex` or `scoring` section exists. The optional native model API
and prepared-scoring CLI are explicit operations. The model role defaults are
supervisor `gpt-6-sol`/`medium`, semantic worker `gpt-6-luna`/`medium` and evaluation
`gpt-6-luna`/`high`.

```sh
task-checkpoint-record init --config "$PWD/task-checkpoint.json"
task-checkpoint-record service once --config "$PWD/task-checkpoint.json"
task-checkpoint-record query --config "$PWD/task-checkpoint.json" \
  --kind windows --fields window_id,coverage,deeplink --limit 20
```

Relative configuration paths resolve against the selected JSON file's directory,
independently of the invoking working directory. Absolute paths are accepted.
There is no `~`, `$VARIABLE` or parent-component expansion. A helper executable
without a slash resolves through the operator's existing PATH; an executable
with a slash resolves against the config directory. Remaining helper arguments
are literal argv strings, so use absolute file arguments when they name files.
Shell interpolation and `eval` are never used.

For recorder state, precedence is `--state`, the explicit config's resolved
`recorder.state_dir`, the legacy `TASK_CHECKPOINT_RECORD_STATE` variable, then an
error. Worker CLI options override corresponding config fields. Supplying
`--helper` or `--helper-arg` replaces the entire configured helper argv; when only
arguments are given, the configured executable remains selected. Detached service
startup materializes the effective settings into the child argv and does not
reload a later modified config. Existing behavior without `--config` remains
available. No conventional config path is searched automatically.

An optional `--config-sha256 SHA256` pins the exact bytes read by the recorder's
`--config` operation. The same bounded read is hashed before parsing; a mismatch
fails before state access. This lets a native Hook bind a reviewed configuration
without a separate check followed by an unverified reread. It is a byte digest,
so whitespace changes require a newly reviewed digest. A matching digest grants
no service, model or credential authority by itself.

Unknown fields, duplicate JSON keys, wrong types, unsupported versions/models,
inline credentials, endpoint overrides and fallback fields fail before use.
Configuration input is bounded to 64 KiB and must be a regular, unaliased file;
symlinks and credential-like names such as `.env` and `auth.json` are refused.
The recorder enforces `lease_ms > timeout_ms + 500`; parallel workers are bounded
to 32. `config check` does not prove executable availability, provider access or
native login. It reports environment variable names without reading their values.

## Native agent service policy

The optional `agent_service` section has finite defaults:

```json
{
  "execution_mode": "danger-full-access",
  "runtime_update": {
    "mode": "latest-stable",
    "root": null,
    "check_interval_ms": 14400000
  },
  "concurrency": 2,
  "max_workers": 2,
  "max_native_turns": 3,
  "max_tool_calls": 64,
  "deadline_ms": 180000,
  "max_rounds": 2,
  "data_policy": "metadata_only",
  "external_score_max_calls": 0
}
```

`execution_mode` controls the explicit native daemon's sandbox and defaults to
`danger-full-access` with approval policy `never`. An operator can select
`read-only`. The process config, thread request and each turn request use the
same mode; a returned thread policy mismatch stops before a turn. Native
App Server receives this policy through supported config/RPC fields, not TUI
shortcut flags. The scoped PTC tool registry and prepared-input boundaries still
apply. The standalone text API keeps its read-only default independently.

`runtime_update.mode` defaults to `latest-stable`. The managed directory defaults
to `<recorder.state_dir>/codex-runtime`; a non-null `root` is a literal config-relative
or absolute directory owned by this service. `check_interval_ms` defaults to four
hours and accepts one minute through one day. The first daemon cycle checks
latest after startup acknowledgement, then checks only between serialized cycles
at that interval. Active native calls keep their immutable versioned package.
New versions require official stable-release metadata, complete package identity,
paired executables, file inventory and the shipped protocol compatibility checks.
An update rotates only verified idle sessions and keeps task budgets and epoch
lineage. Latest-discovery/qualification failure stays visible as a stale/error
observation; it is not a claim that the latest runtime was adopted.

`runtime_update.mode:"pinned"` skips update discovery and uses the explicit
`codex.executable`. Its future version must also supply `codex.qualification_receipt`.
Configuration, status, auth and the standalone helper do not initiate updates.
`agent status` includes bounded `runtime_updates` observations with selection,
check time, latest-check status, stale state, failure and any adoption error.

For a first installation, initialize configuration, run an explicit update and
set `codex.executable` to the returned immutable selection before provisioning
the dedicated authentication home. Keep `codex.home` separate from ordinary
client profiles:

```sh
task-checkpoint-record runtime status --config "$PWD/task-checkpoint.json"
task-checkpoint-record runtime plan --config "$PWD/task-checkpoint.json"
task-checkpoint-record runtime update --config "$PWD/task-checkpoint.json"
# Set codex.executable to selection.executable, codex.qualification_receipt to
# selection.qualificationPath, and codex.home to the dedicated absolute home.
task-checkpoint-record auth plan --config "$PWD/task-checkpoint.json"
task-checkpoint-record auth setup --config "$PWD/task-checkpoint.json" --plan-sha256 REVIEWED_PLAN_SHA
task-checkpoint-record auth login --config "$PWD/task-checkpoint.json"
```

These runtime commands also accept `--root ABS_DIR` without a recorder database.
`status` reads local metadata only; `plan` discovers the official release without
installing it; `update` explicitly installs and qualifies it. None logs in or
launches a model. Latest-mode activation can leave `codex.executable` null after
the dedicated account is provisioned, because selection occurs before model work.
Existing authentication profiles are never rewritten by update or service startup.

An explicit rollback selects a retained, qualified version and holds it until
the operator resumes latest updates:

```sh
task-checkpoint-record runtime rollback --config "$PWD/task-checkpoint.json" --version RETAINED_VERSION
task-checkpoint-record runtime status --config "$PWD/task-checkpoint.json"
task-checkpoint-record runtime update --config "$PWD/task-checkpoint.json" --resume-latest true
```

The held state is reported as `held_not_latest`, not current/latest. The daemon
adopts a changed selection at a safe idle boundary, verifies old-session closure
and records a new linked epoch. It retains the same activation and consumed
budgets; rollback never retries a consumed or interrupted model operation.
Ordinary automatic checks and `runtime update` without `--resume-latest true`
preserve the explicit hold.

An activation freezes the resolved non-secret config, role models, task binding,
prepared admissions and policy digest. Editing the original JSON cannot change
that stored activation. `metadata_only` admits metadata to native model tools;
`prepared_fragments` additionally permits owner-prepared, digest-bound synthetic
or redacted fragments. Neither setting enables arbitrary RAW transport. A model
cannot declare its own input sanitized or authorize a provider request.

`max_native_turns` counts admitted native `turn/start` operations: one supervisor
turn plus bounded worker turns. It does not count or independently limit hidden
native HTTP retries or model requests made inside a turn for tool follow-up.
Concurrency must not exceed `max_workers`, and `max_workers + 1` must fit the
native-turn ceiling. Worker limits stop at 32, native turns at 33, tools at 256,
the per-round deadline at five minutes, and activation rounds at 32. Durable
activation totals derive from these finite per-round limits; an explicit retry
consumes the existing totals rather than resetting them.

External scoring defaults to zero. Enabling one external call requires a separate
owner-admitted prepared packet, exact selected provider/model, a reserved attempt,
and the selected key in the host process environment before activation or model
startup. The service retains only that selected credential for the explicit
scoring helper. Native Codex children, deterministic ETL helpers, stored snapshots,
arguments and receipts do not receive its value. A missing key or conflicting
provider selection fails explicitly. Hooks never read an `.env` file to recover a
missing key. Precomputed admitted results remain usable with zero external calls.

The standalone helper validates this section for shared-config compatibility; it
does not activate a native Codex service. See [agent-supervisor-plan.md](agent-supervisor-plan.md)
for the lifecycle and evidence boundaries.

Initialize the recorder state and bind a source through the existing commands,
then prepare an activation using `config/agent-activation.example.json` or the
machine-readable schema. Select the actual binding ID and a stable daemon ID:

```sh
task-checkpoint-record schema agent-activation
task-checkpoint-record agent activate --config "$PWD/task-checkpoint.json" \
  --file "$PWD/agent-activation.json"
task-checkpoint-record agent start --state /absolute/private/state --daemon example-daemon
task-checkpoint-record agent status --state /absolute/private/state
task-checkpoint-record agent jobs --state /absolute/private/state --limit 20
task-checkpoint-record agent verify --state /absolute/private/state --run RUN_ID
task-checkpoint-record agent resolve --state /absolute/private/state --link AGENT_TCR_LINK
task-checkpoint-record agent stop --state /absolute/private/state --daemon example-daemon
```

`activate` records authority and finite policy without starting a daemon or a
model. `include_existing_windows` defaults to false. `model_profile: "eval"`
explicitly selects `codex.eval` for both supervisor and workers; production uses
the two respective role settings. `agent run --state DIR --daemon ID` runs in
the foreground; adding `--once true` performs one bounded cycle and closes its
owned sessions. The native daemon also drains deterministic extraction only for
its activated bindings and eligible windows, so no separate extraction daemon is
required. Hook ingress queues work and never waits for a model or starts a
daemon. Starting the native service is an explicit operation.

Detached startup uses a private stdin acknowledgement. The child first registers
`waiting_for_ack`; it cannot perform extraction, helper calls or native model work
before the parent acknowledges that exact PID's fresh readiness record. A
pre-acknowledgement timeout closes and reaps only the owned child. Parent EOF or
an invalid nonce closes the waiting service. `--startup-timeout-ms` can bound the
parent wait from 1 to 5000 ms; the default is 2000 ms.

The `start_admitted` receipt requires observation of the same PID transitioning
to `running` after acknowledgement. If delivery or that transition is uncertain,
the result is `admitted_unknown` with the owned PID and no automatic retry. Work
may already have started in that case; inspect `agent status` and `agent jobs`.
Neither receipt is a claim that a task or checkpoint has completed.

The optional activation `objective` carries the master's task purpose, bounded to
4096 UTF-8 bytes. Its default asks for evidence-linked continuity guidance over
the activated window. It is frozen into policy and supplied to the supervisor;
changing the objective requires a new activation. Objective text cannot grant
additional source access, tools, credentials, scoring attempts or model budget.

A running daemon retains the set of immutable activations admitted at its start.
After adding an activation, stop and restart that daemon before expecting it to
perform native model work for the new admission. An activation's prepared packet has one reserved fresh
attempt across its lifetime, including later windows and explicit retries. A
precomputed packet uses `attempt_budget: 0` and a supplied verified result; a fresh
packet uses `attempt_budget: 1`, no result, and a positive external-call policy.
The current CLI accepts at most one packet per activation. It validates packet
hashes and provider/model binding before inspecting the selected key. A daemon
can retain only one selected provider/key namespace; conflicting admissions fail.

`agent retry --state DIR --run ID` is explicit and never resets activation totals;
up to three attempts remain bounded by the same total quotas. `agent cancel`
requests cancellation of one job. `agent deactivate --state DIR --activation ID`
disables an admission and requests cancellation of its owned work. `agent stop`
stops the selected service without deleting records or credentials.

Stop review is advisory by default. Explicit `stop.mode: "strict_once"` can
request one continuation only from an already completed, fresh review of the
same binding, native turn and observed source bounds. An eligible prior window
with equal bounds may supply the cache; changed bounds cannot. Pending, missing or stale reviews
never cause model waiting. Current Claude/Pi callback mappings lack a native
turn identity for this gate and remain advisory. `agent verify` also accepts
`--binding ID --window ID [--turn ID]` to inspect that cached state; an explicit
`--consume-strict true` consumes the one-shot guard. A proposal, digest check or
continuation request is not an owner's formal checkpoint or task acceptance.

## Provider keys and prepared scoring

The default OpenRouter profile is:

```json
{
  "provider": "openrouter",
  "model": "typesafe/jev-1.13-20260917",
  "api_key_env": "OPENROUTER_API_KEY",
  "limits": {
    "deadline_ms": 20000,
    "max_request_bytes": 65536,
    "max_response_bytes": 1048576
  }
}
```

This is the `scoring` section of the full config. For direct TypeSafe, initialize
with `--provider typesafe` or explicitly select `provider: "typesafe"`,
`model: "jev-1.13.0"`, `api_key_env: "TYPESAFE_API_KEY"`. Both templates are
included in `config/`. A custom key variable name may be selected, but the value
belongs only in the executing process environment supplied by the operator's
secret manager. Do not write API-key values into JSON, shell command arguments,
Git, model inputs or reports. The application does not load an `.env` file.
Credential references may use ordinary uppercase variable names. Runtime,
preload, profile and routing variables such as `BUN_OPTIONS`, `NODE_OPTIONS`,
`HOME`, `CODEX_HOME` and `HTTPS_PROXY` are rejected as key references.

Official launchers and the container run Bun with the package's canonical
`--config=ABSOLUTE_PATH`, `--no-env-file` and `--no-install`, and remove ambient
preload controls before the interpreter starts. Node's helper launcher does not
load dotenv. Use `bin/task-checkpoint-record` in a source checkout; bypassing the
launcher requires preserving those same boundaries. Configuration parsing itself
never reads credentials.

Prepare synthetic or deliberately redacted text separately. Preparation is local;
scoring is an explicit external request. The packet binds the selected provider
and model, which must agree with the same config at scoring time. No fallback to
another provider or account occurs. The routes are fixed in the helper provider
profiles; `jev-router` is not an allowed decision model.

```sh
ultrafast-atif-helper prepare-score --config "$PWD/task-checkpoint.json" \
  --input "$PWD/prepared-recipe.json" --allow-root "$PWD" \
  --output "$PWD/prepared-packet.json" --json
# Inject only the selected provider key through your process/secret manager.
ultrafast-atif-helper score-prepared --config "$PWD/task-checkpoint.json" \
  --input "$PWD/prepared-packet.json" --allow-root "$PWD" --json
```

Request deadlines, request bytes and response bytes can be reduced, up to hard
limits of 20 seconds, 64 KiB and 1 MiB. A probability is a retention suggestion,
not authorization to delete RAW or a calibrated quality score. Real trajectories
stay local unless an operator separately prepares and approves eligible content.
Neither installation nor `--help` makes a scoring request.

## Dedicated Codex profile and native model API

Edit only the non-secret locations in the same JSON file, for example
`codex.executable: "/absolute/path/to/codex"` and
`codex.home: "/absolute/dedicated/.codex-task-checkpoint-record"`. The native
executable must already be installed and the home's parent must exist. Review
the exact plan, then apply its SHA. Setup accepts an absent home or an existing
private empty directory; it never replaces a profile or copies credentials.

```sh
task-checkpoint-record auth plan --config "$PWD/task-checkpoint.json" > "$PWD/auth-plan.json"
# Inspect auth-plan.json, including config_text, locations and plan_sha256.
task-checkpoint-record auth setup --config "$PWD/task-checkpoint.json" \
  --plan-sha256 REVIEWED_PLAN_SHA256
task-checkpoint-record auth login --config "$PWD/task-checkpoint.json"
task-checkpoint-record auth status --config "$PWD/task-checkpoint.json"
```

`auth login` invokes the configured official CLI's `login --device-auth` with
explicit ChatGPT/file-store settings and dedicated `CODEX_HOME`. Its terminal is
inherited; the wrapper does not capture or save device codes, tokens or account
output. The official CLI owns persistent authentication and refresh. API keys and
parent native session variables are excluded from that child's environment.
Ordinary `.codex`, `.codex-test`, `.claude` and `.pi` homes, their ancestors,
descendants and aliases are rejected. An already provisioned dedicated profile
uses `auth login/status` directly; `auth setup` refuses to overwrite it.

The model section feeds the real adapter through the optional API:

```ts
import { loadConfig } from "../src/config.ts";
import { runConfiguredAppServerTask } from "../src/config-runtime.ts";

const config = loadConfig("/absolute/task-checkpoint.json");
const result = await runConfiguredAppServerTask(config, {
  cwd: "/absolute/prepared-job-directory",
  role: "eval", // consumes config.codex.eval
  input: { dataClass: "synthetic", text: "Return {\"ok\":true}." },
  outputSchema: { type: "object", additionalProperties: false,
    required: ["ok"], properties: { ok: { type: "boolean" } } },
  validateOutput(value) {
    if (!value || typeof value !== "object" || Object.keys(value).length !== 1 ||
        !("ok" in value) || typeof value.ok !== "boolean") throw Error("invalid output");
    return { ok: value.ok };
  },
});
```

This remains an explicit model call; the helper never consumes the Codex login
and the Codex adapter never consumes provider API keys. See
[app-server-runtime.md](app-server-runtime.md) for protocol and enforcement limits.
The included `scripts/config.sh` and `scripts/codex-auth.sh` are argv-only installed
CLI wrappers. They do not source files, enable shell tracing, or implement login.

For containers, `config/task-checkpoint.container.example.json` selects the
packaged Codex executable and separate persistent native/state volumes. Mount one
reviewed config and use the same `auth plan/setup/login/status` commands. Container
startup does not initialize authentication or start a service.
