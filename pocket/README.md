# Pocket personal MCP

Personal Pocket integration with complete original AI Notes and transcripts,
Markdown saving, transcript corrections and global action-item updates. Uses
TypeScript and Effect **4.0.1**, including native MCP tools and transports from
`effect/ai`, `Context.Service`, schemas, configuration, layers, locks and scoped
process/server cleanup. The Effect Node adapters and shared adapter are pinned
to the same version; commit `package-lock.json` with dependency updates.

## Login and session lifecycle

```sh
npm ci
npm run build
node dist/src/cli.js login
node dist/src/cli.js auth status
```

`login` opens the real Pocket website in a **dedicated Chrome profile**, waits
for the normal Google, Apple or email login, and reads Firebase persistence
only in that profile and the Pocket origin. It checks IndexedDB first and
localStorage second. The active Firebase Web configuration is discovered from
Pocket's current HTML/client bundle and matched to the authenticated session.
This Web API key identifies Pocket's Firebase project; it is not a personal
Pocket API key. No account creation or provider linking is performed.

After verifying renewal and access to the Pocket account, the command saves
the refresh credential in the operating system secret store. On macOS this is
Keychain, service `pocket-personal-mcp`, account `firebase-session`. The browser
closes and its dedicated profile is deleted after successful export. Personal
browser profiles are never read. Set `POCKET_CHROME_PATH` when Chrome is installed
elsewhere. A failed login can leave its private profile for a later retry.

The server renews ID tokens two minutes before expiry, shares one renewal across
concurrent calls, and persists refresh-token rotation. A private cross-process
lock coordinates renewal, login and logout. `auth status` performs a real renewal
in a fresh process; it reports identity and expiry without credentials.

```sh
node dist/src/cli.js logout
```

Logout deletes the component's saved credential. The running server checks the
store before using its token cache and therefore observes logout on its next
operation. It does not revoke other Pocket application sessions. A revoked or
expired Firebase session produces an `authentication` error requesting login.
There are no token/password inputs or interactive approvals in MCP tools.

## Run and connect

```sh
node dist/src/cli.js stdio
node dist/src/cli.js serve
```

HTTP is Streamable HTTP at `http://127.0.0.1:9011/mcp`; health is `/health`.
The service binds only to loopback, rejects browser Origins and foreign Host
headers, and accepts `host.docker.internal` so the existing Docker MCPX gateway
can reach it. Logs go to stderr and never contain tokens, headers or recording
content. Treat access to this computer and its Docker engine as trusted.

The actual Mac deployment is a **native LaunchAgent**, allowing direct Keychain
access without passing the refresh credential into a container. After committing
and building the source:

```sh
npm run install-service
```

This installs `com.jfet97.pocket-mcp`, starts it at login, and installs a
`~/.local/bin/pocket-mcp` wrapper. The installer records the source revision
privately and refuses uncommitted component changes. Add `~/.local/bin` to PATH
if needed. Re-run the installer after a committed update and rebuild.

Point the MCPX upstream named `pocket` to
`http://host.docker.internal:9011/mcp` using `streamable-http`. This replaces the
official upstream while keeping the gateway's other integrations intact.

`POCKET_DATA_DIR` defaults to
`~/Library/Application Support/pocket-mcp`; `POCKET_PORT` defaults to `9011`.
Backups, logs and deployment settings stay there, outside Git. Files containing
content use mode `0600`; private directories use `0700`. Private directories
inside Git checkouts or final-component symlinks are rejected. No credentials,
browser profiles or backups belong in Docker contexts; `.dockerignore` uses an
explicit source allowlist.

On Linux, run stdio/HTTP under a user service with an available OS Secret Service.
The macOS installer and its Keychain storage are not a container deployment;
there is no container-to-Keychain dependency or automatic credential export.

## Tools and editing

| Tool | Behavior |
| --- | --- |
| `list_recordings` | Page recordings with optional folder filter. |
| `search_recordings` | Pocket hybrid semantic search, up to 100 results. |
| `get_recording` | Metadata, full segmented transcript and all Notes versions. |
| `get_transcript` | Complete text, raw segment indices, transcription ID and hash. |
| `get_notes` | Complete original Markdown, summarization ID, versions and hash. |
| `update_notes` | Save exactly the supplied Markdown without regeneration. |
| `edit_transcript` | Validate raw indices and apply multiple text corrections in one batch. |
| `search_action_items` | Search/list global items with actual global IDs and hashes. |
| `update_action_item` | Change title/due date, or completion in a separate call. |
| `list_folders` | Folder hierarchy and available space links. |
| `list_spaces` | Active organization's spaces when available. |
| `get_account_info` | Safe identity and subscription-type fields. |

`get_notes` selects the most recently updated summarization by default and lists
the available versions. Pass `summarizationId` to choose explicitly. Recording,
row, summarization and transcription IDs are distinct. Global action-item IDs
also differ from summary-source item IDs; use IDs from `search_action_items`.

Before a write, pass `expectedHash` from its read tool, and optionally
`expectedVersion` for Notes. Each operation saves a private backup, rereads the
current content, applies one upstream mutation, and verifies by reading again.
Writes are serialized in the service. Pocket exposes no atomic compare-and-swap
for these routes: another editor can still race between the final read and write.

Errors distinguish authentication, permission, conflicts, validation, network,
storage, upstream and uncertain write outcomes. Safe GETs retry once; mutations
never retry automatically. After `uncertain_write`, read current content and
reconcile it with the intended change before making another write. A timeout can
mean the server already applied the operation.

Backups are `<POCKET_DATA_DIR>/backups/<backupId>.json`, containing resource IDs,
timestamp, hash and original content. Notes backups contain the full Markdown;
transcript backups contain all segments, including `originalText`. Recovery uses
the original content through the normal write tool with a freshly read hash.
Keep backups until they are no longer useful; there is no automatic deletion.

Pocket's public REST API is documented primarily for personal API keys. This
installation uses Firebase-authenticated internal reads and writes to avoid a
second credential. Internal contracts were verified from the live application
bundle and authenticated requests; they can change independently of public APIs.
Unsupported response shapes fail explicitly. No arbitrary URL proxy, recording
deletion, regeneration, organization administration or billing operations exist.

## Verification

```sh
npm run lint:fix
npm run typecheck
npm test
```

Tests include real stdio and HTTP protocol handshakes/tool calls, typed failures,
hash conflicts, ID selection, raw transcript indices, private backups, concurrent
renewal and cross-process locks, no mutation retries, and interrupted restoration.

For an explicitly authorized reversible live check on a sample recording:

```sh
npm run verify-live -- RECORDING_ID
```

The harness backs up original Notes and the full transcript, compares current
state, applies a recognizable temporary marker, rereads it, restores the original
and verifies restoration. Cleanup runs on interruption and uses bounded recovery
reads. Concurrent content is never blindly overwritten. Pocket updates both
`text` and `originalText` for text edits; the test verifies both plus segment
structure and transcription identity. If recovery cannot be verified, it reports
the unresolved state and keeps the private backup.
