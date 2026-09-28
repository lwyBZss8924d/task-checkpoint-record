# Helper process interface v1

The service invokes an explicit executable with argv; never a shell command string.
The default executable name is `ultrafast-atif-helper`. Input files and source roots
come from an explicit task binding. The process deadline and stdout byte cap are
enforced by the service independently of helper limits.

## Ingest

`ultrafast-atif-helper ingest --input PATH --format codex|claude|pi|atif
--allow-root ROOT --offset BYTE_OFFSET --limit N --max-bytes N --json`

Success is a single JSON object with `schema_version: ultrafast-atif.page.v1`,
`records`, `next_offset` (integer or null), `eof`, `incomplete_tail`, and `omissions`.
There is no model call. JSONL output selects complete records; a partial last record
is left for a later read. Unknown context at a resumed offset stays unknown rather
than inheriting the requesting Hook's turn ID. ATIF is a bounded whole-document
read with JSON Pointer selectors; its native version remains unchanged.

Each record contains:

```json
{
  "record_id": "generated-content-identity",
  "client": "codex",
  "kind": "message",
  "timestamp": null,
  "native": {
    "session_id": null,
    "turn_id": null,
    "entry_id": null,
    "parent_entry_id": null,
    "trajectory_id": null,
    "step_id": null
  },
  "source": {
    "uri": "file:///absolute/source.jsonl",
    "format": "codex",
    "version": null,
    "offset": 0,
    "length": 100,
    "sha256": "64-lowercase-hex-characters",
    "json_pointer": ""
  },
  "labels": [],
  "text_available": true
}
```

The illustrative digest above is not valid evidence. No transcript body is returned
by default. Optional local content retrieval is a separate explicit operation with
byte limits and redaction. The normalizer records actual source identity facts only;
the service adds task/window relationships from its independently observed binding.

## Query and source resolution

Provide exact native/task/version/kind filters, explicit field selection and bounded
pagination. Source resolution verifies the selected digest/range before returning
anything. A record ID or deeplink grants no source access by itself.

## Errors

Emit bounded structured errors to stderr and use a nonzero exit code for invalid
arguments, changed/truncated sources, unsupported formats or budget violations.
Do not print the rejected source body, credentials, arbitrary input metadata or
unbounded exception text. No implicit source rewrite, model fallback or retry.
