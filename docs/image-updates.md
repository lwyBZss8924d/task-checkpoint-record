# Automatic Codex universal images

The `newcodex-runtime-update.yml` workflow resolves the official latest stable
Codex release and the current `ghcr.io/openai/codex-universal:latest` OCI digest
every six hours, and on manual dispatch. It builds the required universal image
for native Linux amd64 and arm64 runners. A failed resolution, qualification,
build or check leaves the existing `current` tag in place. “Current” means the
last fully checked publication; it is not a promise that an incompatible new
upstream release has already passed. GitHub schedules can be delayed.

The workflow reads the reviewed full helper commit from
`container/helper-source.json`. That public lock has schema
`task-checkpoint.helper-source.v1`, repository
`https://github.com/lwyBZss8924d/ultrafast-atif-helper`, a full 40-character `commit`
and its semantic `version`. A missing lock, branch name, short hash or helper
older than 0.3.0 fails before a build. Updating this lock is a source change;
the workflow does not silently follow helper main.

## What each publication proves

The resolve job freezes recorder/helper commits, package versions, both official
native archive checksums, the base OCI digest and the exact used protocol-contract
digest in `image-plan.json`. The two native qualification jobs download complete
official Codex packages, check their digests and paired code-mode host/resources,
run version and generated-schema checks, and complete an empty-home App Server
initialize/shutdown exchange. They start no model thread or turn. Codex's
[generated schema belongs to the invoked CLI version](https://learn.chatgpt.com/docs/app-server#message-schema).

Each platform publication job builds the actual universal image from those
frozen inputs, loads it locally, and checks it with network disabled and a
read-only root filesystem. A private tmpfs holds only a synthetic empty store.
Source checks compare both the index and worktree against each pinned commit;
the build then consumes separate bounded Git-blob exports. Context-eligible
untracked files and the workflow's nested helper checkout are excluded from the
recorder export. The helper has its own pinned export and narrow build context.
Checks cover both contained CLIs, configuration, activation schema, the qualified
native version and refusal to start an agent without an admission. Smoke resolves
the selected local image once and executes that immutable ID with `--pull=never`.
Publication validates the smoke ID, tags that ID for its unique destination and
checks the destination binding before push. There is no second untested build
between smoke and push.

Only publication jobs receive `packages: write`. Registry login occurs after
the local image passes. The final publication job requires matching successful
amd64 and arm64 digest receipts from the same plan before creating the combined
manifest and moving `current`. Unique version/run tags and digest references
remain available; both published tags are read back and compared. OCI labels,
the contained image plan, qualification receipts and Actions artifacts bind
source, helper, native version/archive, base and protocol identities.

The initial GHCR package visibility is
[private by default](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#pushing-container-images).
A successful push does not establish anonymous availability. The repository
owner separately sets public visibility and verifies an unauthenticated pull.
This workflow does not change package visibility or publish account material.

## Resource and platform evidence

The default runners are `ubuntu-24.04` and `ubuntu-24.04-arm`, which GitHub lists
as [native standard public-repository runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories).
The workflow reports actual architecture and free storage before building.
The universal base is large; a disk failure is an actual failed build, and never
causes substitution of a smaller base or a claim that the other architecture
passed. No runner cleanup or pruning is performed. Operators may explicitly set
`TCR_IMAGE_AMD64_RUNNER` or `TCR_IMAGE_ARM64_RUNNER` to an available native runner
label with suitable capacity. The default configuration does not purchase or
select a larger runner. No emulated-platform result is presented as native.

## Baked runtime and persistent service runtime

The image carries a fully qualified Codex package at `/opt/codex-managed`.
`docker run --rm IMAGE codex --version` validates its selection and executes the
actual full-package binary. The entrypoint strips ambient Bun, Node and Python
startup options. Builds and Python launches disable bytecode generation.

The service's `latest-stable` mode uses its own writable runtime directory under
the configured recorder state volume. It resolves and qualifies upstream releases
independently; the baked seed is not silently copied into that volume or claimed
as proof that a persistent service adopted an update. The service update policy
keeps active work, switching and rollback under the runtime owner's contract.
Account data remains in the dedicated `/var/lib/task-checkpoint-codex` volume.
Neither account state nor provider keys enter build contexts, layers, CI inputs or
published receipts. Device authentication and task admission remain explicit CLI
operations. The selected service execution policy is `danger-full-access`;
container UID 10001 still defines the operating-system identity.

## Manual and local operation

Dispatch `newcodex-runtime-update.yml` from the repository's default branch.
`publish=false` executes the same qualification, build and offline checks without
registry login or publication. `codex-compatibility.yml` is the smaller manual
full-package qualification workflow and never builds or publishes images.

For a local build, prepare a new directory containing freshly resolved
`versions.json`, the current base descriptor and `image-plan.json`, then use:

```sh
python3 -I -B container/image-ci.py build \
  --plan /absolute/image-inputs/image-plan.json \
  --source /absolute/committed-recorder \
  --helper-source /absolute/committed-helper \
  --work /absolute/new-build-work --arch arm64 \
  --image task-checkpoint-record:checked --output /absolute/new-build.json
python3 -I -B container/image-ci.py smoke \
  --plan /absolute/image-inputs/image-plan.json --arch arm64 \
  --image task-checkpoint-record:checked --output /absolute/new-smoke.json
```

`image-ci.py plan --help` lists the explicit source/run inputs. The Dockerfile
requires a digest-qualified `CODEX_BASE` and a `codex-lock` named context; it has no
0.158 fallback. A local build does not publish, start a service, read a real RAW
trajectory, authenticate, alter host Codex installations or register Hooks.

Run `python3 -I -B container/test-image-ci.py` for offline metadata, publication
binding, failure-retention and workflow-policy tests. These tests use fake Docker
responses and do not count as an actual image build, native runtime or model test.
