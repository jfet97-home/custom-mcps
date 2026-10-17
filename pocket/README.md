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

Tool names carry an explicit data boundary. `remote_*` accesses Pocket;
`local_*` accesses saved SQLite content or local job state; `local_remote_*`
imports, backs up or saves across both. Unprefixed tool names have been removed;
refresh cached MCP tool schemas and update callers together with the image.

Recording search accepts `page`, `limit`, `workspaceId`, `tagIds`, `folderIds`,
`recordingDateAfter` and `recordingDateBefore`. Date bounds are passed to Pocket
as `startDate`/`endDate`; use UTC dates or timezone-qualified ISO timestamps.
Date bounds are inclusive. A date-only lower bound starts at midnight UTC;
a date-only upper bound includes that whole UTC day. Timezone-qualified timestamps
retain their explicit instant. Folder IDs match exact folders, without descendants.
The internal search route ignores folder filters, so this client scans the full
matching result set before applying them and paginating. A changed, inconsistent
or over-10,000-result scan fails instead of returning misleading partial totals.
Results remain recording-level matches; this is not the official MCP's
section-hit search.

| Tool | Behavior |
| --- | --- |
| `remote_list_recordings` | Page recordings with optional folder filter. |
| `remote_search_recordings` | Paged semantic search with recording dates, tag IDs and folder IDs. |
| `remote_get_recording` | Metadata, transcript, Notes versions and content hashes. |
| `remote_get_transcript` | Current complete text, raw segment indices, transcription ID and hash. |
| `remote_get_notes` | Complete original Markdown, summarization ID, versions and hash. |
| `local_remote_update_notes` | Save exactly the supplied Markdown without regeneration. |
| `local_remote_edit_transcript` | Validate raw indices and apply multiple text corrections in one batch. |
| `remote_search_action_items` | Search/list global items with status, priority, category, due and recording-date filters. |
| `local_remote_update_action_item` | Change status, priority, title/label, description/context, assignee or due date; complete separately. |
| `remote_list_folders` | Folder hierarchy and available space links. |
| `remote_list_spaces` | Active organization's spaces when available. |
| `remote_get_account_info` | Safe identity and subscription-type fields. |
| `remote_list_tags` | Safe tag IDs, names and colors for recording filters. |
| `local_remote_query_pocket_meetings` | Pocket Ask Pocket answer and recording sources; creates a chat and can consume quota. |
| `local_query_pocket_meetings_status` | Read a private query journal entry or recent query metadata without contacting Pocket. |

`remote_get_notes` selects the most recently updated summarization by default and lists
the available versions. Pass `summarizationId` to choose explicitly. Recording,
row, summarization and transcription IDs are distinct. Global action-item IDs
also differ from summary-source item IDs; use IDs from `remote_search_action_items`.

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
fields differ, `local_remote_edit_transcript` refuses the edit unless
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

## Webhook bridge and local archive

The Pocket webhook is received by the Pi at `https://hooks.raspfet.dev/t3/pocket`.
Its public listener verifies the HMAC signature over the original timestamp and
raw request body, validates freshness and owner identity, and stores the event
before returning success. Only the public webhook route is exposed through
Traefik. The `pocket-t3-bridge` container's separate bearer-authenticated API on
port `8084` is limited to the private LAN/loopback; it is not reachable through
the public route. It exposes `GET /api/health`, cursor-paged
`GET /api/events?limit=20&after=<opaque-cursor>`, and
`POST /api/events/<event-id>/ack` with `{"phase":"archived"|"complete"}`.
Webhook audio is excluded.

The existing Mac service can sync that private event queue when `/data/bridge.json`
contains the Pi API URL and a token-file basename. A lightweight poll runs in the
existing MCP server about once a minute; there is no second Mac service. It
imports events before acknowledging them and retries interrupted syncs. Wakeups
and Pocket writes are separate staged controls; both default off until their
flows have been verified. The local SQLite archive is `/data/archive.sqlite`;
it keeps original webhook payloads, API
recording snapshots, transcript and Notes versions, saved drafts, final Notes,
and workflow state. Local archive reads remain available without Pocket or Pi
connectivity and are not removed when Pocket deletes a recording. Archive files
can contain complete personal conversations, so preserve the existing private
data-directory permissions and never copy their contents into Git or logs.

