# task-checkpoint-record

Task-checkpoint-record is a local side-observability service for long-running agent
tasks. Native hooks enqueue bounded metadata; independent workers inspect declared
local sources and persist queryable windows. Formal checkpoint events remain bound
to sealed owner checkpoints and lineage records.

## First release outcome

Provide a usable CLI, private SQLite event/job store, explicit task bindings,
bounded durable Hook ingress, independently owned worker lifecycle, exact retrieval
and deeplink resolution. Preserve the difference between native event observation,
durable enqueue, completed extraction, model review and task acceptance.

The store is application SQLite with OTel correlation fields, not an OpenTelemetry
standard storage backend. There is no implicit collector/export configuration.

## Interfaces and boundaries

- `task-checkpoint-record` exposes JSON CLI interfaces and a documented schema.
- Explicit native session/task bindings select profile, source root and policy.
- Hooks perform bounded local enqueue/read operations. They never wait for an LLM.
- A worker service has explicit start, status, drain and stop operations. Its
  lifetime is independent of a hook process or the source client's process group.
- Worker concurrency defaults to 2 and is bounded by 32. Deterministic parsing
  needs no model. Optional supervisor and semantic-worker models default to
  `gpt-6-sol`/`medium` and `gpt-6-luna`/`medium`, respectively; high reasoning is an
  explicit option and there is no silent model fallback.
- Native Codex App Server integration uses a real protocol adapter and explicit
  runtime/home/model bindings; starting that adapter is separate from source tests.
- Structured fields, exact filters, limits/cursors and query presets are the
  default PTC interface. Arbitrary writable SQL and automatic URI following are
  outside the query interface. Deeplinks resolve through this store's stable IDs.
- A task may have several observed windows in one native turn. Unavailable IDs
  stay unavailable; native, logical, ATIF and telemetry IDs remain distinct.
- Source transcript bytes are immutable inputs. Views and compaction suggestions
  are derived artifacts with provenance and declared omission/coverage.
- Real histories and derived datasets remain private/local. External Jev requests
  use explicitly prepared synthetic or deliberately redacted inputs only.

## Acceptance

Demonstrate duplicate delivery, restart/recovery, stale lease fencing, parallel
claims, partial JSONL tails, source rotation, bounded output, hostile path/SQL
inputs, recursion suppression and independent task/window filtering. Test the
native adapters against versioned source contracts and report real runtime probes
separately. Record latency measurements rather than calling the hot path free.

Do not install global hooks, trust definitions, start a persistent service or make
remote calls as a side effect of importing the package or invoking `--help`.
Publication contains source, protocols and synthetic fixtures; private runtime
records, profile locations and native session identifiers are excluded.
