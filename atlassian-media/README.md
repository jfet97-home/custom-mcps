# Atlassian media MCP

A small read-only MCP server for original images embedded in Confluence whiteboards.
It complements the Atlassian Rovo MCP: Rovo supplies the SVG; this server retrieves
the image files referenced by the SVG's `data-file-id` attributes.

The implementation uses Effect v4, including `Config` and redacted configuration
values. It bootstraps a short-lived Media token from Confluence content, then
downloads exact file UUIDs using the Media token and returned client ID. It never
uses browser cookies or scans the site's attachment inventory.

## Credentials

The running server reads its **environment directly through Effect Config**.
Set `ATLASSIAN_SITE_URL`, `ATLASSIAN_CLOUD_ID`, `ATLASSIAN_AUTH_MODE=scoped`,
`ATLASSIAN_EMAIL`, and `ATLASSIAN_API_TOKEN`. The optional
`ATLASSIAN_API_TOKEN_EXPIRES_ON` records the token's expiry date. Do not commit
these values or copy them into the Docker build context.

Create a scoped Confluence token at
[Atlassian account security](https://id.atlassian.com/manage-profile/security/api-tokens).
The verified content-body bootstrap uses `read:confluence-content.all`.
The integration's read-only diagnostic permissions are
`read:content-details:confluence` and `read:whiteboard:confluence`; attachment
fallback permissions are `read:attachment:confluence` and
`readonly:content.attachment:confluence`. No write or administration scopes are needed.

Personal API tokens expire after at most 365 days and require manual replacement.
The server obtains fresh short-lived Media tokens automatically for each download
batch. Credentials are read on every operation and are never returned by tools.
After changing credentials, recreate the sidecar with the new environment.

## Run with Docker beside MCPX

The supplied Compose file joins MCPX's existing Docker network. Set `MCPX_NETWORK`
if the network name differs. Docker supplies the six configuration variables.
There is no credential file mount, secret volume, or credential copied into the image.
Docker retains environment variables in container metadata: anyone with access
to the Docker engine can inspect them. Restarting the container preserves them.

```sh
LOCAL_UID="$(id -u)" LOCAL_GID="$(id -g)" \
docker --context desktop-linux compose up -d --build
```

The variables must already be present in the invoking shell. For an existing local
deployment, `npm run build && npm run deploy` captures the running sidecar's
environment internally and passes it into Compose, preserving credentials across
rebuilds without printing them or writing a secret file. Shell variables override
existing container values. The helper defaults to the saved local Compose file at
`~/.config/atlassian-media/compose.yaml`; use `--compose PATH` elsewhere.

To migrate an existing private credential file once, run
`npm run deploy -- --import-file /path/to/private/settings.env`. The helper reads it
through Effect Config, passes values in the child process environment, and stores
no copy. After verification, the original file can be deleted. Keep a recovery copy
of the API token in your password manager: deleting the container also deletes its
saved environment. File imports require permissions `0600` or stricter.

Add a Streamable HTTP upstream named `atlassian-media` to MCPX, using
`http://atlassian-media:9005/mcp`. The direct debugging endpoint is published only
on `127.0.0.1:9005`. The container restarts automatically when Docker starts.

## Tools

- `media_status`: configuration and cache status without credentials.
- `download_whiteboard_images`: a content ID and up to five exact image file UUIDs.
  Returns MIME type, byte lengths, cache ID, and SHA-256 for each original file.
- `read_image_chunk`: up to 8192 base64 characters from a cached image.

Assemble image chunks locally, verify lengths and SHA-256, match SVG images by
`data-file-id`, embed the bytes, trim the canvas, and render the desired PNG.
Chunk reads access the local cache; they do not make further Atlassian requests.

## Development and verification

```sh
npm ci
npm run lint:fix
npm run typecheck
npm test
npm start
```

Run `npm run verify-live -- --content-id CONTENT_ID --file-ids UUID,UUID --output /tmp/images`
to exercise the real MCP protocol and save verified originals. Omit IDs to check
only tool discovery and safe status. For MCPX, add `--url http://localhost:9000/mcp`
and its actual server tool-name prefix via `--prefix`.

The content-body Media bootstrap was verified on a real Confluence whiteboard.
The legacy content route and extra `clientId` response field are not fully covered
by the current public API schema; future Atlassian changes may require an adapter
update. Missing permissions, missing Media tokens, unsupported images, and rate
limits return explicit errors rather than triggering browser access.

Outbound requests are serialized and paced, without automatic retries on rate
limits. Responses, image sizes, and the in-memory cache are bounded. API credentials
go only to `api.atlassian.com`; Media credentials go to `api.media.atlassian.com`.
Cross-origin redirects strip authentication. Public endpoints validate Host and
Origin, and deployment keeps the service local to this computer and Docker network.
