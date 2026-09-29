# Dedicated Codex runtime updates

The agent service defaults to the latest official stable Codex release. It checks
at daemon startup after the startup acknowledgement, then at idle cycle boundaries
after a configurable interval (four hours by default). The service resolves one
qualified selection for the whole cycle; supervisor and worker processes use that
same selection. A running turn keeps its existing executable and process.

Updates belong to this service's namespace, normally
`<recorder.state_dir>/codex-runtime`. They do not replace the host's `codex`
command, modify PATH, copy login files or change a client profile. Authentication
continues to use the operator's explicit dedicated `codex.home`.

## Configuration and commands

The shared configuration contains these service settings:

```json
{
  "agent_service": {
    "runtime_update": {
      "mode": "latest-stable",
      "root": null,
      "check_interval_ms": 14400000
    },
    "execution_mode": "danger-full-access"
  }
}
```

This is a fragment of the complete configuration, not a replacement config.
`root: null` selects the recorder state's dedicated runtime directory. Intervals
range from one minute to one day. An operator can explicitly select `pinned` mode
with an already selected executable, or hold a retained runtime with the rollback
command. The default service execution mode has full filesystem access and no
approval prompts; update qualification itself uses an empty temporary home and
never starts a task, thread or model turn. See
[configuration.md](configuration.md) for the full service policy and finite
worker, native-turn and external-scoring budgets.

```sh
task-checkpoint-record runtime status --config /absolute/task-checkpoint.json
task-checkpoint-record runtime plan --config /absolute/task-checkpoint.json
task-checkpoint-record runtime update --config /absolute/task-checkpoint.json
```

`status` reads only owned local metadata and verifies any selected package;
`plan` reads official release metadata without installing it; `update` performs
the admitted download, qualification and selection. All three also accept an
explicit `--root /absolute/managed-runtime` instead of a config. Status and plan
do not create the root, an owner marker, an account profile or a database.

For first setup, run `runtime update` before device authentication. Its
`selection.executable` and `selection.qualificationPath` identify the qualified
version. Set the complete config's `codex.executable` and
`codex.qualification_receipt` to those exact paths, select the dedicated
`codex.home`, then follow [authentication.md](authentication.md). The daemon's
latest-stable selection remains automatic at later starts and idle boundaries.
An existing dedicated account uses its existing login; updating the runtime does
not perform authentication again.

## What qualifies a new release

Discovery uses the official `openai/codex` GitHub latest-release metadata. Drafts,
prereleases, unexpected asset locations and missing SHA-256 digests fail. The
download uses the matching complete `codex-package-<target>.tar.gz`, including
`codex-code-mode-host`, resource files and licenses. Supported update targets are
macOS arm64 and Linux amd64/arm64. Windows updates are not implemented.

Before selection, the updater:

1. Verifies the downloaded archive digest, bounded regular-file inventory and
   package identity. Archive links, traversal, duplicate paths and missing paired
   executables are rejected.
2. Runs `--version` and generates the actual app-server JSON schema in a fresh
   empty temporary home with telemetry disabled. No existing account/config is
   read and no thread or turn is started.
3. Checks the adapter's reviewed protocol contract: currently 18 schemas and 115
   structural fragments, including the full-access sandbox variants it uses.
4. Performs `initialize`/`initialized` over stdio, checks the observed version and
   requires the owned app-server to exit normally after input closes.
5. Writes a qualification receipt with the complete package inventory, official
   release binding, protocol observations and handshake evidence. The host
   validator replays those bindings before a native session can use a version
   beyond the exact reviewed version list.

A version string or a stored `passed` boolean alone cannot admit a future release.
The receipt is a local host attestation, not an additional publisher signature.
It proves the package and observed transport contract; it does not prove a model
is available to the selected account or that a future backend preserves task
quality. Real native runs validate the observed runtime, account and model
separately and report failures without changing providers or accounts.

