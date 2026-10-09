# Changelog

## 0.5.0

**BREAKING:** the tool argument `receipt_id` is now `ticket_id` (HAP v0.7
vocabulary); the Suveren gateway fills it — use gateway v0.7 or later.

This is a breaking change on the wire, released as a minor by the owner's
decision (pre-1.0, one implementation). `release` still forwards the value to
the downstream GitHub Actions `workflow_dispatch` as that workflow's
`receipt_id` input — the workflow YAML (in a different repository) is
unchanged and out of scope for this rename.

Also: `server` is now exported from `src/index.ts`, and the stdio transport
only connects when the module is run directly (guarded on
`import.meta.url === file://${process.argv[1]}`) — so tests can register an
in-memory transport against the real tool registrations without starting a
stdio server as a side effect of import.
