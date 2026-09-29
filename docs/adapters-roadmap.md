# Client adapters and publication states

The core recorder, helper and dedicated Codex model runtime are shared across
clients. Each client adapter owns its native discovery, callback, command and
removal contract. A package inventory and a native callback are different evidence.

| Surface | Current implementation lane | Required delivery evidence |
| --- | --- | --- |
| Codex plugin | Full plugin overlay, Skills and seven lifecycle Hook definitions | Contained runtime inventory, native schema/discovery/trust, configured callback delivery, activation and removal |
| Claude Code plugin | Full plugin overlay, six Hooks, six slash commands and a workflow Skill | Manifest and command validation, native component discovery, configured callbacks and command invocation, removal retaining user data |
| Shared Skills suite | Router plus both component Skills and their local references | Install the suite as one package; copy each Skill independently and verify its local references |
| Pi package/extension | Self-contained archive, explicit Pi manifest, default factory, bounded CLI bridge and Skill | Exact host API/type checks, isolated local install/load/synthetic callbacks/remove; npm/OIDC/catalog publication remains separate |

The source and release builders include client-specific inventories, licenses,
checksums and marketplace catalogs. Local installation requires explicit runtime
configuration; unconfigured/disabled/observer callbacks stay inert. A plugin load
does not create a task binding, authenticate a native account or activate a model.
For a selected long task, the master explicitly admits a binding and agent policy,
then starts the external service. See [client plugins](client-plugins.md) and
[configuration](configuration.md).

## Codex and Claude

The Codex artifact has its native plugin manifest and Hook definitions. The Claude
artifact has its own `.claude-plugin/plugin.json`, Hook definitions and command
directory. They are separate artifacts sharing the same pinned core/helper inputs;
the Skills-only suite remains a separate installation choice.

Claude commands cover activation, status, recall, checkpoint verification, stop
and authentication. They treat user arguments as data and use the contained CLI.
Native command discovery does not prove a slash command was invoked successfully.
The current executable callback runtime targets macOS/Linux, matching the verified
process-group ownership contract.

GitHub releases can publish the artifacts and self-hosted marketplace catalogs.
Listing in a vendor's public directory requires that vendor's current submission
and review process. GitHub publication, local marketplace registration, native
installation, Hook trust and directory acceptance are recorded separately.
See the [Codex plugin guide](https://developers.openai.com/plugins/build/plugins)
and [Claude plugin publication guide](https://code.claude.com/docs/en/plugins/publish).
Claude Code packages containing local executable components must not be described
as automatically compatible with claude.ai or Cowork.

## Pi package and remaining publication work

The selected baseline is Pi `0.87.1` at commit
`b485fa3128c3d8dae87cb59da6e95db0f991c5bc`. Earlier research/template commits had the
same version string; the host check compares the actual selected API declarations.
See [Pi package](pi-package.md) for exact archive, runtime and event contracts.

The package delivery checks must:

1. Add the native package manifest and default extension factory, with explicit
   component paths and inert import/registration.
2. Reuse the unified configuration and contained CLI/helper without a maintainer
   checkout, copied credentials or automatic daemon/model startup.
3. Exercise the actual callback sequence in an isolated Pi profile, preserving
   entry IDs and unavailable native turn IDs rather than inventing a mapping.
4. Verify install, update and removal while retaining the operator's external
   configuration, login and recorded evidence.
5. Build a reviewed npm payload and GitHub release with source pins and checksums.
   Publish through the operator's authorized npm identity or trusted publishing
   configuration. The `pi-package` keyword enables discovery eligibility; actual
   catalog appearance must be observed separately.

References: [pinned Pi package contract](https://github.com/earendil-works/pi/blob/b485fa3128c3d8dae87cb59da6e95db0f991c5bc/packages/coding-agent/docs/packages.md),
[Pi package catalog](https://pi.dev/packages). No Pi publication or vendor-directory
acceptance is implied by the archive or its checks.