The protocol-generation workflow follows the
[official Codex App Server documentation](https://learn.chatgpt.com/docs/app-server).
The reviewed contract and qualification implementation are included in every
source bundle, installed CLI version and full client plugin.

## Selection, failure and rollback

The owned directory has this shape:

```text
owner.json
current.json                         # atomic selection and optional rollback hold
latest-check.json                    # most recent completed update attempt
checks/<id>.json                     # retained check or rollback reports
versions/<version>-<archive-sha>/
  qualification.json
  package/bin/codex
  package/bin/codex-code-mode-host
  package/codex-resources/...
```

Only a new empty directory or an existing correctly owned runtime root can be
used. Ordinary agent/authentication homes and their descendants are refused. A
new version is built separately, then `current.json` moves atomically. Rollback's
selection and hold are in that same atomic record. Old version
directories are retained. Runtime files referenced by existing processes are not
overwritten. The daemon closes idle old resident processes before adopting a new
selection; unknown process closure holds the transition and capacity accounting.
The activation's finite task budgets do not reset on an update or rollback.

A busy cycle defers switching. A failed discovery, corrupt download, incompatible
schema or unsuccessful handshake leaves the last qualified selection in place
and reports `update_failed` with `latestCheckSucceeded: false`. If there is no
qualified selection yet, startup cannot run a model. A check failure is never
reported as proof that the retained version is the latest. The check timestamp is
part of the result, so an older success remains identifiable as an older check.

```sh
task-checkpoint-record runtime rollback --config /absolute/task-checkpoint.json \
  --version 0.159.0
task-checkpoint-record runtime update --config /absolute/task-checkpoint.json \
  --resume-latest true
```

Rollback accepts one retained, fully verified version, records `held_not_latest`
and suppresses automatic advancement until explicit resume. Idle daemons notice
the local selection revision without waiting for the network check interval.
Rollback does not delete versions, revoke credentials or start another activation.
Pruning is a separate operator action; the updater does not prune retained versions.
An interrupted update can leave its own unselected candidate directory; it never
becomes the current selection merely because its files exist.

## Dependencies, isolation and container use

The local CLI requires Python 3.9 or newer for archive handling and qualification.
The installer accepts optional `--python /absolute/python3`, otherwise resolves
the installed `python3`, and pins its canonical executable and digest alongside
Bun and Node. It does not install or upgrade a Python interpreter. The complete
support files and `config/runtime-python.json` travel inside each installed CLI
version. A source checkout/full source plugin can resolve the operator's existing
Python directly. Interpreter changes to an installed version require a fresh
reviewed installation.

The host invokes Python with `-I -B`, a bounded deadline/output budget and an owned
process group. Provider keys, parent native IDs and Python preload variables are
not inherited. Explicit OS routing/proxy variables are preserved; this service
does not bypass the workstation's network policy. Daemon cancellation closes the
owned updater group, including its unauthenticated probe children.

The underlying packaged front door is available for CI and diagnostics:

```sh
python3 -I -B scripts/runtime/update.py status --root /absolute/managed-runtime
python3 -I -B scripts/runtime/update.py plan --root /absolute/managed-runtime
python3 -I -B scripts/runtime/update.py ensure --root /absolute/managed-runtime --force
# CI can freeze official metadata first, then qualify precisely those inputs.
python3 -I -B container/resolve-latest.py --output /absolute/new-release-lock.json
python3 -I -B scripts/runtime/update.py qualify --root /absolute/new-ci-runtime \
  --lock /absolute/new-release-lock.json
```

The image contains a qualified complete Codex package from its build inputs. A
daemon's writable runtime namespace is separate; its first `ensure` currently
downloads and qualifies the selected stable package into that namespace, even if
the image contains the same version. The image's proof is not silently treated as
daemon adoption. Future image publication and restarting an operator's running
container are separate operations; see the image update workflow for that delivery
scope.
