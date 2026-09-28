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

These are conditional checks for the affected behavior. Do not turn each one into
an unrelated task gate. Preserve original failures and label fake-server, offline,
native, live-provider and package-install evidence separately. Tiny synthetic
decision cohorts establish a narrow observed result, not probability calibration
or general compaction quality.
