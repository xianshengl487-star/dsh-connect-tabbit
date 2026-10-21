# Architecture

```text
DSH model adapter
  → private loopback shim
    → embedded OpenAI-compatible gateway
      → selected Tabbit edition

Local account store → in-memory gateway execution copy
Settings panel      → account pool, models, quota, multipliers, usage, check-in
```

The gateway and shim are created by the plugin at runtime. Each edition has an isolated account pool and gateway. The gateway binds to loopback on a random port, uses a process-local random key, and is closed when the plugin stops.

The adapter preserves DSH message roles, tool definitions, tool call IDs, and tool results. A returned tool call is validated and passed to DSH for execution. The model's text is never treated as evidence that a tool completed.

Long conversations may be sent through Tabbit's document attachment flow when they exceed the web input limit. The request keeps the complete context and tool definitions in the attachment while retaining the current instruction in the message body. This is a transfer to Tabbit and follows its retention and privacy behavior.

The streaming path uses keep-alives, event IDs, bounded reconnects, and duplicate suppression where the upstream supplies the required event data. It surfaces a failed or incomplete stream rather than reporting it as a completed response. These safeguards cannot remove upstream availability or account limits.
