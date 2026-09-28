---
name: task-checkpoint-record
description: Record an explicitly selected long-running agent task or recall its local checkpoint windows through the task-checkpoint-record CLI, exact filters, and verified deeplinks.
---

# Task Checkpoint Record

Use the installed `task-checkpoint-record` CLI, or the package's `bin/` entrypoint.
Read `--help` and `schema binding|query` when the current interface is not known.
The selected state directory, binding and task establish scope; a pointer does not
authorize another Goal or source access.

## Recall and handoff

Inspect existing state with `service status`; a query does not need initialization
or service startup. Select the task before filtering by a native turn, because one
turn can contain several logical tasks. Keep a record's own native IDs separate
from a window's Hook/binding identity and from ATIF or telemetry IDs.

```sh
task-checkpoint-record query --state /absolute/private/state --kind windows \
  --filter task_id=SELECTED_TASK \
  --fields window_id,task_id,hook_turn_id,coverage,deeplink --limit 20
```

Follow `next_offset` only when needed. Resolve a selected `tcr://` link with
`resolve --state ... --link ... --fields ...`; resolution returns metadata and
does not open arbitrary URLs or RAW. Query records in that exact window next.
Use the helper's verified retrieval only for an authorized source slice and an
explicit content need. Changed bytes, missing sources and unavailable IDs remain
gaps; do not substitute similarly named or moving latest records.

For imported checkpoints inspect `validation_level` and `validation_caveat`.
Envelope/binding import does not establish full schema or artifact verification.
An extraction job's completion is not completion of the master task.

## Record a selected task

Use `init` only for a chosen new private state directory. Prepare a binding from
`schema binding` with observed native session/client/profile, a stable logical task
ID and exact local source roots/files. Live sources default to `start_at: new` at
the current complete-record boundary. Use `beginning` only for an explicit
historical replay, with that purpose recorded. Missing earlier context stays a gap.

Apply the binding with `bind --file ...`. A disabled immutable binding is not
silently resumed; use a new binding identity for a newly authorized observation.
Start the independent worker explicitly through `service start` or perform a
bounded `service once`. Concurrency defaults to two and is capped at 32; the CLI
cap describes deterministic workers, not 32 independently proven model agents.
Inspect job/error states before retrying one exact job. Stop and unbind only the
selected work; preserve recorded evidence.

Hook installation follows the package's exact plan/apply/verify front door and
the native client's trust flow. Hooks enqueue or read cached metadata and never
start a model or daemon implicitly. Observer/worker sessions are inert. v0.1 Stop
is advisory; do not describe asynchronous analysis as a synchronous gate.

## Optional model work

The Codex adapter uses a dedicated persistent home and standard device-auth.
Production supervisor defaults to gpt-6-sol/medium; live evals use gpt-6-luna/high.
Model input must be separately prepared synthetic or deliberately redacted text.
Do not send real RAW merely because a record contains a local path or a score.
Keep native model/transport receipts separate from record, review and task
acceptance. No silent account/model fallback.

## Configure a standalone or combined installation

Use one explicit `task-checkpoint.config.v1` JSON file for the recorder and helper.
`config schema` describes its recorder, codex and scoring sections. Create a new
template with `config init --file /absolute/new-config.json --provider openrouter`
(or `typesafe`), edit the selected paths and settings, then run
`config check --config /absolute/new-config.json`. The check is local; it does not
prove credentials, model access or a running worker. Supply `--config` explicitly
to operations that consume it. Do not assume a config change restarts a service.

Provider configuration holds an environment-variable name, never an API key.
Default names are `OPENROUTER_API_KEY` and `TYPESAFE_API_KEY`. Inject only the chosen
secret through the user's selected environment/secret manager. Do not ask for a
key in chat, put one in command arguments, or silently load an arbitrary `.env`.
The helper's explicit `score-prepared` operation uses the same configuration and
separately prepared synthetic/redacted input. No provider fallback is implied.

For Codex, set `codex.executable` and an independent persistent `codex.home`.
Preview `auth plan --config ...`; review its profile and digest. Only for a new
profile run `auth setup --config ... --plan-sha256 REVIEWED_SHA`. Existing homes
and ordinary client profiles are preserved. Then run `auth login --config ...`
for the official device-auth flow; the user completes the one-time browser code.
Run `auth status --config ...` to check login. Never copy another client's auth
file, persist device codes, or call a successful login a completed model probe.
Keep the dedicated home/volume across process or container replacement.

The Skill's bundled [configuration guide](references/docs/configuration.md),
[authentication guide](references/docs/authentication.md),
[architecture](references/docs/architecture.md),
[installation](references/docs/installation.md) and
[model runtime](references/docs/app-server-runtime.md) are available even when
this Skill folder is installed separately. Select only the needed guide. Installing
a Skill supplies instructions; it does not install its CLI or activate a service.
