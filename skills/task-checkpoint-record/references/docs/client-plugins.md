> Package reference from `docs/client-plugins.md`. Run repository-relative examples from a selected source or release directory; installed CLI commands use the installed executable.

# Codex and Claude Code plugins

The client release artifacts provide the recorder and helper payloads, Skills,
native lifecycle Hook definitions and, for Claude Code, slash commands. A plugin
installation creates no source binding, state database, Codex login, daemon or
model request. Each native Hook returns an empty object until the explicit
configuration below is present. Binding a source enables local observation;
starting semantic work requires the recorder's separate agent activation.

## Installation and configuration

Use the assembled client ZIP from the release, whose manifest pins both component
commits and licenses. `integrations/plugins/` in a source checkout contains only
overlays for the release builder. The assembled plugin has this layout:

```text
task-checkpoint-record/
  .codex-plugin/plugin.json  (Codex) or .claude-plugin/plugin.json (Claude Code)
  hooks/hooks.json
  scripts/hook.ts
  skills/task-checkpoint-client/SKILL.md
  commands/*.md             (Claude Code)
  runtime/recorder/         (recorder source and CLI)
  runtime/helper/           (pinned helper and runnable payload)
```

The current executable client adapters support macOS and Linux. The recorder
requires Bun 1.3.14 or newer. The helper's Node distribution requires
Node 18 or newer. The native client resolves `bun` as a declared installed runtime;
the recorder and helper code come from the release package. No maintainer checkout
or globally installed recorder/helper is required. The dispatcher uses
`--no-env-file`, disables automatic dependency installation and selects the shipped
`runtime/recorder/config/runtime.bunfig.toml` to suppress project/global preload
scripts. A fixed `/usr/bin/env` invocation removes `BUN_OPTIONS` and `NODE_OPTIONS`
for the owned child only; other environment and proxy settings are unchanged.
Model/runtime support follows
the recorder's separately tested OS and Codex version matrix.

Create a new config using the bundled recorder's `config init --file NEW_JSON`
command, then review the literal state directory, bundled helper command, dedicated
Codex home/executable, model choices and optional scoring provider. Use
`config check --config ABS_JSON` before activation. The native master profile label
is distinct from `codex.home`, which belongs exclusively to the side service.
For a client ZIP, replace the generic template's global helper command with two
literal argv entries: the selected Node executable and the absolute installed
`runtime/helper/bin/ultrafast-atif-helper.mjs` path. The derived ZIP includes the
helper's runnable `dist/helper/cli.js`; an unbuilt source checkout is insufficient.
After a plugin update moves its version directory, review and rebind the helper
path and config digest before continuing observation.

Configure these non-secret environment settings on the host that launches the
client. They are not native client credentials or a plugin trust grant:

| Setting | Value |
| --- | --- |
| `TCR_PLUGIN_ENABLED` | Literal `1`; any other value disables dispatch |
| `TCR_CONFIG` | Canonical absolute path to the reviewed JSON config |
| `TCR_CONFIG_SHA256` | Lowercase SHA-256 of the exact config file bytes |
| `TCR_PROFILE` | Explicit source-client profile label matching the binding |

The recorder checks the digest against the same bounded bytes it parses. Editing
the config requires reviewing it again and updating its digest. A missing value,
invalid profile/path, digest mismatch, missing store or unbound session produces
legal empty Hook output. It never discovers a state directory from the working
directory or scans a client's history. Error diagnostics contain codes only.

Define one binding through `schema binding`, `bind --config ABS_JSON --file
ABS_BINDING_JSON`, and an observed native session ID. Select exact source paths
and roots; omit historical replay unless specifically needed. A new binding
starts at the last complete source record by default. Activating semantic work
uses the separate `agent` CLI front door and its reviewed policy. Neither the
plugin enable switch nor a binding is permission for an external model request.
The selected store must already be initialized. For a requested new installation,
use `init --config ABS_JSON` after config review; a Hook never initializes it.

