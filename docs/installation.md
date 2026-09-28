# Local installation and native Hook definitions

The source-owned installers register two new command names in an **existing,
explicit** executable directory. They do not edit PATH, install or upgrade Bun,
Node or npm packages, copy credentials, log in, change native trust, or start a
worker/model. Run these source scripts with an already installed Bun. The same
workflow supports a temporary test prefix and a user's existing local bin.

`scripts/install-cli.ts` builds from the two selected checkouts. It bundles the
record CLI for Bun and the helper CLI for Node with the installed Bun builder;
the helper's existing Node entrypoint is preserved. It runs each built CLI's
actual `--help` in the explicit staging directory with a minimal environment.
Sources are hashed before and after building. No dependency resolution or network
package installation occurs. A build receipt identifies source versions, source
file digests, runtime executable paths/digests and the help outputs' digests.

## Install the combined public release

The recorder release bundle includes its pinned helper under
`vendor/ultrafast-atif-helper/`. End users need **one unpacked release**, with no
sibling helper checkout, remote clone or floating dependency. Use the published,
reviewed SHA-256 of `release-bundle.json` (not the archive digest) as the input pin:

```sh
bun /absolute/unpacked-release/scripts/install-cli.ts bundle-plan \
  --bundle-root /absolute/unpacked-release \
  --bundle-sha256 REVIEWED_RELEASE_MANIFEST_DIGEST \
  --prefix /absolute/existing/bin \
  --stage /absolute/private-review/build-001 \
  --bun /absolute/runtime/bun \
  --node /absolute/runtime/node \
  --output /absolute/private-review/install-plan.json
```

Then review/apply/verify the resulting installation plan using the same commands
below. `bundle-plan` accepts no external `--helper-repo` or `--record-repo`. The
builder reads only the two contained source payloads after verifying their complete
file inventories, SHA-256 values, sizes, modes, exact versions, full source commit
IDs, helper-page protocol and MIT license files. Unexpected files, repository Git
metadata, private runtime directories, symlinks and hardlinks fail closed. No
private PoUW or RAW trajectory is part of this public distribution.

The release manifest records each component's repository URL and full commit;
the installer verifies the supplied hash-bound release metadata offline, without
fetching Git or independently replaying its source commit. Authenticity of the
reviewed release digest remains the distribution channel's responsibility.
Do not replace the published digest with a freshly calculated digest merely to
accept a modified payload. The committed-tree bundle builder provides the upstream
source-to-payload proof and keeps its release metadata distinct from private notes.

The installed version retains the exact `release-bundle.json`, both MIT license
texts, and the recorder/helper version, commit and file-digest metadata under the
install manifest's `distribution` field. Their hashes are included in normal
installation verification. Keep build and receipt paths outside the unpacked
bundle; staging inside the pinned payload is rejected. A runtime-compatible local
build is produced from the pinned payload, so this format does not require a
separate executable release for each platform.

## Prepare and review a development checkout installation

All paths must be absolute, canonical and have no symlink components. Resolve a
runtime shim before passing it: `node -p process.execPath` reports the executing
Node binary; `realpath` resolves its final canonical path. The prefix and stage
parent must already exist and belong to the caller. The stage must be new.
An example uses shell variables only for task-specific paths; the values are
review inputs, not package defaults:

```sh
bun scripts/install-cli.ts plan \
  --record-repo /absolute/checkouts/task-checkpoint-record \
  --helper-repo /absolute/checkouts/ultrafast-atif-helper \
  --prefix /absolute/existing/bin \
  --stage /absolute/private-review/build-001 \
  --bun /absolute/runtime/bun \
  --node /absolute/runtime/node \
  --output /absolute/private-review/install-plan.json
```

The two-checkout `plan` mode remains available for local development and labels
only the observed source files/versions. It carries no release-bundle commit claim.
Use `bundle-plan` for the pinned combined distribution.

Read the plan before applying. The plan is metadata plus exact bounded snapshots
of the two command launchers and the owned current-install record. The resulting
plan path and SHA-256 are printed as JSON. No prefix change occurs during planning.
Applying requires that exact reviewed plan digest and a new receipt path:

```sh
bun scripts/install-cli.ts apply \
  --plan /absolute/private-review/install-plan.json \
  --sha256 REVIEWED_64_HEX_DIGEST \
  --output /absolute/private-review/install-receipt.json
bun scripts/install-cli.ts verify --prefix /absolute/existing/bin
```

