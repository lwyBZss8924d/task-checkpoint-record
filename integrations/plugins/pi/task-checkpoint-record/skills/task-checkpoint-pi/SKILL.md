---
name: task-checkpoint-pi
description: Configure the installed Pi checkpoint extension, bind a selected local session, and recall source-qualified task windows through its contained recorder and helper.
---

# Pi task checkpoints

Use the accepted Pi package and its contained CLI. In a Pi installation, the
package root is two directories above this Skill directory. Run
`node <package-root>/scripts/cli.mjs --package-info` to obtain exact recorder and
helper commands, then inspect `--help`. If this Skill was copied independently,
locate the installed package first; a maintainer source checkout is not a runtime.

Create or select an explicit unified config and set `recorder.helper_command` to
the contained helper command. Keep state and the dedicated Codex profile outside
the installed package so removal retains them. Configure `TCR_PLUGIN_ENABLED=1`,
canonical `TCR_CONFIG`, its `TCR_CONFIG_SHA256`, and `TCR_PROFILE` for the Pi process.
Use the master role; worker/observer callbacks are suppressed. No callback logs in
or activates a model service.

For a selected task, observe the actual Pi session ID and session file before
binding. An in-memory session may have no persisted file. Use the existing
`schema binding`, `bind`, `agent activate` and `agent start` interfaces only when
those effects belong to the task. Keep the helper's provider data policy explicit;
enabling lifecycle recording does not authorize uploading RAW history.

Use `query`, `resolve` and `recall` to inspect the selected binding/window. A hook
delivery, successful extraction, model proposal and formal owner checkpoint are
different outcomes. Pi `turnIndex` is not a native turn ID. RAW `entry_id` and
`parent_entry_id` carry their own source evidence; this first adapter does not
persist callback entry-ID fields separately. `turn_end` is not final settlement.

The five callbacks only admit bounded metadata and return no Pi control result.
After a failed or timed-out callback, inspect the store before retrying; the
observation may already have been enqueued. Use cached metadata for continuity
without treating it as permission to resume a paused task.