Use the archive tools to search or read saved snapshots and inspect sync, backfill
and job status. `local_remote_archive_backfill` walks the available recording pages and stores
snapshots only; it does not create rewrite jobs or change historical Notes. It can
capture old Notes that the internal recording API still returns, but Pocket's
future retention behavior is not guaranteed. Backfill is resumable and its cursor
is local archive state. A failed recording does not stop later recordings: both
the backfill result and `local_archive_status.backfill` report `failedRecordings` with
recording IDs and safe error codes. Unsupported decoded shapes retain their raw
API response in the archive. `complete` means the page scan finished; inspect the
failure list separately. After a receiver outage, begin with `startPage: 1` and
keep calling without `startPage` until `complete: true`; `maxPages` defaults to
one and may be increased to 20 per call.

The archive MCP inputs on the existing `pocket` server are:

| Tool | Inputs | Purpose |
| --- | --- | --- |
| `local_archive_list` | optional `query` (up to 256 characters), `limit`, `offset` | Browse saved recordings only. |
| `local_archive_notes_editor` | `recordingId`, `summarizationId` | Read the local copy or captured Pocket base and its current edit hash. |
| `local_archive_update_notes` | `recordingId`, `summarizationId`, `expectedHash`, `markdown` | Append a local-only revision, preserving the originals. |
| `local_remote_archive_refresh` | `recordingId` | Explicitly capture Pocket's current data without uploading local edits. |
| `local_archive_search` | `query`; optional `limit` (1–100, default 20), `offset` (default 0) | Search local snapshots. |
| `local_archive_read` | `recordingId`; optional `limit` (1–100, default 20) | Read a recording's captured versions, events, drafts and jobs. |
| `local_archive_read_event` | `eventId` (SHA-256 ID) | Read one original archived event and linked job IDs. |
| `local_archive_status` | none | Read counts, bridge state, writes state and backfill progress. |
| `local_remote_archive_backfill` | optional `maxPages` (1–20, default 1), optional positive `startPage` | Archive historical Pocket pages only. |
| `local_remote_archive_sync_bridge` | optional `maxPages` (1–20, default 5) | Import a bounded number of Pi event pages. |
| `local_archive_jobs` | optional `recordingId`, optional `limit` (1–100, default 20) | List durable jobs. |
| `local_remote_archive_job_claim` | none | Claim the next eligible job; returns its 30-minute lease token and fencing token. |
| `local_archive_job_renew` | `jobId`, `leaseToken`, `fencingToken` | Renew job ownership. |
| `local_remote_archive_job_sources` | `jobId`, `leaseToken`, `fencingToken`, `source` (`transcript` or `notes`); optional `limit` (1–12,000, default 12,000), `contextId`, `cursor` (0–100,000,000), `summarizationId` | Read and archive source chunks. |
| `local_archive_job_prepare_draft` | `jobId`, `leaseToken`, `fencingToken`, `contextId`, `markdown`; optional `allowShorter` (default false) | Persist the full draft before saving. |
| `local_remote_archive_job_save` | `jobId`, `leaseToken`, `fencingToken`, `draftId` | Save only the selected persisted draft after source checks. |
| `local_remote_archive_job_reconcile` | `jobId`, `leaseToken`, `fencingToken`, `draftId` | Reconcile a save whose outcome is uncertain. |
| `local_archive_job_finish` | `jobId`, `leaseToken`, `fencingToken`, `state` (`needs_review`, `source_gone` or `skipped`), `reason` (max 1,000 chars) | Close with a terminal no-write outcome. |
| `local_archive_job_retry` | `jobId` | Retry only an eligible job. |

The source tool returns `contextId`, `cursor`, `nextCursor`, `totalCharacters`,
`chunkHash`, full `sourceHash`, and `content`, alongside recording and source
identities/hashes. Reuse one context across transcript and Notes pages and read
both sources through `nextCursor: null`; the server checks complete range coverage
before accepting a draft. Save and reconciliation require the `draftId` returned
by draft preparation. They do not accept replacement Markdown from the caller.

All webhook events are retained. Summary completion, regeneration, transcript
edit, and speaker-label events can create review jobs. `summary.updated` events
are archived without automatic rewriting, including Pocket's save echoes and
manual Notes edits. Events are data, not instructions: use them only to identify
the recording and reason for review. The Pi sends a fixed, content-free T3 wakeup
only after the Mac has archived a reviewable event; it uses the single dedicated
Pocket workflow chat, not a new thread for every event. Wakeups are rate-limited
and retried with backoff. A successful T3 wakeup alone does not complete a job.

