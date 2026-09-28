> Package reference from `docs/implementation-plan.md`. Run repository-relative examples from a selected source or release directory; installed CLI commands use the installed executable.

# Initial delivery plan

The first implementation connects durable record production to actual retrieval.
It builds on the existing task-provenance event contract rather than replacing it.

1. Pin the ATIF/native-hook/Jev source contracts and retain a compatibility matrix.
2. Implement local metadata ingress, task bindings, durable SQLite jobs/events and
   bounded CLI queries/deeplinks; integrate the standalone helper through an
   explicit JSON process contract.
3. Add worker leases, recovery and a concurrency cap. Provide an explicit Codex
   App Server adapter for optional semantic review with observed native receipts.
4. Add source-owned Skills for record/recall and data preparation; test realistic
   CLI use on isolated synthetic fixtures before global discovery registration.
5. Prepare exact CLI installation, Hook definitions and service lifecycle plans.
   Apply authorized effects through their owners, retaining native trust and
   source/runtime acceptance states separately.
6. Validate a small local history cohort and a synthetic-only Jev probe. Evaluate
   exact retrieval and compaction invariants before any quality/performance claim.
7. Publish reviewed public-safe repositories, record immutable checkpoints and Git
   PoUW, verify notes and scoped backups, and leave exact next-stage criteria.

## Runtime shape

Native lifecycle callback -> bounded durable enqueue -> explicit worker claim ->
local parser/normalizer -> immutable window evidence -> SQLite metadata view ->
bounded query and deeplink resolution -> optional prepared semantic review.

SessionEnd and Interrupt use small synchronous enqueue operations. PostCompact
enqueues and returns the legal empty callback result. Cached recall is injected
only through native events whose supported contract admits context, including
SessionStart after compaction. Stop is advisory in this release; asynchronous
analysis cannot supply a synchronous blocking decision. A future strict gate
needs an explicit binding, deadline and recursion-safe completion contract.
Unbound observer/worker sessions are inert, preventing observation loops.

## Later milestones

The optional App Server API currently owns a fresh persisted thread/process per
prepared model job. A resident multiplexed model supervisor, model-agent fan-out,
automatic checkpoint review, complete OTel export, Windows descendant ownership
and native Pi runtime-wrapper adoption remain later milestones. Each requires its
own bounded runtime evaluation; the deterministic worker's concurrency cap does
not establish these features.

## Integration contract to freeze before native adoption

Specify event schema, database schema, helper process request/response, source
allowlist, privacy/data class, supervisor/worker model policy, retry and timeout
budgets, lease ownership, failure handling, retained evidence and rollback. Keep
each operation's effect explicit in CLI help and machine-readable metadata.
