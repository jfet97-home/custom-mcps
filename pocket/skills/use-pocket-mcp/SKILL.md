---
name: use-pocket-mcp
description: Read and edit complete Pocket AI Notes and transcripts, search recordings and action items, and consult account, folders and spaces through the personal Pocket MCP. Use for Pocket content tasks; see the repository deployment guide for service installation.
---

# Use Pocket MCP

Use the personal server named `pocket` through the existing Lunar MCPX gateway.
Its upstream tool names normally start with `pocket__`; use the actual names and
schemas returned by this client's discovery tools. Do not switch to the official
Pocket MCP, whose Free-account tool surface differs.

For synthesis that combines a full transcript, current edited Notes and a
writing structure such as Deep Summary plus Action Summary, use
[refine-pocket-notes](../refine-pocket-notes/SKILL.md).

## Discover and read

Start with advertised server discovery, search a small Pocket shortlist with
`mcpx_search_tools`, inspect the selected schema with `mcpx_get_tool_schema`, then
call it with `mcpx_call_tool`. Permitted `mcpx__management_*` tools are direct
management operations. Some clients expose upstream tools directly.

- `list_recordings` has page/limit/folder filtering and total/page metadata.
- `search_recordings` uses Pocket semantic search, up to 100 matches; it has no
  verified cursor. A search result is not the full Notes document.
- `get_recording` returns metadata, transcript, Notes versions and content hashes.
- **`get_notes` returns the complete original Markdown**, its `summarizationId`,
  row ID, hash and version choices. Default selection is latest updated; pass a
  returned `summarizationId` to choose explicitly. Preserve the full Markdown
  when requested; do not substitute section summaries or regenerate it.
- `get_transcript` returns complete current text, raw indexed segments,
  `transcriptionId`, hash and whether segment editing is supported. Empty
  segments still occupy indices. Legacy string transcripts are readable only.
- `search_action_items` lists or searches global items with global IDs and
  hashes. Advance offset by `pagination.returned`, which counts child tasks,
  rather than the flattened result length (which may include parents).
- `get_account_info`, `list_folders` and `list_spaces` are reads. Personal accounts
  can return no active organization and no spaces; do not infer an auth failure.

Recording IDs, transcription IDs, summarization IDs, summarization row IDs and
summary-source/global action-item IDs are distinct. Take IDs from the actual
read result. Notes version fields describe source formats, not edit revisions.

## Save requested changes

Use the user's existing authorization; the tools do not require a separate
interactive approval for every save. Read current content first and provide its
**required `expectedHash`**. If content changed since the user's intended edit,
reconcile it instead of obtaining a new hash just to force an old replacement.

- `update_notes`: provide recording ID, summarization ID, complete replacement
  Markdown and the Notes hash. Saves supplied Markdown without AI regeneration.
- `edit_transcript`: provide recording ID, transcript hash and a corrections
  array of raw `segmentIndex`/`text` pairs. Batch related corrections. Pocket
  overwrites **both `text` and `originalText`**. When they already differ, inspect
  that distinction and only pass `allowOriginalTextOverwrite=true` if the user's
  requested correction authorizes losing it. The verified edit endpoint cannot
  restore two distinct field values separately.
- `update_action_item`: use the global ID, recording ID and item hash returned
  by search. Change title/dueDate, or completion in a separate call; completion
  cannot be combined with other fields. Use ISO dates/times or null for dueDate.

Each mutation creates a private backup, compares again, sends one write and
verifies with a reread. Comparison is client-side, not atomic: an app edit can
still race the final comparison. Writes serialize within one server process.

A verified result includes its new hash and `backupId`. After `uncertain_write`,
**reread before another write**: a timeout, cancellation or failed verification
can follow an applied save. Compare current content with the intended result
and the private backup. Do not blindly repeat or automatically restore over
someone else's changes. Errors after backup creation identify that backup.

## Authentication and recovery

The Mac service renews Firebase sessions from macOS Keychain automatically. No
personal Pocket API key or pasted short-lived ID token is needed. For an auth
error, use `pocket-mcp auth status`. If login is missing/revoked, run
`pocket-mcp login` and let the user sign in normally in its fresh dedicated Chrome
window. Never read existing personal browser profiles or request tokens in chat.
`pocket-mcp logout` removes this service's credential and needs user intent.

Connection failure is separate from account authentication. If the service has
restarted, permitted targeted MCPX reconnect can restore its saved connection;
refresh tool schemas only when necessary. Preserve unrelated upstreams/settings.
Never retrieve or print saved credentials or HTTP Authorization headers.

The service has no deletion, regeneration, organization administration or billing
tools. Internal Pocket APIs can change; report unsupported responses rather than
inventing alternative endpoints. Action-item mutations have fixture coverage;
Notes/transcript saves and restoration have been verified live through MCPX.

For local service installation, Keychain/HTTP-secret configuration, private
backup paths and source maintenance, use the committed `pocket/README.md` in
`jfet97-home/custom-mcps`. Ordinary content tasks need no checkout or Docker work.