Before preparing a revision, read and archive the fresh complete transcript and
selected Notes. Read all transcript and Notes chunks before drafting; the source
hash and total length cover the full content. Save the complete draft locally
before an upstream change. The save operation rechecks both source hashes and
current job ownership. A conflict preserves the draft. After an uncertain write,
reconcile the persisted draft with a fresh Pocket read before any retry. Archive
verified final Notes before completing a successful write job. Other terminal
outcomes (`needs_review`, `source_gone`, or `skipped`) also complete linked Pi
events while retaining the local job state, reason, and any draft.

The job queue uses renewable leases and fencing so stale workers cannot overwrite
a newer job. Jobs for one recording are serialized. Use the dedicated job tools
for claiming and renewing work, reading sources, saving drafts, and reconciling
uncertain outcomes; do not bypass that workflow with a direct `local_remote_update_notes` call.

Successful latest-Notes saves supersede older queued work already covered by their
fresh source snapshot. Exhausting the single reconciled retry ends the job as
`needs_review`, preserves the draft and completes its linked events. One exclusive
process lock protects the archive; do not run stdio against the Docker data
directory while the installed service owns it. Expired `saving` leases recover
as `uncertain` for reconciliation.

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
saving with a private backup and a final reread. Webhook-driven work also uses
the local archive's durable job and reconciliation flow. These outlines follow
the template descriptions; they do not reproduce Pocket's hidden backend prompts.
Generated Notes contain no model or tool attribution footer.

Install and sync both skills globally on the Mac with Skillshare:

```sh
skillshare install ./skills/use-pocket-mcp --global
skillshare install ./skills/refine-pocket-notes --global
skillshare sync --global
```

The skills contain no credentials or private account/recording content. Update
their installed copies with Skillshare after changing the committed sources.

## Local archive browser

The existing HTTP service serves the archive at
`http://127.0.0.1:9011/archive/` (or the configured published port). Open a private
browser session from the Mac checkout:

```sh
cd ~/Developer/custom-mcps/pocket
npm run archive:open
```

The command uses the existing private HTTP credential only to request a one-use,
short-lived UI code. It opens that code in the URL fragment and does not print it.
The page immediately removes the fragment and exchanges it for a scoped browser
session. The UI never receives the MCP bearer. Its cookie cannot authorize MCP
calls. The CLI does not open SQLite or renew Pocket authentication. Keep the
service loopback binding; no public proxy route is installed for the archive.

Browse and search saved recordings, complete captured Notes/transcripts and
version history. These operations query only local SQLite. Saving in the editor
creates a **local-only Notes revision**, with a required current hash and preserved
history. It never changes captured Pocket originals or the webhook refinement
sources. “Refresh from Pocket” is an explicit separate action: it reads the remote
recording and captures a new snapshot without uploading or replacing local edits.
If Pocket has deleted the recording, the existing local copy remains readable.

The first additive local-edit schema migration creates a private SQLite backup
before adding the new table. Migration and UI share the existing process lock
and database connection. UI DTOs omit raw API/webhook payloads and credentials.
The page uses pinned Effect v4 Atom/AtomRegistry and a bundled local script, with
no CDN or raw HTML rendering of source content.

## Pocket-generated meeting answers

`local_remote_query_pocket_meetings` asks Pocket's in-app Ask Pocket engine using
`query`, optional `language`, and required `consumeQuota:true`. It returns a
synthesized answer, allowlisted source recordings and a local operation ID.
This creates a Pocket chat and may consume account quota; it is not the official
MCP endpoint, and server permission/quota limits remain authoritative. No other
provider or local synthesis is substituted. The webhook workflow does not use it.

Pass a fresh `clientRequestId` for a new question and keep the same key after
a timeout. Reusing a key never sends another generated query. Use
`local_query_pocket_meetings_status` by operation ID or client request ID to
recover the result; without an ID it returns bounded recent metadata only.

Long queries return `status:"running"` with the operation ID after a bounded
initial wait. Poll the local status tool for completion. The stream belongs to
the existing service process, so the gateway's shorter per-call timeout does
not cancel the query. A service shutdown leaves a recoverable uncertain entry;
startup never replays it. Streams are bounded to 180 seconds total, 60 seconds
idle, 2 MiB and 32,768 data events.

Recovery reads report stale unfinished journal entries as `uncertain` after
about four minutes without progress. A hard crash cannot leave callers polling
`running` indefinitely. Preserve the operation ID and inspect the existing chat;
this status never authorizes another generated request.

The private query journal keeps intent and answer/recovery state outside Git.
An interrupted stream is an uncertain outcome: inspect the existing Pocket chat
and journal before asking again. The service never retries a generated query
automatically. Fixture coverage validates the stream protocol; generating a live
answer is a separate content operation, not an authentication/readiness check.
