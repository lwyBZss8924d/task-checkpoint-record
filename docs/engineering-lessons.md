# Engineering evidence and reusable checks

Use these checks when changing recording, model lifecycle or installation code.
They come from concrete failure reproductions in this implementation cycle;
private source traces and runtime identities are deliberately excluded.

| Trigger | Required check | Counterexample that makes it useful |
| --- | --- | --- |
| Deduplicating Hook input | Include observed source ceilings in observation identity | The same turn and payload can observe newly appended bytes |
| Pairing tool calls and results | Qualify by native session/turn or exact ATIF document scope | Different trajectories may reuse the same call ID |
| Resuming an append-only source | Retain verified cursor state and explicit coverage | A numeric offset alone does not establish continuity or earlier identity |
| Reading dynamic filter keys | Preserve exact keys and validate against the contract | A prototype-like key can disappear from a normal object and broaden a query |
| Handling model completion | Reject conflicting terminal events through process close | A later completed event cannot erase an earlier failed terminal event |
| Cleaning a helper/model job | Verify the owned process group after the leader exits | A successful leader may leave a same-group child alive |
| Installing or rolling back | Validate output destinations and the complete target closure before effects | A failed receipt or changed retired runtime can leave an unrecorded or broken installation |
| Claiming version compatibility | Pin the actual executable and consumed protocol fields | A supported version in a user-agent suffix does not identify the running build |
| Publishing a multi-package release | Build from exact committed trees and verify the combined payload | Working-tree tests do not bind the content users actually install |
| Launching a Bun Hook from an arbitrary project | Pin the package runtime configuration and suppress inherited preload controls before entering application code | Disabling dotenv alone still permits a caller's Bun preload to execute before an inert guard |
| Selecting a credential environment reference | Reject interpreter, loader and native-child control-variable names | A secret reference named like a runtime option can cross an unintended child boundary |
| Returning from detached service startup | Gate first work on an explicit startup acknowledgment and report uncertain admission truthfully | A timeout can otherwise leave a child that starts model work after its caller reports failure |
| Completing a native dynamic tool | Join thread, turn, call ID and tool name to the actual host receipt | A matching call ID alone can attach completion evidence to another registered tool |
| Continuing a completed delegated task | Use the control plane's explicit task-resume operation | Message delivery may queue information without scheduling the idle recipient |

These are conditional checks for the affected behavior. Do not turn each one into
an unrelated task gate. Preserve original failures and label fake-server, offline,
native, live-provider and package-install evidence separately. Tiny synthetic
decision cohorts establish a narrow observed result, not probability calibration
or general compaction quality.

- A Python utility inside an exact-inventory archive must disable bytecode before local imports. Test the documented plain `python3 --help` path with bytecode environment overrides absent; unchanged files must remain unchanged.
- Evidence discovery must distinguish control specifications from callback receipts. A broad witness glob can include its own spec and falsely reject a genuine native callback; validate receipt kind and identity before joining event digests.
- A prepared evaluation runner must match production state transitions before paid execution. Queued generation zero becomes claimed generation one; check that contract in offline preflight and freeze the corrected criteria before any model call.
- Usage fields need their producer scope. A native `tokenUsage.last` snapshot can omit earlier model requests within a tool-using turn; retain its label and keep cumulative usage unavailable rather than presenting a sum as total cost.
