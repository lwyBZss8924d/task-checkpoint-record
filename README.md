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
- A separate, explicit Codex App Server API for prepared synthetic or redacted
  model jobs using a dedicated persistent ChatGPT login.
- Package Skills, Codex plugin manifests, source/release checks and containers.

The worker defaults to two deterministic jobs and caps concurrency at 32. This
version does not claim a resident multi-agent model supervisor, automatic model
worker spawning, a synchronous Stop review gate, or an OpenTelemetry collector.
Optional OTel fields store explicitly supplied trace correlation.

## Install one bundle

Download the combined archive and its checksums from the
[releases page](https://github.com/lwyBZss8924d/task-checkpoint-record/releases).
Use an existing Bun 1.3.14+ and Node 18+ installation. Unpack into a new directory,
review `release-bundle.json`, and prepare an installation plan:

```sh
bun scripts/install-cli.ts bundle-plan \
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
`bun install --frozen-lockfile`, then use `bun --no-env-file src/cli.ts --help`.

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

Start from [llms.txt](llms.txt) and the
[record/recall Skill](skills/task-checkpoint-record/SKILL.md). The Skill can be
installed independently with:

```sh
npx skills add lwyBZss8924d/task-checkpoint-record --skill task-checkpoint-record
```

Plugin manifests expose these workflows. CLI installation and native activation
remain explicit. See [distribution](docs/distribution.md) for plugin artifacts,
CI, containers and the combined helper payload.

The optional `runAppServerTask`/`runSupervisor` library uses a dedicated Codex home
and the standard `codex login --device-auth` flow. Production supervisor defaults
to `gpt-6-sol`/`medium`; live evals use `gpt-6-luna`/`high`. See
[authentication](docs/authentication.md) and [runtime contract](docs/app-server-runtime.md).
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