The installation layout is:

```text
<prefix>/task-checkpoint-record             # owned shell launcher
<prefix>/ultrafast-atif-helper              # owned shell launcher
<prefix>/.task-checkpoint-record/owner.json
<prefix>/.task-checkpoint-record/current.json
<prefix>/.task-checkpoint-record/versions/<manifest-sha256>/manifest.json
<prefix>/.task-checkpoint-record/versions/<manifest-sha256>/record/cli.mjs
<prefix>/.task-checkpoint-record/versions/<manifest-sha256>/helper/...
```

Version directories are content-addressed and are never overwritten by this
installer. Their integrity, all recorded files, and the exact runtime binaries
are checked during apply/verify. This is a local ownership/integrity contract,
not OS-enforced immutability against the owning user. Launchers are regular files
with absolute runtime and versioned artifact paths. An existing executable is
replaceable only when the owned current record, immutable manifest and exact
expected launcher bytes all agree. Foreign executables, symlinks, hardlinks,
path traversal, changed inputs and a concurrent installer lock fail closed.

Reapplying an unchanged plan is `already_applied`; it is not a fresh installation.
An upgrade gets a new directory and moves the owned launchers. Previously installed
versions remain available for Hooks that still name their exact artifact. Runtime
upgrades require a new reviewed plan; verify fails if the recorded runtime changes.

## CLI rollback and preconditions

```sh
bun scripts/install-cli.ts rollback \
  --receipt /absolute/private-review/install-receipt.json \
  --sha256 REVIEWED_RECEIPT_DIGEST \
  --output /absolute/private-review/install-rollback.json
```

Only an `applied` receipt can be rolled back. The current registration must still
equal its recorded post-state. Rollback restores the previous exact launcher and
current-record bytes, or removes only the new launchers/current record when none
existed before. It keeps version directories and the ownership marker. Cleanup or
pruning is a separate operation; the installer does not recursively remove an
installed version. A concurrent edit requires a new owner review. On an ordinary
apply exception, already switched launchers are restored if still equal to this
operation's writes. A power loss across two launcher renames is not claimed to be
a transaction; inspect the retained version/current record and repair through an
explicit reviewed operation. Do not remove an unexplained lock as routine cleanup.

## Prepare native JSON definitions

Initialize a private store and create an explicit master session/task binding
through the record CLI before expecting useful admission. The binding's `profile`
must equal the absolute `--profile-home` used below. `runtime_home` can separately
record that same observed source client's home. The supervisor's dedicated model
home is a different configuration surface; these Hook commands never log in,
start a service or select a model.

```sh
bun scripts/hook-plan.ts plan \
  --client codex \
  --config /absolute/source-client-home/hooks.json \
  --manifest /absolute/existing/bin/.task-checkpoint-record/versions/DIGEST/manifest.json \
  --state /absolute/private-store \
  --profile-home /absolute/source-client-home \
  --output /absolute/private-review/hooks-plan.json
```

For Claude use `--client claude` and its explicitly selected JSON settings file.
The file can be absent, but its parent must exist. Only this named file is read;
the planner never scans a home, reads auth files or reads environment files.
JSON is required. Duplicate keys, JSONC and TOML inputs are rejected. Plans contain the full config
snapshot for exact rollback, so keep plans and receipts private, and do not supply
settings documents that contain inline secrets. No such document is needed here.
When additions are needed, formatting changes but all unrelated JSON values and
existing handler positions remain intact. An idempotent re-plan preserves bytes.

The generated command invokes the manifest's absolute Bun executable and the
exact versioned `record/cli.mjs`, followed by the absolute state and profile.
It does not route through the mutable global launcher. A code revision changes
the path in the native definition, so it cannot silently inherit the same command
definition. The plan's `definition_sha256` is our review digest; **it is not Codex's
native `trusted_hash`**.

| Client / event | Generated behavior |
| --- | --- |
| Codex + Claude `SessionStart`, `UserPromptSubmit` | Synchronous bounded admission and already cached context via the supported output contract; 2-second definition timeout |
| Codex + Claude `PreCompact`, `PostCompact` | Synchronous bounded admission; no model call or unsupported PostCompact context injection |
| Codex `Interrupt` | Synchronous admission, 1-second timeout; no blocking/restart semantics |
| Codex + Claude `SessionEnd` | Synchronous admission, 1-second timeout; no reliance on surviving asynchronous child work |
| Codex + Claude `Stop` | Advisory admission only; no `decision:block`, exit-2 gate or `continue:false` |

