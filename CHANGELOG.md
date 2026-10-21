# Changelog

## 0.4.0 — 2026-10-21

- Added a typed multi-line tool argument format that preserves source code, paths, and quotes while retaining JSON compatibility.
- Forwarded upstream reasoning events and concise task progress to DSH when provided by Tabbit.
- Improved long-task continuation and bounded repair of malformed tool calls; incomplete work is no longer reported as successful.
- Kept recent user instructions and unfinished work visible when continuing a task after context compaction.

## 0.3.1 — 2026-10-21

- Separated usage and model-card refresh state so repeated updates do not duplicate interface sections.
- Persisted token counters and labeled local estimates separately from upstream-reported usage.

## 0.3.0 — 2026-10-21

- Added token counters, recent request status, bounded SSE reconnection, and upstream event de-duplication.
- Added long-context attachment handling while preserving conversation roles and tool definitions.
- Kept estimated token counts out of DSH's currency ledger when Tabbit provides no official usage receipt.

## 0.2.0 — 2026-10-21

- Embedded the gateway in the plugin process with separate China and Global pools, loopback binding, and lifecycle cleanup.
- Added a tool-call bridge and long-context support through Tabbit's document-attachment flow.
- Kept the external `tabbit2api` mode available for users who explicitly configure it.

## 0.1.0–0.1.2 — 2026-10-20 to 2026-10-21

- Added account sign-in, credential and file import, account-pool management, quota and model multiplier display, and daily check-in.
- Added model catalog refresh and DSH-compatible streaming and tool-call conversion.
- Improved credential updates, account synchronization, and error reporting.
