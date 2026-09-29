# Resident native agent runtime

`src/agent-runtime.ts` supplies the native session primitive for the explicit
background supervisor. It is separate from the existing text-only
`runAppServerTask` API, whose default policy still rejects every server request.
Importing either module starts no process or model.

The orchestrator creates one `createAgentSession(options)` per explicit
activation. The resulting session owns one App Server stdio process and one
persisted supervisor thread. Its `runTurn` method processes successive windows
serially in that same thread. Workers can use `runAgentTurn` to own a fresh
process/thread for one job and close it before returning. The orchestrator owns
worker admission: default concurrency two, maximum 32. The runtime itself creates
exactly one process per explicit session construction and does not spawn workers.

## Lifecycle contract

```ts
const session = await createAgentSession({
  codexExecutable, codexHome, cwd,
  role: "supervisor", // gpt-6-sol / medium
  executionMode: "danger-full-access", // Explicit service policy; API omission stays read-only.
  qualificationPath, // Validated managed runtime receipt for this exact executable.
  tools: windowTools,
  signal: activationAbort.signal,
});
try {
  const first = await session.runTurn({
    input: { dataClass: "metadata_only", text: boundedWindowDescription },
    tools: windowTools,
    outputSchema,
    validateOutput,
    signal: windowAbort.signal,
    onStarted: identity => recordNativeIdentity(identity),
  });
  session.assertHealthy(); // Refuse publication when a failure is already observed.
  // A subsequent call reuses the process and native thread. Supply newly bound
  // handlers for the next window, keeping their advertised descriptors identical.
  const second = await session.runTurn(nextWindowRequest);
} finally {
  const closure = await session.close();
}
```

`identity` contains the observed native thread/session IDs, owned PID, exact
requested/observed model configuration and supported protocol version.
The native adapter also records `executionMode` and, for a managed version,
`qualification.version`, `executableSha256` and `qualificationSha256`. These
fields are copied into each native turn result and the recorder's native receipts.
No native parent-thread relationship is invented for host-created workers. The orchestrator
records its own activation/window/job relationships under a separate namespace.
`onStarted` includes that same observed PID with the native turn identity so the
scheduler can persist process ownership before a later daemon crash. The callback's
PID field is optional for compatible injected runtimes; this native runtime supplies it.

Only one turn may be active per session. Model defaults remain supervisor
`gpt-6-sol/medium`, worker `gpt-6-luna/medium`, and eval `gpt-6-luna/high`.
Model/effort fallback is disabled; unavailable auth/model/configuration fails.
The dedicated home and protected-home checks are shared with the text adapter.

The result's optional `usage` is the last observed
`thread/tokenUsage/updated.tokenUsage.last` snapshot. It is not the cumulative
thread total or a complete accounting of every model request within a tool-using
turn. Do not sum these snapshots and label the result total run cost or tokens.
Cached-input and reasoning-output counts are subsets of input/output, respectively.
Native `turn/start` reservations are a separate budget from backend request or
token accounting; absent totals remain unavailable.

Cancellation, an expired turn/tool deadline, transport failure or a contradictory
terminal notification poisons the session and closes it. There is no automatic
retry or native resume. `AgentRuntimeError` retains observed IDs,
`modelStartAttempted`, bounded tool receipts and, when available, a close receipt.
The scheduler must record model-start admission before calling `runTurn`; a lease
expiry or lost response after that point is an unknown/interrupted outcome that
requires the selected explicit retry policy.

The `closed` promise also reports unsolicited failure while a resident session
is idle. The orchestrator must subscribe to it. Terminal status and final-answer
digests remain in a bounded session journal so a late contradictory event cannot
silently leave the session healthy. Such a late failure is a separate observation;
it does not rewrite an earlier immutable receipt.
`assertHealthy()` synchronously checks already observed transport/session failure
and closing state without starting work, waiting or changing state. Check it just
before publishing a proposal. It makes no claim about future events: keep the
`closed` subscription and record later failure as a separate linked observation.

`close` and `cancel` are idempotent. They interrupt an observed active turn, abort
host handlers, close stdin and verify disappearance of the owned POSIX process
group using bounded TERM/KILL escalation. Windows group closure remains
unavailable, distinct from direct-child closure. No process-name search or global
cleanup occurs. The native thread and its private RAW remain persisted in the
dedicated Codex home.

## Native dynamic tool boundary

The inspected Codex 0.157.1/0.158.0/0.159.0 schema declares flat function tools through
experimental `thread/start.dynamicTools`:

```json
{
  "type": "function",
  "name": "tcr_query",
  "description": "Read bounded metadata in the selected window",
  "inputSchema": {"type":"object","additionalProperties":false},
  "deferLoading": false
}
```

Native `item/tool/call` requests carry `threadId`, `turnId`, `callId`, `tool`,
optional/null `namespace`, and JSON `arguments`. The adapter replies to that
exact JSON-RPC ID with `contentItems` and `success`; this implementation returns
only an `inputText` item containing bounded JSON. Images/audio, approvals,
elicitation, credential-refresh requests, other namespaces and unknown host tools
are rejected. Flat tools have no native namespace in the inspected source.

Each host `AgentTool` provides its descriptor, a required `validateArguments`
function and an `execute(argumentsValue, context)` handler. Descriptors must use a
`tcr_` name and an object schema with `additionalProperties:false`. The trusted
host validator must validate its full argument schema and policy. The runtime
does not replace that validator with a permissive JSON parser.

The broker binds task, source and window scope in host closures. Models supply
bounded selectors, not filesystem roots, executable paths, shell commands or SQL.
Per-turn handler rebinding may change those closures, but the name/description/
schema set must match the session's initial descriptor digest exactly. A capability
change requires a new explicit session.

