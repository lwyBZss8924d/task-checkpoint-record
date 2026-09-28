# task-checkpoint-record

Complete the selected task through implementation, proportionate validation and
delivery. Read [SPEC.md](SPEC.md) and use [llms.txt](llms.txt) to choose one source.
Preserve unrelated work and independent source owners.

The recorder owns durable metadata, bindings, jobs, windows and its optional Codex
adapter. The helper owns extraction and source verification. Keep the protocol in
`docs/helper-protocol.md` explicit. Native session/turn IDs, ATIF identities,
logical tasks and OTel correlation are distinct; record absent evidence as absent.

Use `bun run typecheck` and the relevant `bun test tests/…` files for runtime
changes. The release check is `bun run check` plus the distribution checks in
`docs/distribution.md`. Use focused failure reproductions when fixing a defect.
Fake, synthetic integration, native runtime, model quality and publication evidence
must be reported separately. Preserve original failed receipts.

Public source, Skills and plugins must be usable from this repository or its
combined release alone. The bundle pins the helper commit, files and MIT license;
never depend on a maintainer's absolute checkout or credentials. Keep all linked
workflow documents in the package. Hooks and model calls require explicit runtime
operations. Full client plugins supply Hooks and Skills, and Claude commands;
installation alone does not activate a service or task binding.

Private run evidence belongs under ignored `.local/` or `workspace/`. Never commit
real RAW, authentication files, API keys, native private identities or machine
paths. Model requests use separately prepared synthetic or deliberately redacted
inputs. Do not relabel RAW as redacted or enable an implicit remote fallback.

At closeout, record outcomes, checks, scope and remaining gaps in the owning task
checkpoint. Include observed native identity and bounded evidence pointers only
in the appropriate private projection. Commit intended source and attach a
machine-readable Proof-of-Useful-Work note under `refs/notes/commits`; verify with
`git log --show-notes=commits -1` and final `git status`. Back up selected source,
notes and bounded private receipts separately. Public artifacts exclude private
notes and histories. Publication needs the task's corresponding authorization.
