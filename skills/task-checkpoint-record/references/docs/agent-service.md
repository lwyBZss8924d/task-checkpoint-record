> Package reference from `docs/agent-service.md`. Run repository-relative examples from a selected source or release directory; installed CLI commands use the installed executable.

# Activate, observe and recall a long task

The `agent` service adds a resident Codex supervisor to the recorder's local
extraction queue. The master selects its task and starts observation explicitly.
Native callbacks stay short: they record a bounded window, wake an admitted
daemon and return cached context when the client's event supports it.

## Select configuration and authority

Use one checked `task-checkpoint.config.v1` file. Set the recorder state/helper
locations and an independent persistent Codex home. Provision that home with
`auth plan`, reviewed `auth setup`, then standard `auth login` device-auth.
An existing dedicated login needs only `auth status`. The service never copies
credentials from the master client's profile. See [configuration](configuration.md)
and [authentication](authentication.md).

Initialize private state and bind an observed master session to the exact source
files. `start_at: "new"` begins at the complete-record EOF; historical extraction
requires explicit `"beginning"`. Read `schema binding` for the actual contract.

Enable the `agent_service` configuration section. Its defaults are two workers,
three native turns per round, two rounds, 64 tool calls and a 180-second round
deadline. The separate external scoring budget is zero. Production uses
`gpt-6-sol`/`medium` for the supervisor and `gpt-6-luna`/`medium` for workers;
`model_profile: "eval"` selects configured `gpt-6-luna`/`high` for both.

Prepare the admission using [the example](../config/agent-activation.example.json)
and `schema agent-activation`. Choose stable activation/binding/daemon IDs and a
bounded task objective. The objective guides analysis; it cannot grant tools,
source paths, more budget or permission to transmit content. Activation freezes
the resolved config and policy. Editing a config file cannot alter an activation.

```sh
task-checkpoint-record config check --config /absolute/task-checkpoint.json
task-checkpoint-record schema agent-activation
task-checkpoint-record agent activate --config /absolute/task-checkpoint.json \
  --file /absolute/agent-activation.json
task-checkpoint-record agent start --state /absolute/private/state --daemon SELECTED_DAEMON
task-checkpoint-record agent status --state /absolute/private/state
```

Activation alone does not launch a model. The detached child waits for a private
parent acknowledgement before doing work. `start_admitted` means the parent
observed its own PID transition to running; `admitted_unknown` means admission
may have occurred and requires inspection without automatic retry. A daemon
retains its startup activation set. Stop/restart it after adding another admission.

## Follow a window and its evidence

After all selected extraction jobs succeed, the host freezes a ready window.
The supervisor may delegate one bounded fan-out. Each worker must make a
successful scoped helper call and cite its stored result. The supervisor reduces
those reports in the same native turn. The next window reuses the resident
supervisor process/thread; workers receive fresh owned sessions.

```sh
task-checkpoint-record agent jobs --state /absolute/private/state \
  --activation SELECTED_ACTIVATION --limit 20
task-checkpoint-record agent verify --state /absolute/private/state --run SELECTED_RUN
task-checkpoint-record agent resolve --state /absolute/private/state \
  --link SELECTED_TCR_LINK --fields proposal_id,window_id,reduction.summary
```

Use returned IDs and `next_offset`; do not guess URI paths or load an entire
history. Proposal, evidence and run links resolve through the selected store.
Native thread/turn IDs, logical worker keys, source-native IDs, ATIF steps and OTel
correlation remain distinct. An unavailable ID remains unavailable.

Proposals are intermediate: `formal_owner_checkpoint` and `task_acceptance` are
false. The owner reviews actual results and seals its own checkpoint and lineage.
`agent verify` checks stored relationships and current session health; it does
not attest unseen source content, replay a tool or decide business completion.

## Content and scoring

Metadata-only is the default native model policy. Worker tools expose bounded
query/get/context-pack operations over issued opaque handles. Host-only selectors
retain exact paths, byte ranges and digests. Model arguments cannot add paths,
arbitrary URLs, SQL or environment-variable names.

Prepared fragments require explicit synthetic/redacted admission and exact
digests. Owner-selected RAW transport is not enabled by this CLI. For optional
Jev scoring, first prepare and validate a separate packet with the contained
`ultrafast-atif-helper`. A fresh packet has one reserved attempt per activation;
later rounds and explicit retries do not reset it. Precomputed admitted results
use zero external calls. Only the scoring helper receives the selected provider
key; Codex and ordinary extraction helpers do not. Provider errors never trigger
silent fallback. See [configuration](configuration.md).

## Stop, cancel and recover

```sh
task-checkpoint-record agent cancel --state /absolute/private/state --run SELECTED_RUN
task-checkpoint-record agent retry --state /absolute/private/state --run SELECTED_RUN
task-checkpoint-record agent deactivate --state /absolute/private/state --activation SELECTED_ACTIVATION
task-checkpoint-record agent stop --state /absolute/private/state --daemon SELECTED_DAEMON
```

Select the appropriate operation after inspecting the failed run. Retry creates
a new attempt while preserving errors and consuming the same activation totals.
An expired lease after a native/provider attempt is interrupted or outcome-unknown,
never silently replayed. Cancellation reaches owned helpers and native sessions.
An uncertain closure retains its capacity slot. A later health observation can
invalidate cached review freshness without changing the earlier proposal.

Stop Hooks read cached evidence. Advisory is the default. Explicit `strict_once`
can request one continuation for a fresh completed review with matching binding,
native turn and source bounds, including a prior window with equal bounds. Missing,
pending, changed or stale evidence returns without waiting on models. Claude/Pi
currently lack the native turn mapping required by this strict gate and remain
advisory. Existing master task gates keep their own authority.

For lifecycle adapters use [client plugins](client-plugins.md). Exact native
transport restrictions and late-error limitations are in
[agent-runtime.md](agent-runtime.md); the full implementation contract is
[agent-supervisor-plan.md](agent-supervisor-plan.md).
