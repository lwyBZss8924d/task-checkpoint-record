---
name: task-checkpoint-client
description: Configure the packaged Codex or Claude Code task-checkpoint-record plugin, bind one task, and retrieve or stop its explicitly activated observation service.
---

# Task Checkpoint Client

Locate the installed plugin root from this Skill's path (two parent directories).
Its recorder front door is the packaged `runtime/recorder/bin/task-checkpoint-record`
launcher. It selects the owned Bun config, disables dotenv/automatic installation,
and strips inherited interpreter options for its child. Its helper payload is
`runtime/helper/`. Use this installed payload instead of a maintainer checkout or
an unrelated CLI on PATH. The current executable client adapters target macOS/Linux.

Read `runtime/recorder/docs/client-plugins.md` for native setup, supported events,
and removal. Read `runtime/recorder/docs/configuration.md` only for configuration
or credentials, and `runtime/recorder/docs/authentication.md` for device login.
Run the bundled CLI with `--help` when selecting an operation.

- **Configure:** create a new JSON config with `config init --file NEW_JSON`.
  Set `recorder.helper_command` to a Node executable and the literal installed
  `runtime/helper/bin/ultrafast-atif-helper.mjs` path as two argv entries. This
  replaces the generic config template's global-helper default. Review it with
  `config check --config ABS_JSON`. Keep provider key values in the selected
  environment variables. Use a dedicated service `codex.home`; source
  client profile and service authentication home are different identities.
- **Connect Hooks:** set `TCR_PLUGIN_ENABLED=1`, the absolute `TCR_CONFIG`, its exact
  byte `TCR_CONFIG_SHA256`, and `TCR_PROFILE` on the native client's host. Review
  native Codex Hook trust separately. An enabled plugin or valid config does not
  establish a live source binding or service.
- **Bind:** initialize the selected state with `init --config ABS_JSON` only
  for an authorized new setup, then use `schema binding` and an observed native session ID, explicit source
  root and files. `bind --config ABS_JSON --file ABS_BINDING_JSON` admits local
  observation. New bindings start at complete EOF unless historical replay was
  explicitly selected. Source contents stay local by default.
- **Activate semantic work:** use the advertised `agent` operations and the
  reviewed activation policy for that binding. A binding alone does not start
  models. Confirm configured budgets, native data scope and any separately
  admitted synthetic/redacted scoring packet before activation. Use current CLI
  JSON help/schema rather than inventing options from a similar client.
- **Recall:** use `recall --config ABS_JSON --binding ID`, bounded `query`, then
  `resolve` for the returned `tcr://` locator. Preserve absent native IDs, coverage
  limits and checkpoint-proposal status. A cached proposal is not the owner's
  sealed checkpoint or a resume authorization.
- **Close or stop:** import an owner-prepared checkpoint through `checkpoint
  import --config ABS_JSON --binding ID --file ABS_EVENT_JSON`. Separately
  deactivate semantic work, stop its service and/or `unbind` the selected binding
  when requested. Plugin removal does not stop a daemon or delete private state.

For an auth request, `auth plan`, `auth setup --plan-sha256 SHA`, `auth login`, and
`auth status` use the same `--config ABS_JSON`. Login runs the official native
`codex login --device-auth` with the dedicated service home; the user completes
the browser step. Never request tokens, copy login caches, or infer login success
from a config check.

Report package validation, observed native Hook delivery, local admission,
background work, model results and formal checkpoint acceptance separately.
