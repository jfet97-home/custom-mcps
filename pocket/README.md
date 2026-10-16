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

`login` opens the real Pocket website in a **fresh dedicated Chrome profile**, waits
for the normal Google, Apple or email login, and reads Firebase persistence
only in that profile and the Pocket origin. It checks IndexedDB first and
localStorage second. The active Firebase Web configuration is discovered from
Pocket's current HTML/client bundle and matched to the authenticated session.
This Web API key identifies Pocket's Firebase project; it is not a personal
Pocket API key. No account creation or provider linking is performed.

After verifying renewal and access to the Pocket account, the command saves
the refresh credential in the operating system secret store. On macOS this is
Keychain, service `pocket-personal-mcp`, account `firebase-session`. The browser
closes and its dedicated profile is deleted on success, failure and cancellation,
after waiting for its process group to exit. Personal
browser profiles are never read. Set `POCKET_CHROME_PATH` when Chrome is installed
elsewhere. If the browser cannot be stopped, cleanup reports a failure and retains
the private profile for inspection rather than removing files under a running process.
The loopback debugging port is temporary and accessible to other local processes
during login; it is closed with the dedicated browser. Normal terminal hang-up
uses the same cleanup. After a forced kill, close the leftover dedicated window
and rerun login: process markers allow safe stale-profile removal, without
terminating processes whose identity cannot be established. Legacy profiles are
removed after their browser is closed.

The server renews ID tokens two minutes before expiry, shares one renewal across
concurrent calls, and persists refresh-token rotation. A private cross-process
lock at the default private data directory coordinates renewal, login and logout,
even when instances use different `POCKET_DATA_DIR` settings. If that location is
unusable, set the same `POCKET_SESSION_LOCK_DIR` on every instance. The installer
preserves it in both the service and CLI wrapper. Cached calls check
Keychain without acquiring that lock. `auth status` performs a real renewal
in a fresh process; it reports identity and expiry without credentials.

```sh
node dist/src/cli.js logout
```

Logout deletes the component's saved credential. The running server checks the
store before using its token cache and therefore observes logout on its next
operation. `auth status` reports `authenticated=false` for a missing or revoked
session; network/storage failures remain errors. Logout does not revoke other
Pocket application sessions. A revoked or
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
can reach it. MCP requests also require a random per-install bearer secret from
`<POCKET_DATA_DIR>/http-token` (owned regular file, mode `0600`). The public health
route contains no account information. `install-service` creates the secret; for a
manual HTTP setup call `ensureHttpToken` from the built `http-auth` module first.
Stdio uses its parent process boundary and does not need this HTTP secret.
Request bodies are limited to 12 MiB. Logs go to stderr and contain only safe
status/error messages and write backup IDs/outcomes, never tokens, headers or
recording content.

The actual Mac deployment is a **native LaunchAgent**, allowing direct Keychain
access without passing the refresh credential into a container. After committing
and building the source:

```sh
npm run install-service
```

This installs `com.jfet97.pocket-mcp`, starts it at login, and installs a
`~/.local/bin/pocket-mcp` wrapper. The installer records the source revision
privately and refuses uncommitted component changes. It exports the committed
source into a private temporary build, installs the pinned lockfile, builds from
empty output, prunes development dependencies and copies the result into a
read-only versioned release under
`<POCKET_DATA_DIR>/releases/<commit>`, verifies its manifest, then waits for the old
process to exit and the replacement to become ready. The running service never
loads code from the checkout. Node is resolved through a stable absolute path;
set `POCKET_NODE_PATH` if needed. Version-specific Nix store paths are rejected.
Add `~/.local/bin` to PATH if needed. Re-run the installer after a committed update.

Point the MCPX upstream named `pocket` to
`http://host.docker.internal:9011/mcp` using `streamable-http`. This replaces the
official upstream while keeping the gateway's other integrations intact. Configure
its private `Authorization` header as `Bearer <contents of http-token>` through
local tooling that reads the file directly; never paste the value into chat or
commit it. The Firebase refresh credential remains exclusively in Keychain.

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
| `get_recording` | Metadata, transcript, Notes versions and content hashes. |
| `get_transcript` | Current complete text, raw segment indices, transcription ID and hash. |
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