Codex Hook definitions require native review/trust in addition to installation.
The plugin never writes trusted hashes. A successful package validator does not
establish native loading, trust, event delivery, or background-service readiness.
The Claude plugin similarly relies on its client's enabled-plugin state. Confirm
one bounded callback in the installed client before claiming native adoption.

## Event behavior

| Client | Shipped events | Hook result |
| --- | --- | --- |
| Codex | SessionStart, UserPromptSubmit, PreCompact, PostCompact, Interrupt, SessionEnd, Stop | Bounded local admission; cached context only for SessionStart and UserPromptSubmit |
| Claude Code | SessionStart, UserPromptSubmit, PreCompact, PostCompact, SessionEnd, Stop | Same local admission; no invented Interrupt event |

SessionEnd and Codex Interrupt use a one-second native deadline; other handlers
use two seconds. The callback waits for local admission only. A previously
activated service can be woken asynchronously through the recorder's configured
front door; the callback never waits for an LLM. PostCompact has no context
injection in these adapters. Stop is advisory by default. An explicitly admitted
strict mode can use only fresh, scope-matched cached verification and at most one
block for its native turn and condition. Missing, pending or stale verification
stays advisory. The callback never fabricates a completed checkpoint or initiates
a recursive model review; the recorder CLI owns that domain decision and its
native output shape.

Observer/worker environment roles are suppressed before loading recorder state.
Native subagent IDs, `stop_hook_active`, and the recorder observer marker also
suppress admission. The dedicated service profile disables recursive hooks and
receives the explicit observer/worker role from its runtime owner.

Claude Code uses exec-form Hooks (`command` plus `args`) with `/usr/bin/env`, so
plugin paths are passed as arguments without a shell. Codex uses its supported command-string schema and
expands the native `$PLUGIN_ROOT` environment variable at shell execution, avoiding
inline `${PLUGIN_ROOT}` source substitution. Windows native loading and service
execution are outside this adapter's current verified runtime contract.

## Commands and removal

Claude exposes `/task-checkpoint-record:activate`, `:status`, `:recall`,
`:checkpoint`, `:stop`, and `:auth`. These are manual workflow instructions using
the bundled CLI's structured JSON operations. They contain no inline shell
substitution and do not execute `$ARGUMENTS` as a command. Arguments are task data;
native identities, config paths and effect scope must be resolved before use.
The workflow uses `runtime/recorder/bin/task-checkpoint-record`, whose packaged
launcher pins the owned Bun configuration and clears inherited interpreter
preload options. Native component discovery and slash-command execution are
separate checks: the isolated Claude 2.1.283 `plugin details` probe listed all six
commands and the shared client Skill, but it did not invoke any command.

Disable the plugin in the native client or set `TCR_PLUGIN_ENABLED=0` to stop new
callback dispatch. `unbind` disables one observation binding; agent deactivation
and service stop separately revoke semantic work. Plugin removal does not erase
the external config, private store, checkpoints or dedicated authentication home,
and does not imply that a previously started service has stopped. Stop/deactivate
owned work through the CLI before removal when that is the intended outcome.
The package adds no automatic uninstall script or cleanup action.

## Verified protocol sources

- Codex command Hooks, plugin environment and trust: [official Hooks docs](https://learn.chatgpt.com/docs/hooks#plugin-bundled-hooks),
  and the Codex 0.158.0 release configuration schema. Local source inspection also
  used `codex-rs/config/src/hook_config.rs` and
  `codex-rs/hooks/src/engine/discovery.rs` at commit
  `44fe510ce3ee61c8ef623adcbf89b901c73ddd61`.
- Claude plugin layout and component paths: [plugin reference](https://code.claude.com/docs/en/plugins-reference).
- Claude direct execution, PostCompact and SessionEnd: [Hooks reference](https://code.claude.com/docs/en/hooks).
  Native manifest validation is recorded for Claude Code 2.1.283 separately from
  installed-client execution.

These sources were checked on 2026-09-28. An upgraded client needs its own bounded
validation and native callback evidence; an accepted JSON manifest alone is not
a compatibility guarantee.
