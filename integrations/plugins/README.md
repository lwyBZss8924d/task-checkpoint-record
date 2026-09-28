# Client plugin overlays

These are source overlays for the separate Codex and Claude Code release ZIPs.
They are not standalone installations from this source directory: the distribution
builder adds the exact committed recorder under `runtime/recorder`, the pinned
helper under `runtime/helper`, and their source/license inventory. Install the
assembled release artifact. The existing `task-checkpoint-tools` artifact remains
a Skills-only package.

Both clients use `src/plugin-hook.ts` and the same `task-checkpoint.config.v1`
front door. Review [the client plugin contract](../../docs/client-plugins.md)
before activating a binding. Keep the two overlays distinct; copying the Claude
hook manifest into Codex loses the direct-execution `args` semantics.

Pi remains a separately versioned extension template at
`integrations/pi/task-checkpoint-record.v1.ts`. This change does not claim a native
Pi package, npm publication, catalog registration, or verified Pi activation.
