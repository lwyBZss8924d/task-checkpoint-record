# Task Checkpoint Record for Pi

This Pi package contains a local lifecycle extension, recorder source/CLI, a built
helper CLI, a workflow Skill and both MIT licenses. It requires Pi's Node runtime
(>=22.19.0) and Bun 1.3.14 or a separately verified compatible runtime. There are
no install scripts or downloaded native runtimes at package installation.

The acceptance baseline is Pi 0.87.1's API at source commit
`b485fa3128c3d8dae87cb59da6e95db0f991c5bc`. The host supplies its Pi SDK; this package
does not bundle a second copy.

Download the versioned Pi archive from the recorder release, verify its published
checksums and inventory, extract it, then run `pi install /absolute/extracted/package`.
Use `--local` for an isolated project installation. `pi list` and `pi remove`
manage that declaration; package removal does not remove external recorder state.
`pi install npm:task-checkpoint-record-pi@0.3.0` is valid only after an authorized
npm publication is independently confirmed. Do not use a recorder-main Git
subdirectory URL: that is not an assembled Pi package installation.

Run `node /absolute/package/scripts/cli.mjs --package-info` and `--help`.
The first command reports the contained helper path to use in the unified config.
Set `TCR_PLUGIN_ENABLED=1`, `TCR_CONFIG` to its canonical absolute path,
`TCR_CONFIG_SHA256` to its byte digest and `TCR_PROFILE` to the selected source
profile. Observer and worker roles stay inert. A valid explicit task/session
binding is needed before callbacks create recorded work.

The factory registers `session_start`, `session_before_compact`,
`session_compact`, `turn_end` and `session_shutdown`. Each enabled callback sends
selected metadata to the contained CLI with `shell=false`, no interpreter
preloads or automatic package installation, a 250 ms execution budget and bounded
owned cleanup. Pi waits for the bounded callback; it never waits for a model.
No handler returns cancellation, entries or continuation instructions. Import,
registration and disabled callbacks start no processes, services or authentication.

An aborted `turn_end` is not complete interrupt coverage, and `turn_end` is not
final settlement. In-memory sessions may have no source file. Callback entry IDs
are hashed in ingress but not separately persisted; RAW helper retrieval preserves
native entry/parent IDs with source evidence. Native turn IDs remain unavailable.

Configuration, persistent state and authentication live outside this package.
Use the explicit master CLI/Skill workflow to activate a long task and service.
The `pi-package` keyword makes a published npm package eligible for discovery;
GitHub artifacts do not establish npm publication or Pi catalog appearance.
