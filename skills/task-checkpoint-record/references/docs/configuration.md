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
| `codex` | `executable`, `home`, `supervisor`, `semantic_worker`, `eval` | Explicit `auth` commands and `configuredAppServerOptions` / `runConfiguredAppServerTask` API |
| `scoring` | `provider`, `model`, `api_key_env`, `limits` | Helper's explicit `prepare-score` / `score-prepared` workflow |

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

Unknown fields, duplicate JSON keys, wrong types, unsupported versions/models,
inline credentials, endpoint overrides and fallback fields fail before use.
Configuration input is bounded to 64 KiB and must be a regular, unaliased file;
symlinks and credential-like names such as `.env` and `auth.json` are refused.
The recorder enforces `lease_ms > timeout_ms + 500`; parallel workers are bounded
to 32. `config check` does not prove executable availability, provider access or
native login. It reports environment variable names without reading their values.

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

Official launchers and the container run Bun with `--no-env-file`; Node's helper
launcher does not load dotenv. A caller bypassing these launchers must preserve
that boundary, for example `bun --no-env-file src/cli.ts …`. Runtime preload
options or an operator-provided shell can still inject environment variables;
configuration parsing itself never reads credentials.

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