Every write requires `expectedHash` from a fresh read tool. Transcript hashes bind
content to the transcription ID. Notes version fields describe source formats,
not edit revisions, and are diagnostic only. Each operation saves a private raw
backup, rereads the
current content, applies one upstream mutation, and verifies by reading again.
Writes are serialized within each server process. Avoid running multiple writers
against the same content. Pocket exposes no atomic compare-and-swap
for these routes: another editor can still race between the final read and write.

Errors distinguish authentication, permission, conflicts, validation, network,
storage, upstream and uncertain write outcomes. Safe GETs retry once; mutations
never retry automatically. After `uncertain_write`, read current content and
reconcile it with the intended change before making another write. A timeout can
mean the server already applied the operation. Every post-send failure is
`uncertain_write`; failures after backup creation include `backupId`. Sending and
verification drain on cancellation or a normal service stop, subject to bounded
network timeouts, a 45-second send/verification deadline and the service manager's
shutdown limit. Token acquisition/renewal happens before that protected phase. A forced kill or power
loss can still interrupt them; retain the private backup.

Backups are `<POCKET_DATA_DIR>/backups/<backupId>.json`, containing resource IDs,
timestamp, hash and original content. Mutation backups contain both the decoded
document and full raw recording/action response, preserving unrecognized fields.
Notes recovery uses `content.document.markdown` through the normal write tool
with a freshly read hash.

Pocket transcript edits overwrite **both** `text` and `originalText`. When these
fields differ, `edit_transcript` refuses the edit unless
`allowOriginalTextOverwrite=true`. Backups preserve their distinction and the raw
`originalTranscription`, but the verified text-edit endpoint cannot restore two
different values separately. Full automatic restoration of that distinction is
therefore unavailable. Legacy unsegmented transcripts remain readable but are
not editable by segment. Verification compares every segment, including unedited
ones, and the transcription identity.
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
renewal, actual subprocess lock coordination, bearer authentication, login-process
cleanup, immutable releases, stdio EOF, post-send uncertainty and interrupted
write verification/restoration.

For an explicitly authorized reversible live check on a sample recording:

```sh
npm run verify-live -- RECORDING_ID
```

The harness backs up raw recording responses plus original Notes and the full transcript, compares current
state, applies a recognizable temporary marker, rereads it, restores the original
and verifies restoration. Cleanup runs on interruption and uses bounded recovery
reads. Concurrent content is never blindly overwritten. Pocket updates both
`text` and `originalText` for text edits; the test verifies both plus segment
structure and transcription identity. If recovery cannot be verified, it reports
the unresolved state and keeps the private backup.

The live account checks cover complete Notes (including a 10,627-character
original document), recording/search/account reads, action-item list/search,
folders and the no-active-organization spaces response. Notes and multi-segment
transcript saves/restoration were verified through MCPX on the sample recording.
Action-item mutations and nonempty folder/organization-space responses are
covered by fixtures or client-contract research, not by live mutations on this
account. Backend edit timestamps can change even when original text is restored.

## Usage skills

The committed [use-pocket-mcp skill](skills/use-pocket-mcp/SKILL.md) describes
normal gateway discovery, complete reads, expected hashes, raw segment indices
and uncertain-write recovery.

The [refine-pocket-notes skill](skills/refine-pocket-notes/SKILL.md) combines the
complete transcript, current edited Notes and selected writing structures into
one revised document. It includes Deep Summary and Action Summary outlines,
preserves existing additions and uncertainty, and checks both sources before
saving with a private backup and a final reread. These outlines follow the
template descriptions; they do not reproduce Pocket's hidden backend prompts.
Revised Notes end with the runtime model version, MCPX attribution and the edit
date and time, including the user's time zone and UTC offset.

Install and sync both skills globally on the Mac with Skillshare:

```sh
skillshare install ./skills/use-pocket-mcp --global
skillshare install ./skills/refine-pocket-notes --global
skillshare sync --global
```

The skills contain no credentials or private account/recording content. Update
their installed copies with Skillshare after changing the committed sources.
