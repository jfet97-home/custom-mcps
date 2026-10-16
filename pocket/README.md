# Pocket personal MCP

Personal Pocket integration with complete original AI Notes and transcripts,
Markdown saving, transcript corrections and global action-item updates. Uses
TypeScript and Effect **4.0.1**, including native MCP tools and Streamable HTTP
from `effect/ai`. All Effect adapters are pinned to the same version; commit
`package-lock.json` with dependency changes.

## Runtime and private state

The service runs in **Docker**, directly serving MCP HTTP. No Supergateway,
transport proxy or native Pocket LaunchAgent is used. Its source, Dockerfile,
Compose and dependency pins live in this component.

- Compose project and service: `pocket-mcp`.
- Docker context: `desktop-linux` by default.
- MCPX upstream: `http://pocket-mcp:9011/mcp` on `lunar-mcpx_default`.
- Host endpoint: `http://127.0.0.1:9011/mcp`; public health: `/health`.
- Private host data: `~/Library/Application Support/pocket-mcp`, mounted at `/data`.
- Session: `/data/firebase-session.json`; HTTP bearer secret: `/data/http-token`.
- Backups: `/data/backups`, visible in the same host directory as before.

Private directories use mode `0700`; session, secret and backup files use `0600`.
The persistent refresh credential is an unencrypted, owner-only file, outside
Git and build contexts. Renewal writes a new file, syncs it and atomically renames
it. The data directory is writable because Firebase can rotate the refresh token.
The server uses a private process lock in that same directory to coordinate
renewals, login and logout across host and container processes.

The image uses a digest-pinned Node 24 base. Compose runs it with the data owner's
UID/GID, a read-only root filesystem, a temporary `/tmp`, dropped capabilities
and a 90-second graceful shutdown period. The defaults `501:20` match this Mac;
set `LOCAL_UID` and `LOCAL_GID` for another host. The deployment command derives
both automatically. Keep the source bind mount outside the container; the image
contains built application code and pinned production dependencies only.

## Login and renewal

For a fresh account session, run the browser bootstrap **on the host**:

```sh
npm ci
npm run build
npm run login
```

This is an on-demand command, not a host background service. It opens the real
Pocket website in a fresh dedicated Chrome profile and waits for normal Google,
Apple or email login. It reads Firebase persistence only for that profile and
Pocket's origin, checking IndexedDB before localStorage. It discovers the current
Firebase project configuration from Pocket's client, verifies renewal and Pocket
account identity, then saves the refresh credential directly in the private
session file. No personal Pocket API key or pasted short-lived token is needed.
No account creation or provider linking is performed.

The dedicated browser and its profile are cleaned on completion or cancellation.
Personal browser profiles are never read. Set `POCKET_CHROME_PATH` when Chrome
is installed elsewhere. If a browser cannot be stopped, cleanup retains its
private profile and reports the path. Close that dedicated window before retrying.
The temporary loopback debugging port exists only during login.

The container renews ID tokens two minutes before expiry, shares renewal among
concurrent callers and persists rotated refresh credentials. After a later host
login, the running server notices the changed file on its next operation.

```sh
docker --context desktop-linux compose exec -T pocket-mcp node dist/src/cli.js auth status
```

`auth status` performs a real renewal and reports identity/expiry without secrets.
A missing or revoked session returns `authenticated=false`; network/storage
failures remain errors. With explicit intent to sign this integration out:

```sh
docker --context desktop-linux compose exec -T pocket-mcp node dist/src/cli.js logout
```

Logout removes this component's session file and is observed by the running
server's cache. It does not revoke other Pocket application sessions.

### Migrate an earlier Keychain installation

Stop the previous `com.jfet97.pocket-mcp` LaunchAgent before migrating so it cannot
renew against a separate credential store. On the Mac, after building this source:

```sh
node dist/src/cli.js auth migrate-keychain
node dist/src/cli.js auth status
```

Migration reads only Keychain service `pocket-personal-mcp`, account
`firebase-session`, and writes the private session file without printing its
contents. It refuses to overwrite an existing file session. If already migrated,
check `auth status` instead. Verify the Docker deployment and a real MCPX read
before removing the retired Keychain entry, LaunchAgent plist and CLI wrapper.
Preserve backups and recording content during that cleanup.

## Deploy and connect

Commit the component source, then run:

```sh
npm run build
npm run install-service
```

`install-service` deploys Docker. It refuses uncommitted component changes, exports
the selected Git commit into a temporary build context, builds a revision-tagged
image and starts `pocket/compose.yaml` with `--no-build --wait`. It checks the health
revision and records image ID, source revision and Compose path in private
`deployment.json`. The temporary build context is removed. The running container
loads code from the image, not from the checkout. Set `POCKET_DOCKER_CONTEXT` to
select another Docker context or `POCKET_DATA_DIR` for another private directory.

The installer creates the HTTP bearer secret if absent. Keep MCPX's `pocket`
connection using Streamable HTTP at `http://pocket-mcp:9011/mcp`, with its private
Authorization header read from `http-token`. Never print that value or put it in
Compose, shell history or Git. Reuse the saved header when moving the endpoint.
Preserve unrelated MCPX services and its configuration/state volumes.

Inside Docker, `POCKET_HOST=0.0.0.0` exposes the service to the shared network;
the published host port binds only to `127.0.0.1`. Browser Origins and unrecognized
Host headers are rejected. All MCP requests require the bearer secret, while
health exposes no identity. The optional local CLI defaults to loopback when run
outside Docker. Stdio remains available for supported direct use but is not the
installed transport. Request bodies are limited to 12 MiB, and logs contain safe
status/error information only.

### Startup and routine operations

Compose uses `restart: unless-stopped`. On this Mac, the existing
`dev.docker.autostart` login job starts Docker Desktop; Docker then starts the
container. A deliberately stopped container stays stopped until explicitly
started again. No Pocket-specific login job is needed.

Run these from `pocket/`, choosing the requested operation:

```sh
docker --context desktop-linux compose ps
docker --context desktop-linux compose logs --tail 50 pocket-mcp
docker --context desktop-linux compose stop pocket-mcp
docker --context desktop-linux compose start pocket-mcp
```

Use `npm run install-service` for an upgrade or recreation so the image remains
bound to committed source. Do not use `down -v` or remove the private data directory.
A health check verifies HTTP readiness; verify Firebase renewal and an actual
read through MCPX separately. A configured restart policy and login job do not
constitute a reboot test.

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

For the Docker image and its isolated runtime check:

```sh
docker --context desktop-linux compose config --quiet
docker --context desktop-linux buildx build --check .
docker --context desktop-linux build -t pocket-personal-mcp:check .
POCKET_DOCKER_CONTEXT=desktop-linux npm run test:container
```

The container check uses temporary fixture state, validates native HTTP and bearer
protection, and exercises file-session storage under the real non-root UID and
read-only root filesystem. It removes its own container and fixture directory.

Tests include real stdio and HTTP protocol handshakes/tool calls, typed failures,
hash conflicts, ID selection, raw transcript indices, private backups, concurrent
renewal, actual subprocess lock coordination, bearer authentication, login-process
cleanup, persistent file credentials, stdio EOF, post-send uncertainty and interrupted
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
