# REA MCP service

Runs the published [REA](https://github.com/morluto/rea) MCP server in one Docker
container. [Supergateway](https://github.com/supercorp-ai/supergateway) exposes
REA's stdio transport through Streamable HTTP for Lunar MCPX. This component
contains deployment configuration and pinned upstream packages.

The Docker build installs `rea-agents@6.5.0` and `supergateway@4.2.0` with
`npm ci`. The Node base image is pinned by digest. No application server or
transport adapter is implemented in this repository.

## Private configuration

The default environment file is `~/.config/rea-mcp/service.env`. Create it with
owner-only permissions and set `SUPERGATEWAY_API_KEY` to a randomly generated
secret. Set `REA_ENV_FILE` to use a different private file. Keep it outside the
checkout; `.dockerignore` admits only the Dockerfile and npm manifests.

The service joins `${MCPX_NETWORK:-lunar-mcpx_default}` and publishes no host
ports. Register `rea` in MCPX with Streamable HTTP URL
`http://rea-mcp:9012/mcp` and an `Authorization: Bearer <key>` header matching the
private environment file. A request without the key returns HTTP 401.

## Operation

Run these commands from this directory:

```sh
docker --context desktop-linux compose config --quiet
docker --context desktop-linux buildx build --check .
docker --context desktop-linux compose up -d --build --wait
docker --context desktop-linux compose ps
docker --context desktop-linux compose stop
```

The Compose project remains `rea-mcp`, and the persistent volume remains
`rea-mcp_rea_state`. Keep that volume when recreating or updating the service.
The container runs as the image's unprivileged `node` user with a read-only
root filesystem, writable temporary storage and a private REA state volume.
It restarts with Docker unless explicitly stopped. No native Mac service or
host npm installation is required.

## Targets and capabilities

Host application folders are not mounted by default. Supply a selected artifact
through an explicit read-only bind mount from a Docker-shared host directory,
or copy it into a selected container workspace. Tool paths refer to the
container filesystem. `/Applications` is not shared with Docker on the current
Mac, so adding that mount alone will fail.

The image includes REA and the Linux `ps` prerequisite for static JavaScript
inspection. Ghidra, Hopper, IDA, JADX, Java and other optional analysis engines
are not installed. macOS application execution and macOS-only tools cannot run
inside this Linux container. An advertised tool does not establish that its
optional engine or runtime is available.

The Docker health endpoint checks the transport process. Verify actual readiness
through MCPX with a supported tool on a small, explicitly supplied target.

## Investigation skill

Install the matching upstream instructions through Skillshare:

```sh
skillshare install morluto/rea/.agents/skills/reverse-engineer-anything \
  --branch rea-agents-6.5.0 --yes
skillshare sync
```

Skillshare manages the skill separately from this Docker service. The MCP
connection stays in MCPX; installing the instructions does not add a direct
client connection or install an analysis engine.