Claude receives no invented `Interrupt` event. All native groups append to the
selected event arrays; no foreign gate is removed or moved. The CLI suppresses
subagent/observer recursion and unbound sessions. Missing state/admission failure
is fail-open to the master client with a bounded diagnostic; it is not proof that
the event was durably stored. The service's later drain and model work are separate.

Review, apply and verify the hash-bound plan:

```sh
bun scripts/hook-plan.ts apply --plan /absolute/private-review/hooks-plan.json \
  --sha256 REVIEWED_PLAN_DIGEST --output /absolute/private-review/hooks-receipt.json
bun scripts/hook-plan.ts verify --plan /absolute/private-review/hooks-plan.json \
  --sha256 REVIEWED_PLAN_DIGEST
```

`apply` writes only the selected JSON definition file after checking its original
bytes, mode, artifact hashes and safe paths. It does not edit `config.toml`, feature
flags, approvals, project trust or Hook trust. On Codex, native feature enablement,
effective definition trust and a loaded `hooks/list` catalog must be checked under
the owning profile's supported native control plane. On Claude, settings loading,
policy/permissions and the real callback must likewise be observed. A definition
receipt deliberately reports `native_activation_verified:false`, and cannot prove
that a service is running or a master binding is active.

The existing shared Self-Hooks registry does not yet have a checkpoint owner.
Do not disguise this provider as its identity/context owner or run an unrelated
owner sync to manufacture trust. This script is the new provider's source front
door for definitions; native trust/adoption remains an explicit parent-owned step.

To remove this adoption, use `hook-plan.ts rollback --receipt ... --sha256 ...
--output ...`. It restores exact original bytes only if no later config edit has
occurred. If another owner edits the file, rollback refuses and preserves that
edit. Updating to a new artifact requires removing the prior owned Hook adoption
with its receipt and preparing a new plan. A previous version's recorder command
causes a conflict instead of installing two overlapping recorders. An unrelated
edit since adoption requires an explicit owner merge, not automatic whole-file
rollback.

## Pi adapter scope

`integrations/pi/task-checkpoint-record.v1.ts` is a versioned, opt-in adapter factory
against Pi 0.87.1 source contracts. It registers `session_start`,
`session_before_compact`, `session_compact`, `turn_end` and `session_shutdown`.
The wrapper supplies a local `admit(envelope, signal)` function that respects abort;
the adapter enforces a 250 ms default callback deadline (explicitly configurable
from 1 to 1000 ms). A timeout returns without waiting for the sink, aborts its
signal, and reports a bounded drop code. Registration itself starts
no process, socket, timer, service or model. Non-master roles register nothing.
Disposal is idempotent. There is no automatic global extension installation.

The envelope uses `getSessionId()` and a nullable `getSessionFile()`, discards
message/tool bodies, records entry IDs as entry IDs and leaves native turn ID
unavailable. A planned session file does not prove persistence; `turnIndex` is not
a durable native turn. Shutdown reason remains metadata because reload/new/resume
can replace a runtime. Handlers return void and cannot force continuation/cancel.
The current store receives the common envelope and hashes optional adapter fields;
it does not yet expose those Pi entry details as indexed native fields. A complete
native Pi runtime receipt and bounded sink implementation remain explicit follow-up
adoption work, not a claim made by the template tests.

## Proportionate verification

`bun test tests/install.test.ts tests/hook-plan.test.ts` tests ownership, foreign
command preservation, hardlink/symlink/path safety, stale preconditions, changed
artifacts/runtimes, upgrades and exact rollback, preservation of unrelated native
settings, idempotence, correct event names, tampered plans and Pi role/body guards.
One test builds both real checkouts and runs their installed command help in a
temporary prefix, including the helper's version command. Another constructs one
combined source-layout fixture with explicitly synthetic commit identifiers,
verifies its manifest and installs both real CLIs from its contained payload. It
does not claim a published release commit. Additional bundle tests exercise
tampering, protocol/license mismatches, private extras, links and escaped paths.
`bun run typecheck`
covers the scripts through their test imports. These are synthetic/local source
checks; production native trust, activation and callback evidence are separate.
For a standalone checkout, set `TCR_HELPER_SOURCE` to the helper checkout to run
the two real-build integration tests; without it or an adjacent helper checkout
those cases are explicitly skipped, while synthetic installation cases run.