`context` contains an `AbortSignal` and observed native thread/turn/call IDs.
Unknown/cross-turn/cross-thread requests and duplicate call IDs fail before host
dispatch. Invalid arguments return a bounded `success:false` tool response without
calling the handler. Ordinary host failures return a generic failure, never an
arbitrary exception or source body. Tool effects and domain outcomes remain the
broker's responsibility; a valid handler return does not establish task success.
Native tool completion must match the call ID, tool name and success status of its
host receipt, including completion items embedded in `turn/completed`.

## Data classes and authority

Default inputs and tool results admit `metadata_only`, `synthetic` and `redacted`.
These classes are host assertions, not automatic content inspection or redaction.
Tool receipts retain only name/IDs, argument/result digests, bytes, class and status.
Reasoning deltas, raw response items, account details and stderr content are not
returned by this runtime. The native Codex engine may persist its own private RAW.

`owner_selected_source` is a distinct class. It is refused unless session creation
explicitly lists it in `allowedDataClasses` and supplies a `sourcePolicyId`.
Neither option grants authority by itself: the caller must have an applicable
owner/user admission, and the broker must enforce the selected source/snapshot.
Never relabel RAW as synthetic or redacted. The initial parent can omit this
policy entirely, leaving real source bodies unavailable to the model.

The broker may omit `tcr_score_prepared` unless separately admitted. Registering
a query/context tool does not authorize a remote scorer call. A `tcr_delegate`
tool is a host-orchestrated operation whose worker count, leases and evidence
scope belong to the scheduler, not to arbitrary model arguments.

## Bounds and native restrictions

Explicit `agent_service` activation defaults to `execution_mode:
"danger-full-access"`. The process receives `approval_policy="never"` and
`sandbox_mode="danger-full-access"`; `thread/start` receives
`approvalPolicy:"never"` and `sandbox:"danger-full-access"`; every `turn/start`
receives `approvalPolicy:"never"` and `sandboxPolicy:{type:"dangerFullAccess"}`.
The adapter verifies the returned thread policy and refuses a changed policy
before starting a model turn. `app-server` does not accept the TUI's `--sandbox`
or `--dangerously-bypass-approvals-and-sandbox` shortcut flags. The RPC/config
mapping provides the requested daemon execution mode without incompatible flags.

`execution_mode:"read-only"` is an explicit alternative. Direct
`createAgentSession` and legacy prepared-text `runAppServerTask` calls retain
read-only when their `executionMode` option is omitted. Full access changes the
native process sandbox; it does not expand the broker's allowed tools, source
admissions, provider credentials or task acceptance authority.

The exact built-in protocol versions are 0.157.1, 0.158.0 and 0.159.0. A future
stable version requires `qualificationPath`: before launch the host replays the
managed full-package inventory and protocol observations against its shipped
contract. The native `initialize` response must then report that exact qualified
version. A bare version string, prerelease or pass flag cannot qualify a binary.
The receipt is a local host attestation, not an upstream signature or a claim
that a native model evaluation passed.

The configured daemon checks the official latest stable runtime after its
startup acknowledgement and at the configured interval between serialized
cycles. One resolved executable/qualification is fixed across a round and its
worker fanout. A changed selection closes the old idle supervisor before a new
epoch starts; an unverified closure prevents adoption and retains capacity.
Previous epochs and consumed activation budgets remain in the same store.
Neither importing a module, validating configuration, invoking a Hook nor using
the legacy text API starts the updater. See [configuration.md](configuration.md).

Defaults are: 30-second startup deadline, 300-second turn deadline, six-hour
session lifetime, 128 turns, 32 tool calls per turn, four concurrent host tools,
120-second host-tool deadline, 16 KiB tool arguments, 32 KiB result frames, and
256 KiB aggregate tool bytes per turn. JSON nesting/node budgets and independent
wire/line/stderr limits apply. All are checked against finite hard ceilings.
Native context-compaction items are counted as observations, not fabricated
context-window IDs or a guarantee of lossless native history.

The runtime sets `environments:[]` on both thread and turn, supplies no selected
capability roots, uses the existing restricted feature configuration, and checks
the effective `config/read` MCP map before starting the thread. Configured MCP
entries are refused. Apps/plugins, shell, native multi-agent, Hooks, memories,
goals, web/code/image/browser/computer-use features remain disabled by the scoped
configuration. No global/profile defaults are rewritten.

The public native API still does not expose the internal universal
`ToolPolicy.allowed_tools=[]` ceiling. Model-catalog utility tools may remain
available. The host broker has an absolute allowlist; native restrictions are the
inspected supported settings, not a universal prevention guarantee. Observed
unexpected native tool activity fails the session, which does not prove it was
prevented before execution. This limitation must remain in delivery claims.

Every asynchronous handler must honor its signal and its source/job lease fence.
JavaScript cannot forcibly terminate an arbitrary host promise. Closure therefore
reports `hostHandlersSettled` separately after a bounded wait; false means cleanup
is unconfirmed even if the native process group is gone. Do not declare that work
complete or automatically replay its effects. Broker-owned subprocesses/requests
need their own bounded cancellation and persistence rules.

The native schemas/source inspected for this interface are
`ThreadStartParams`, `DynamicToolCallParams`, `DynamicToolCallResponse`,
`ConfigReadParams/Response`, and the Codex `DynamicToolHandler` request/response
lifecycle. Source/fake-stdio acceptance is separate from an admitted live dynamic
tool integration probe and from long-horizon usefulness.
