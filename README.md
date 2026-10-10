# Custom MCP servers

Local MCP servers used with the Lunar MCPX gateway.

| Service | Source | Local port | Authentication storage |
| --- | --- | --- | --- |
| Microsoft Teams | [teams/](teams/) | 9006 | Private host environment settings and the `teams-mcp_auth` Docker volume |
| Atlassian Media | [atlassian-media/](atlassian-media/) | 9005 | Private runtime environment on the Docker container |

## Development

For Teams, run `uv sync --frozen`, `uv run ruff check src tests` and
`uv run pytest` inside `teams/`. The HTTP entry point is
`src/teams_mcp/http_server.py`; the upstream stdio entry point remains available.
See [Teams instructions](teams/AGENTS.md) and [upstream documentation](teams/README.md).

For Atlassian Media, run `npm ci`, `npm run lint:fix`, `npm run typecheck`
and `npm test` inside `atlassian-media/`. See its [README](atlassian-media/README.md).

## Deployment

On the Mac, installed Compose files remain under `~/.config/mcpx/`:
`teams-mcp.compose.yaml` and `atlassian-media.compose.yaml`. Their build contexts
point to this checkout's corresponding subdirectories. Keep the existing project
names, gateway network and authentication volume during upgrades.

`teams/compose.yaml` and `atlassian-media/compose.yaml` are portable templates.
Real credentials, token caches, private environment files and deployment notes
are excluded from Git. A new checkout requires local configuration before starting
containers; source publication does not publish an authenticated deployment.

Teams is based on [ssasuoirafen/teams-mcp-server](https://github.com/ssasuoirafen/teams-mcp-server)
and retains its [MIT license](teams/LICENSE). This monorepo starts with the current
source snapshot of both services. Both components are maintained directly on `main`.
