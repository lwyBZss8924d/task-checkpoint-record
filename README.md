# Task Checkpoint Record

Record and recall the part of an agent conversation that belongs to one task.
The recorder binds an observed session to selected local source files, captures
bounded Hook windows, and stores verified metadata in private SQLite. Agents can
filter those windows and resolve stable `tcr://` pointers without loading a whole
conversation into their context.

The combined release contains **task-checkpoint-record and a pinned
ultrafast-atif-helper**. One installation provides both CLIs. The helper also has
an independent [source repository](https://github.com/lwyBZss8924d/ultrafast-atif-helper).

## What is available

- Local Codex, Claude, Pi and ATIF extraction through an explicit helper protocol.
- Durable Hook enqueue, leased extraction jobs, restart fencing and source cursors.
- Exact filters, field selection, pagination, checkpoint metadata and deeplinks.
- Explicit source/binding/native/ATIF/telemetry identities with unavailable fields
  retained as gaps. Original source bytes and literal ATIF versions stay intact.
- An explicitly activated resident Codex supervisor that delegates scoped helper
  tools to bounded workers, reduces their cited reports and records proposals.
- A dedicated persistent ChatGPT login, immutable model/budget policies and
  separate host-only Jev scoring for admitted synthetic or redacted packets.
- Automatic discovery and qualification of the latest stable Codex package for
  the dedicated daemon, with versioned installs and recorded update failures.
- Self-contained Skills, Codex and Claude plugins with native Hooks, Claude slash
  commands, source/release checks and containers.

Worker concurrency defaults to two and is capped at 32. Native worker fan-out
also obeys separate per-round and activation-wide budgets. Hooks enqueue work
and read completed cached reviews; they never wait for models. Stop is advisory
by default, with an explicit, once-per-turn continuation policy for fresh evidence.
Optional OTel fields store supplied trace correlation; collector/export deployment
is a separate integration.

## Install one bundle

Download the combined archive and its checksums from the
[releases page](https://github.com/lwyBZss8924d/task-checkpoint-record/releases).
Use an existing Bun 1.3.14+ and Node 18+ installation. Unpack into a new directory,
review `release-bundle.json`, and prepare an installation plan:

```sh
/usr/bin/env -u BUN_OPTIONS bun --no-env-file --no-install \
  --config="$PWD/config/runtime.bunfig.toml" scripts/install-cli.ts bundle-plan \
  --bundle-root /absolute/unpacked-release \
  --bundle-sha256 REVIEWED_RELEASE_MANIFEST_SHA256 \
  --prefix /absolute/existing/bin --stage /absolute/new-build-stage \
  --bun /absolute/runtime/bun --node /absolute/runtime/node \
  --output /absolute/new-install-plan.json
```

Review that plan before applying its printed digest. The
[installation guide](docs/installation.md) gives the apply, verify and rollback
commands, including development checkout installation. Installation does not
change PATH, log in, bind sources, activate native Hooks or start services.

```sh
task-checkpoint-record --help
task-checkpoint-record schema binding
ultrafast-atif-helper --help
```

For source development, install locked dependencies with
`bun install --frozen-lockfile`, then use `bin/task-checkpoint-record --help`.
The packaged launcher selects its own Bun configuration and excludes ambient
preload and dotenv settings before application code runs.

## Configure once

The two CLIs share `task-checkpoint.config.v1`: local recorder settings, a separate
Codex profile/model section, and an explicit Jev provider section. Start a new
configuration and check it locally:

```sh
task-checkpoint-record config init --file "$PWD/task-checkpoint.json"
task-checkpoint-record config check --config "$PWD/task-checkpoint.json"
ultrafast-atif-helper config-check --config "$PWD/task-checkpoint.json"
```

OpenRouter uses `OPENROUTER_API_KEY`; direct TypeSafe uses `TYPESAFE_API_KEY`.
Store only the selected variable name in configuration and inject the key through
your process or secret manager. Deterministic recording does not use either key.
The explicit `prepare-score` / `score-prepared` helper commands consume the same
configuration. There is no implicit provider fallback or RAW upload.

For native Codex, choose `codex.executable` and a new persistent dedicated
`codex.home`. Run `auth plan --config ...`, review the returned plan, then use
`auth setup --config ... --plan-sha256 ...` for a new profile. `auth login --config
...` invokes standard `codex login --device-auth`; `auth status --config ...`
checks an existing login. Existing profiles are preserved. See the
[configuration guide](docs/configuration.md) for templates, precedence, shell
wrappers and the configured App Server API. Container users retain separate
account and record-state volumes.

The activated daemon's execution mode is explicitly configured. Its unattended
default uses `approval_policy = "never"` and `sandbox_mode = "danger-full-access"`
through native configuration and matching thread/turn parameters. The standalone
prepared-input library retains its read-only default. App-server does not accept
the TUI's bypass flag directly. The helper tool scope, credential separation and
content admissions still apply independently of the native sandbox setting.

## Record and recall

Initialize an explicitly selected private state directory with `init --state
/absolute/private/state`. Prepare a binding from `schema binding`, choosing the
native client/profile/session, logical task and exact local source roots/files.
Apply it with `bind --state ... --file /absolute/binding.json`.

Live bindings default to the current complete-record EOF. Historical replay needs
an explicit `start_at: "beginning"`. Native Hook definitions use the separate
hash-bound plan/apply workflow and the client's native trust mechanism.

```sh
task-checkpoint-record service once --state /absolute/private/state \
  --helper /absolute/existing/bin/ultrafast-atif-helper --max-jobs 8
task-checkpoint-record query --state /absolute/private/state --kind windows \
  --filter task_id=SELECTED_TASK \
  --fields window_id,task_id,hook_turn_id,coverage,deeplink --limit 20
```

Use `service start` explicitly for a detached local worker, `service status` to
inspect it, and `service stop` for cooperative shutdown. Hook ingress is short and
model-free. `resolve --state ... --link tcr://...` returns store metadata; source
retrieval is a separate helper operation that verifies selected bytes.

## Agent workflows and models

For a long task, bind the exact source first, select `agent_service` in the shared
configuration, and prepare an admission from `schema agent-activation`:

```sh
task-checkpoint-record agent activate --config /absolute/task-checkpoint.json \
  --file /absolute/agent-activation.json
task-checkpoint-record agent start --state /absolute/private/state --daemon SELECTED_DAEMON
task-checkpoint-record agent jobs --state /absolute/private/state \
  --activation SELECTED_ACTIVATION --limit 20
task-checkpoint-record agent verify --state /absolute/private/state --run SELECTED_RUN
task-checkpoint-record agent resolve --state /absolute/private/state --link SELECTED_TCR_LINK
task-checkpoint-record agent stop --state /absolute/private/state --daemon SELECTED_DAEMON
```

Activation freezes the task objective, model profile, content policy and budgets.
The daemon extracts admitted windows, keeps one supervisor process/thread per
activation, and gives each worker exact scoped query/get/context-pack tools. A
valid report must cite recorded tool evidence. Proposals and their graph remain
intermediate; the task owner seals its formal checkpoint. The default native
content policy is metadata only. See the [agent service guide](docs/agent-service.md)
for recovery, lifecycle and evidence limits.

Latest-stable runtime management checks the official release, verifies the full
paired package and required protocol surface, and records the selected version
and executable digest. A running turn/fan-out keeps one selection. An update is
adopted at a safe idle boundary after the old owned session closes; failure retains
the last verified selection and reports that it could not adopt the latest.
See [runtime updates](docs/runtime-updates.md) for the CLI, update policy, image
automation and rollback. Authentication and host Codex installations stay separate.

Start from [llms.txt](llms.txt) and the
[record/recall Skill](skills/task-checkpoint-record/SKILL.md). The Skill can be
installed independently with:

```sh
npx skills add lwyBZss8924d/task-checkpoint-record --skill task-checkpoint-record
```

The [client plugins](docs/client-plugins.md) include seven Codex lifecycle events
or six Claude events, plus six Claude slash commands. They require explicit
configuration, enablement and native trust; install alone does not activate a
task. See [distribution](docs/distribution.md) for artifacts, CI, containers and
the combined helper payload. Pi package/extension adoption is tracked in the
[adapter roadmap](docs/adapters-roadmap.md).

The agent service and optional prepared-input `runAppServerTask`/`runSupervisor`
library use a dedicated Codex home and standard `codex login --device-auth`.
Production supervisor defaults to `gpt-6-sol`/`medium`, semantic workers to
`gpt-6-luna`/`medium`; the explicit eval profile uses `gpt-6-luna`/`high` for both.
See [authentication](docs/authentication.md), the [resident runtime](docs/agent-runtime.md)
and the [prepared-input API](docs/app-server-runtime.md).
No existing client credentials are copied. OpenRouter/Jev is a separate explicit
scoring route; it is not the provider for this native ChatGPT runtime.

## Develop and contribute

Read [AGENTS.md](AGENTS.md), [SPEC.md](SPEC.md) and
[architecture](docs/architecture.md). Relevant checks are:

```sh
bun run check
python3 scripts/distribution/test_package.py
python3 scripts/distribution/package.py check
```

The actual-helper integration suite accepts `TCR_HELPER_ENTRYPOINT` and
`TCR_HELPER_RUNTIME` for a built, explicit helper. Keep real RAW, account state,
SQLite files and private evaluation receipts outside public source. Public tests
use synthetic fixtures. A successful job is extraction evidence, not acceptance
of the master agent's task. Report coverage and unresolved source gaps.

MIT licensed. This independent community project is not an official OpenAI,
Harbor, NVIDIA or TypeSafe product. Platform program participation or directory
acceptance requires its own application and approval.
