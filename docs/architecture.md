# Recording and using task windows

The recorder is a local control plane. The helper parses explicitly selected
sources. Model adapters operate on separately prepared inputs. Native source
history and authentication remain owned by their original clients.

```mermaid
flowchart LR
  H[Native lifecycle callback] --> Q[Bounded durable enqueue]
  Q --> J[SQLite jobs and leases]
  S[Independent service or activated agent daemon] --> J
  J --> P[Local helper process]
  R[Immutable RAW or ATIF bytes] --> P
  P --> W[Window and record metadata]
  W --> D[Exact query and deeplink resolution]
  D --> K[Record and recall Skills]
  W --> A[Explicit activation and frozen snapshot]
  A --> C[Resident Codex supervisor]
  C --> B[Budgeted native workers]
  B --> T[Scoped helper PTC tools]
  T --> V[Cited reports and supervisor reduction]
  V --> G[Proposal and evidence graph]
  G --> D
```

SQLite is application storage with explicit correlation metadata. It is not an
OpenTelemetry collector or a standard OTel SQLite backend. Export, retention and
collector deployment retain separate interfaces and acceptance requirements.

## Native callbacks

The installed Codex release has short SessionEnd/Interrupt deadlines and cancels
unfinished asynchronous hooks when a session ends. Callback work therefore stops
at bounded local admission or cached reads; model work never runs in a callback.
Source acknowledgement, durable admission, extraction completion and a useful
checkpoint remain separate statuses.

Codex SessionStart/UserPromptSubmit can carry cached additionalContext. PostCompact
can trigger work, while SessionStart with compact source is the supported recall
injection point in the inspected release. Stop is a turn-completion hook. Its
default is advisory. Explicit `strict_once` can request one continuation from a
completed cached review with matching binding, native turn and source bounds.
An eligible prior window may satisfy those bounds; changed source bounds or
missing, pending or stale evidence cannot. The Hook never waits for a model.
Existing project/Goal gates keep their independent authority.

Explicit bindings select the master session, client/profile, task and source roots.
Observer/worker sessions are inert. Live binding begins at the current complete
record boundary by default; historical replay is explicit. Hook-time byte ceilings
prevent delayed workers from attributing future source bytes to an earlier window.
Native hooks without stable delivery IDs need source-cursor-aware coalescing;
identical callback text alone cannot distinguish later windows in the same turn.

## Jobs and service lifetime

The service is explicitly started, queried and stopped. Hooks never start it.
The deterministic worker pool defaults to two workers and is capped at 32. Leases
and generation tokens fence stale workers; retries are explicit and retain prior
errors. Queue and query limits are part of the interface rather than hidden prompt
assumptions. Measure callback latency under the intended load; asynchronous work
still consumes host resources and does not have zero cost.

The explicit agent daemon also drains extraction for its admitted bindings. Each
activation freezes a task objective, model profile, content admissions and finite
budgets, and owns a resident Codex App Server process/thread. Serial windows reuse
that supervisor. Each delegated worker owns a fresh process/thread, uses scoped
helper tools and cites persisted evidence before its report can be accepted.
The host reserves native turns, tool calls and external attempts before effects.

Proposals are immutable observations. Later session failures are appended as
health evidence and invalidate cached freshness. An unconfirmed process closure
continues to occupy its capacity slot. Native/provider attempts that lose their
lease remain interrupted or outcome-unknown; an explicit retry consumes the
same activation totals. Stop/deactivate propagates cancellation to model sessions,
tool callbacks and owned extraction helpers. The text-only prepared-input library
remains available independently of the resident service.

## Retrieval and continuity

Use stable record/window/event IDs and the selected store's deeplinks. Resolve the
metadata, then verify an explicitly authorized source slice before content access.
Do not follow arbitrary URI schemes, infer native IDs from filenames or equate
matching client-native, ATIF run/document and OTel strings.

Context packs are derived views. They retain source selectors and omissions,
protect call/result pairs and mandatory constraints, and leave original history
unchanged. A relevance or retention score is not a deletion proof or task reward.
Prepared external model inputs are synthetic or deliberately redacted; real RAW
and private dataset material stay local.

Formal task_turns_checkpoint events bind already sealed owner checkpoint and
lineage bytes. Imported event envelopes and observed windows do not independently
prove full schema validation, authentic source content or completed task acceptance.
Consumers inspect the recorded verification level before using a pointer.

Agent proposals expose `formal_owner_checkpoint: false` and
`task_acceptance: false`. Their deeplinks bind the selected window, immutable
snapshot, observed role-labelled native calls and exact helper result digests.
`agent verify` reports these relationships and current health; it does not replay
source bodies or grant access to a different task.

See [the agent service](agent-service.md), [helper interface](helper-protocol.md),
[resident runtime](agent-runtime.md), [prepared-input API](app-server-runtime.md)
and [dedicated authentication](authentication.md) for executable boundaries.
