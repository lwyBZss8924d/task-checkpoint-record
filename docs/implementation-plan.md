# Initial delivery plan

The first implementation connects durable record production to actual retrieval.
It builds on the existing task-provenance event contract rather than replacing it.

1. Pin the ATIF/native-hook/Jev source contracts and retain a compatibility matrix.
2. Implement local metadata ingress, task bindings, durable SQLite jobs/events and
   bounded CLI queries/deeplinks; integrate the standalone helper through an
   explicit JSON process contract.
3. Add worker leases, recovery and a concurrency cap. Provide explicit native
   activation, a resident supervisor, scoped helper tools, bounded worker fan-out
   and cited proposals with observed native receipts.
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
bounded query and deeplink resolution -> activated resident supervision ->
worker helper receipts -> cited intermediate proposal -> owner checkpoint.

SessionEnd and Interrupt use small synchronous enqueue operations. PostCompact
enqueues and returns the legal empty callback result. Cached recall is injected
only through native events whose supported contract admits context, including
SessionStart after compaction. Stop is advisory by default. An explicit
`strict_once` policy uses already completed, fresh native-turn/source-bound
evidence at most once; pending model analysis cannot supply an immediate decision.
Unbound observer/worker sessions are inert, preventing observation loops.

## Later milestones

Complete OTel export/collector integration, Windows descendant ownership,
simultaneous multi-activation native capacity at scale, broader semantic quality
evaluation and Pi package/extension adoption remain later milestones. Official
marketplace admission and program enrollment are external publication decisions.
The live two-worker contract and fake cap tests provide different evidence; neither
establishes 32-way live model capacity. See [adapter roadmap](adapters-roadmap.md).

## Integration contract to freeze before native adoption

Specify event schema, database schema, helper process request/response, source
allowlist, privacy/data class, supervisor/worker model policy, retry and timeout
budgets, lease ownership, failure handling, retained evidence and rollback. Keep
each operation's effect explicit in CLI help and machine-readable metadata.
