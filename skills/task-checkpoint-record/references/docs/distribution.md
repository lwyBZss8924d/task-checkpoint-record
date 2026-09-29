> Package reference from `docs/distribution.md`. Run repository-relative examples from a selected source or release directory; installed CLI commands use the installed executable.

# Distribution and compatibility

This repository contains its CLI/API source, contracts, package Skills, a portable
`plugin.json`, a Codex compatibility manifest, offline checks, and container input
pins. The Skills-only plugin supplies the workflows in `skills/`; separate full
Codex/Claude artifacts also supply native Hooks and Claude commands. Installing
the CLI, authenticating, binding a task, enabling/trusting Hooks and starting a
worker remain explicit operations. Builds and imports perform no model call.

CLI help and App Server client identity use the recorder package version. TypeScript
bundles embed `package.json` at build time. The Python runtime qualifier reads the
same package metadata in a source bundle, or the recorder source version retained
in the owned CLI installation manifest. This product version is distinct from
the observed native Codex version and the versioned protocol schemas.

The compatibility manifest follows the supported `plugin-creator` layout. Current
[OpenAI plugin packaging guidance](https://developers.openai.com/plugins/build/plugins)
also supports the root portable manifest. Both carry the same package identity and
discover the same self-contained `skills/` directory. No personal marketplace is
written by a build or installation script. A public repository or release artifact
does not itself mean acceptance into the public ChatGPT/Codex Plugins Directory.

Skill references are bounded projections of the canonical `docs/` and selected
public configuration templates. Run `python3 scripts/distribution/skill-docs.py write`
after changing those inputs; `check` validates the source/output SHA map. CI copies
only the Skill folder into a separate directory and rejects local links escaping
that folder. Repository-relative examples in the projected docs run from a selected
source or release package; installed CLI workflows remain usable from any directory.

## Public artifacts

End users install the **combined recorder bundle**, which includes the pinned
helper under `vendor/ultrafast-atif-helper`. Its `release-bundle.json` records both
full source commits, exact delivered files/modes/sizes/digests, MIT license digests
and the helper-page protocol. A second checkout is not needed. Check the release
checksums, unpack the bundle into a new directory, then use the contained installer:

```sh
/usr/bin/env -u BUN_OPTIONS bun --no-env-file --no-install \
  --config="$PWD/config/runtime.bunfig.toml" scripts/install-cli.ts bundle-plan \
  --bundle-root /absolute/unpacked-bundle \
  --bundle-sha256 REVIEWED_RELEASE_MANIFEST_SHA256 \
  --prefix /absolute/existing-bin-directory --stage /absolute/new-stage \
  --bun /absolute/bun --node /absolute/node --output /absolute/new-plan.json
```

Review the plan and use the documented `apply --plan ... --sha256 ...` operation.
`bundle-plan` validates the complete delivered inventory before building either
CLI and records the release identity in the installed manifest. It never fetches a
missing helper. See [installation](installation.md) for apply/verify/rollback.

Maintainers assemble the bundle only from committed public source trees:

```sh
python3 scripts/distribution/bundle.py \
  --recorder-repo . --recorder-commit FULL_RECORDER_COMMIT \
  --helper-repo ../ultrafast-atif-helper --helper-commit FULL_HELPER_COMMIT \
  --output /tmp/task-checkpoint-bundle-artifacts
```

The builder reads Git blobs at those exact commits, ignoring mutable worktree
content. It emits the combined tarball, a detached copy of its manifest and
checksums. It also derives a `task-checkpoint-tools` suite plugin ZIP containing
**both** committed Skill folders and a separate self-hosted marketplace ZIP.
`suite-manifest.json` binds both source commits, component versions, license hashes,
the source bundle manifest digest and every delivered plugin file. These artifacts
reuse the committed Skill projections and preserve both MIT notices; no helper
working directory is copied into a published suite. The core bundle manifest and
CLI installer format remain unchanged. A detached suite manifest has the same bytes
as its in-plugin copy, and the bundle checksum file covers both ZIPs and manifests.
The plugin root also carries `aicatlog-manifest.json` and its two resource entries
for explicit registration as one versioned Skills package. A compact root
`SKILL.md` named `task-checkpoint-tools` routes to both nested Skills, so a tool
that installs one selected Skill directory can copy the whole suite. Codex plugin
discovery remains rooted at `./skills/` and exposes the two leaf workflows.

To install the unified plugin, verify the bundle checksum file and extract the
marketplace ZIP into a durable versioned package directory. Use that extracted
directory as the marketplace root, then select the current Codex profile explicitly:

```sh
codex plugin marketplace add /absolute/task-checkpoint-tools-0.3.1-marketplace --json
codex plugin add task-checkpoint-tools@task-checkpoint-tools --json
codex plugin list --json
```

`plugin add` is the installation command observed in Codex CLI 0.157.1; check
`codex plugin add --help` on another version. The official packaging guide also
describes installing from a configured marketplace through the desktop app. The
catalog points to `./plugins/task-checkpoint-tools` relative to the extracted
marketplace root. Its `aicatlog-manifest.json` lists both Skills for an explicit
owner-managed global registration. Registration, plugin installation and global
Skill projection are separate effects, performed only through their selected
owner's front door. A self-hosted catalog does not claim admission to the official
public Plugins Directory. No build command edits a personal marketplace or account.

The following separate component source/plugin archive command remains useful
for source review and plugin-only distribution.

## Native client plugin artifacts

The Skills suite supplies reusable workflows. Native Codex and Claude Code client
plugins are separate explicit artifacts assembled with their reviewed overlays,
native Hooks, client Skill and Claude slash commands. Each contains recorder source
under `runtime/recorder/`, helper source plus an offline-built Node CLI under
`runtime/helper/`, both licenses, and `client-package.json` with exact source and
payload digests. The existing core bundle format is preserved.

After extracting and verifying the exact committed core bundle:

```sh
python3 scripts/distribution/client-plugins.py \
  --bundle-root /absolute/verified-core-bundle \
  --bundle-sha256 REVIEWED_RELEASE_MANIFEST_SHA256 \
  --bun /absolute/bun-1.3.14 \
  --output /absolute/new-client-artifacts
```

The compiler uses the bundle's owned `config/runtime.bunfig.toml`, disables dotenv
and automatic dependency installation, and strips inherited interpreter options.
It neither installs a plugin nor calls a model. Outputs include each client ZIP,
detached inventory, self-hosted marketplace ZIP and checksums. Codex and Claude
catalogs use their native formats; keep them separate.

Install an assembled client artifact and follow its bundled
`runtime/recorder/docs/client-plugins.md`. Configure the explicit enable switch,
canonical config path, config byte digest and source profile before expecting an
admission callback. The service remains an explicit operation. Select the contained
helper entry in `recorder.helper_command`; the general template's global CLI default
does not identify this plugin's payload. Package validation, observed native Hook
delivery, model work and formal owner checkpoint acceptance remain distinct.

From this repository, after dependency installation:

```sh
bun --no-env-file run check
python3 scripts/distribution/test_package.py
python3 scripts/distribution/package.py check
python3 scripts/distribution/package.py archive --output /tmp/task-checkpoint-artifacts
```

The output directory must be new. The archive command creates a deterministic
public source tarball, a Skills plugin ZIP, and `SHA256SUMS`. It uses an explicit
source allowlist rather than `git archive --all`, a Git bundle, or a workspace copy.
Git metadata, notes, private evidence, runtime databases, account homes, credentials
and RAW histories are excluded. Symlinks, hardlinks, unexpected runtime files and
credential markers under an allowed source directory fail the build. Maintainers
must also review the source diff; a marker scan is not a proof of complete redaction.

CI installs locked development dependencies and then runs source/fake tests and
package checks without model credentials. The release workflow creates artifacts
for review; a separate explicit input requests a **draft** GitHub release for an
existing matching tag. It does not publish to npm, a marketplace or a container
registry. Enable any desired release environment review rules in the repository.

## Recorder container

The recorder image derives from
[`ghcr.io/openai/codex-universal`](https://github.com/openai/codex-universal).
`container/versions.json` records the bootstrap/runtime inputs and reviewed helper
source pin. Automatic image builds resolve the latest official stable Codex
release and current Codex-universal base digest into an exact build lock. Bun
1.3.14 and Node 22 retain their declared toolchain pins. Full packages preserve the matching
code-mode host, sandbox resources and package metadata. Build-time installation
never replaces a host binary. Image/asset resolution is evidence about inputs;
container execution and authenticated model compatibility have separate receipts.

The helper is built from a **separate, narrow, explicit named context**. Never use
the parent library, a home directory or an account directory as a build context.
With the two public source checkouts side by side:

```sh
python3 scripts/distribution/package.py helper-context \
  --source ../ultrafast-atif-helper --output /tmp/task-checkpoint-helper-context
mkdir /tmp/task-checkpoint-image-inputs
python3 -I -B container/resolve-latest.py \
  --output /tmp/task-checkpoint-image-inputs/versions.json
docker buildx imagetools inspect ghcr.io/openai/codex-universal:latest \
  --format '{{json .Manifest}}' > /tmp/task-checkpoint-image-inputs/base-descriptor.json
python3 -I -B container/image-ci.py plan \
  --native-lock /tmp/task-checkpoint-image-inputs/versions.json \
  --base-descriptor /tmp/task-checkpoint-image-inputs/base-descriptor.json \
  --helper-lock container/helper-source.json --commit "$(git rev-parse HEAD)" \
  --repository lwyBZss8924d/task-checkpoint-record --run-id 0 --run-attempt 1 \
  --output /tmp/task-checkpoint-image-inputs/image-plan.json
docker buildx build --load \
  --build-context helper=/tmp/task-checkpoint-helper-context \
  --build-context codex-lock=/tmp/task-checkpoint-image-inputs \
  --build-arg "CODEX_BASE=$(python3 -I -B -c 'import json; print(json.load(open("/tmp/task-checkpoint-image-inputs/image-plan.json"))["base"]["reference"])')" \
  -t task-checkpoint-record:local .
docker run --rm --network none task-checkpoint-record:local --help
docker run --rm --network none task-checkpoint-record:local codex --version
```

For the combined release bundle, replace the helper source argument with
`./vendor/ultrafast-atif-helper`; all required inputs are already contained in the
bundle. The narrow staging command remains explicit and does not copy account
state or unrelated checkouts.

The first command refuses an existing destination and records every copied helper
input digest. The primary `.dockerignore` is deny-by-default and only admits the
runtime build inputs. The compatibility workflow and automatic image pipeline
qualify the selected stable release against the bundled protocol contract before
publication. The contract lists the exact used schema files and structural checks;
package/initialization/protocol receipts retain their own verification scope.
They do not establish authenticated model availability. See
[runtime updates](runtime-updates.md) and [image updates](image-updates.md) for
the schedule, exact image metadata, update failures and rollback.

## Persistent authentication and local data

Containers run as UID/GID 10001. Use a dedicated persistent volume for
`CODEX_HOME=/var/lib/task-checkpoint-codex`, and another for
`TASK_CHECKPOINT_RECORD_STATE=/var/lib/task-checkpoint-record`. The image contains
only public configuration templates: supervisor `gpt-6-sol`/`medium`, ChatGPT
authentication, unattended `danger-full-access` execution with approval `never`,
scoped host tools and recursive Hooks/telemetry disabled.
The fixed container example is
`/opt/task-checkpoint-record/config/task-checkpoint.container.example.json`. It
selects the contained Codex/helper executables and the two dedicated volume paths.
Configuration/authentication operations use the same explicit recorder CLI as a
native installation. Startup copies no configuration and performs no login; Bun
runs with `--no-env-file`. No credentials are copied from another profile.

```sh
docker volume create task-checkpoint-codex
docker volume create task-checkpoint-state
docker run --rm \
  --mount source=task-checkpoint-codex,target=/var/lib/task-checkpoint-codex \
  task-checkpoint-record:local auth plan \
  --config /opt/task-checkpoint-record/config/task-checkpoint.container.example.json
docker run --rm \
  --mount source=task-checkpoint-codex,target=/var/lib/task-checkpoint-codex \
  task-checkpoint-record:local auth setup \
  --config /opt/task-checkpoint-record/config/task-checkpoint.container.example.json \
  --plan-sha256 REVIEWED_AUTH_PLAN_SHA256
docker run --rm -it \
  --mount source=task-checkpoint-codex,target=/var/lib/task-checkpoint-codex \
  task-checkpoint-record:local auth login \
  --config /opt/task-checkpoint-record/config/task-checkpoint.container.example.json
docker run --rm \
  --mount source=task-checkpoint-codex,target=/var/lib/task-checkpoint-codex \
  task-checkpoint-record:local auth status \
  --config /opt/task-checkpoint-record/config/task-checkpoint.container.example.json
```

Complete the displayed one-time code in your browser. Keep this volume private and
retain it across container replacement. Never put it in image layers, a Git commit,
a release archive, CI cache or a submitted bug report. Existing source-client
profiles remain separate. OpenRouter/Jev is a different, explicit provider route;
neither its key nor model configuration is used by device-auth.

Mount only the selected transcript directory read-only, for example
`--mount type=bind,src=/absolute/selected/transcripts,dst=/inputs,readonly`.
Binding JSON must use **container-visible** absolute paths, not host paths. Initialize
state explicitly with `init`; enqueue/read hooks remain local and model-free.
Run a deterministic service with an explicit command such as:

```sh
docker run --rm --network none \
  --mount source=task-checkpoint-state,target=/var/lib/task-checkpoint-record \
  --mount type=bind,src=/absolute/selected/transcripts,dst=/inputs,readonly \
  task-checkpoint-record:local service run --concurrency 2 \
  --config /opt/task-checkpoint-record/config/task-checkpoint.container.example.json
```

No listener is exposed, and the container's default command is `--help`. App-server
review uses explicit `agent activate` and `agent start/run` operations, or the
separate prepared-input library API. `service run` remains the deterministic
ETL worker. Native callbacks in
another container or on the host require an explicit shared-store/adapter plan;
installing this image does not wire or start them. See [installation](installation.md)
and [the agent service](agent-service.md).

## Compatibility evidence

Record the exact image ID, platform, source revision, Codex version and check result
when running container smoke tests. Linux amd64 and arm64 are input targets, not a
claim that both were executed. Latest-release metadata, source tests, native
app-server handshake and live model behavior remain separate verification levels.
