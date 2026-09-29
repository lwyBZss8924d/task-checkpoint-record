# Pi package and lifecycle extension

The Pi adapter is distributed as a separate self-contained npm-layout archive
derived from the same verified recorder/helper bundle, starting with recorder
v0.3.0. It includes one native
default extension factory, a bounded subprocess bridge, a workflow Skill, both
component source trees, a built Node helper CLI and both MIT licenses. The host
supplies its Pi SDK through the declared peer; no second Pi SDK is bundled.

The selected API baseline is Pi 0.87.1 at source commit
`b485fa3128c3d8dae87cb59da6e95db0f991c5bc`. The host check compares selected event
types with that exact source and typechecks the factory against an actual
published Pi 0.87.1 SDK. Sharing a version string does not prove source equality.
The runtime requires Node >=22.19.0 and Bun 1.3.14 or a separately verified
compatible Bun. Initial process ownership support is macOS/Linux.

## Install an accepted artifact

Verify `pi-package.SHA256SUMS`, extract the `.tgz`, and select its `package/` root:

```sh
pi install /absolute/extracted/package
pi list
node /absolute/extracted/package/scripts/cli.mjs --package-info
node /absolute/extracted/package/scripts/cli.mjs --help
```

`--local` selects project settings instead of personal settings. A local source
is loaded from its selected path, so retain that accepted package directory.
`pi remove /absolute/extracted/package` removes its declaration; it does not delete
external recorder state, task sources or the dedicated Codex account directory.

`pi install npm:task-checkpoint-record-pi@0.3.0` is only applicable after an
authorized npm publication has been verified. This release builder does not
publish to npm or configure a trusted publisher. A package namespace and publisher
identity must be established separately. A `pi-package` keyword creates discovery
eligibility; actual [catalog appearance](https://pi.dev/packages) is separate
evidence. Do not promise installation from a recorder-main subdirectory URL:
that source tree is not the assembled Pi package at a Git repository/ref root.

## Explicit runtime configuration

Use the contained CLI's `--package-info` output to set
`recorder.helper_command` to its contained helper. Create or select the unified
config outside the package, then provide the Pi process:

- `TCR_PLUGIN_ENABLED=1`;
- `TCR_CONFIG`, the canonical absolute config path;
- `TCR_CONFIG_SHA256`, its exact byte digest;
- `TCR_PROFILE`, the selected source profile.

Only a master role can admit observations. `TASK_CHECKPOINT_RECORD_WORKER=1` or
a non-master `TASK_CHECKPOINT_RECORD_ROLE` suppresses callbacks. Import and factory
registration create no child, timer, watcher, state, service or account operation.
Disabled or unconfigured callbacks remain inert. Explicit session/task binding,
agent policy admission, service startup and device authentication use the shared
CLI/Skill workflow. They are not effects of package installation or callbacks.

## Event behavior

| Pi event | Observation | Control behavior |
| --- | --- | --- |
| `session_start` | Startup/reload/new/resume/fork metadata | Return void |
| `session_before_compact` | Pre-compaction source window, no branch/preparation text | No cancellation or custom compaction |
| `session_compact` | Successful post-compaction window | Recall remains explicit |
| `turn_end` | Outcome and qualified source window | No entries/continuation request |
| `session_shutdown` | Last bounded observation and idempotent owned cleanup | No persistent service shutdown |

The bridge calls the contained recorder with `shell=false`, explicit owned Bun
configuration and no interpreter preload or automatic package installation.
It admits at most 64 KiB of metadata, caps combined output at 32 KiB, permits
250 ms for execution and performs bounded owned-process cleanup. The outer
callback deadline is 500 ms. Pi awaits this bounded callback, never an LLM.
Provider API-key variables are not copied to the hook child.

Pi `turnIndex` is not a native turn ID. The current hook store retains callback
entry references only through the input digest; RAW ETL independently preserves
entry and parent-entry IDs with source evidence. An in-memory session may lack
a transcript path. `turn_end` is actionable and is not final settlement; the
five-event adapter does not claim complete interrupt/final-settlement coverage.

## Build and verify

```sh
python3 -B scripts/distribution/pi-package.py \
  --bundle-root /absolute/verified-core-bundle \
  --bundle-sha256 REVIEWED_MANIFEST_SHA256 --bun /absolute/bun \
  --output /absolute/new-pi-artifacts
python3 -B scripts/distribution/test_pi_package.py
bun test tests/pi-plugin.test.ts tests/plugin-hook.test.ts
```

The builder verifies the exact source inventory before and after the offline
helper compilation. It emits the npm-layout tarball, a detached manifest and
checksums. Unknown overlay files, install scripts, runtime Pi SDK dependencies,
resource drift and changed input bytes are rejected. Source-only tests are
separate from actual host observations.

`check-pi-host.mjs` typechecks an assembled package against an explicitly selected
SDK and the pinned Pi API source. `pi-host-smoke.mjs` uses an isolated
`PI_CODING_AGENT_DIR`, local package installation and Pi's actual loader/runner,
manually emits five synthetic events, checks local ETL/entry retrieval, and removes
the package while retaining state. It makes no model or authentication request.
These synthetic native API events do not claim a real model-driven compaction or
task-quality evaluation. The release workflow runs these checks before attaching
the Pi artifact; npm/OIDC/catalog publication remains a separate operation.
