# Custom MCP servers

Local MCP servers used with the Lunar MCPX gateway.

New integrations follow the global `mcp-service-setup` skill, versioned in the
Lunar checkout at `skills/mcp-service-setup/`. Agree capabilities and limits,
repository/private paths, runtime, access and lifecycle before installation.
Background operation and automatic startup require an explicit choice. Keep each
service's source and deployment files here, with private runtime state outside Git.

| Service | Source | Local port | Authentication storage |
| --- | --- | --- | --- |
| Microsoft Teams | [teams/](teams/) | 9006 | Private host environment settings and the `teams-mcp_auth` Docker volume |
| Atlassian Media | [atlassian-media/](atlassian-media/) | 9005 | Private runtime environment on the Docker container |
| Pocket | [pocket/](pocket/) | 9011 | macOS Keychain; native LaunchAgent beside the Docker gateway |
| REA | [rea/](rea/) | 9012, Docker network only | Private `~/.config/rea-mcp/service.env` and MCPX server configuration |

## Development

For Teams, run `uv sync --frozen`, `uv run ruff check src tests` and
`uv run pytest` inside `teams/`. The HTTP entry point is
`src/teams_mcp/http_server.py`; the upstream stdio entry point remains available.
See [Teams instructions](teams/AGENTS.md) and [upstream documentation](teams/README.md).

For Atlassian Media, run `npm ci`, `npm run lint:fix`, `npm run typecheck`
and `npm test` inside `atlassian-media/`. See its [README](atlassian-media/README.md).

For Pocket, use the same npm checks inside `pocket/`. Its native Effect v4 MCP
supports complete Notes/transcript reads and guarded writes. Run its dedicated
login command once, then install the native Mac service; see [Pocket setup](pocket/README.md).

REA contains Docker deployment configuration for pinned REA and Supergateway
packages. Validate Compose and Docker build checks, then build and verify a
supported tool through MCPX; see [REA setup](rea/README.md).

## Deployment

On the Mac, installed Compose files are `~/.config/teams-mcp/compose.yaml`
and `~/.config/atlassian-media/compose.yaml`. Their build contexts
point to this checkout's corresponding subdirectories. Keep the existing project
names, gateway network and authentication volume during upgrades.

`teams/compose.yaml` and `atlassian-media/compose.yaml` are portable templates.
Real credentials, token caches, private environment files and deployment notes
are excluded from Git. A new checkout requires local configuration before starting
containers; source publication does not publish an authenticated deployment.

Pocket runs natively as `com.jfet97.pocket-mcp` so it can use macOS Keychain
directly. MCPX connects to `http://host.docker.internal:9011/mcp`. Its private
backups and deployment state stay outside the checkout.

REA runs directly from `rea/compose.yaml` in this checkout. MCPX connects to
`http://rea-mcp:9012/mcp` over the shared Docker network. The container publishes
no host port, and private credentials stay outside Git.

Teams is based on [ssasuoirafen/teams-mcp-server](https://github.com/ssasuoirafen/teams-mcp-server)
and retains its [MIT license](teams/LICENSE). This monorepo starts with the current
source snapshot of those services. All components are maintained directly on `main`.
