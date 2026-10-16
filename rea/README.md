# REA MCP service

Runs the published [REA](https://github.com/morluto/rea) MCP server in one Docker
container. [Supergateway](https://github.com/supercorp-ai/supergateway) exposes
REA's stdio transport through Streamable HTTP for Lunar MCPX. This component
contains deployment configuration and pinned upstream packages.

The Docker build installs `rea-agents@6.5.0` and `supergateway@4.2.0` with
`npm ci`, plus Ghidra 12.1.4 and Eclipse Temurin JDK 21. The Node and Java images
are pinned by digest, and the official Ghidra archive is verified by SHA-256.
A build stage compiles the native decompiler for Linux ARM64 or x86-64; its
compiler and download tools stay outside the runtime image. No application server
or transport adapter is implemented in this repository.

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

The image includes REA, Ghidra 12.1.4, JDK 21 and the Linux `ps` prerequisite.
`GHIDRA_INSTALL_DIR=/opt/ghidra` and `JAVA_HOME=/opt/java/openjdk` are image
defaults. Select `provider_id: "ghidra"` when opening a native binary. REA starts
Ghidra on the first analysis query and owns its temporary project and process;
close the binary after analysis to release them. Ghidra uses its default 2 GiB
Java heap limit, while this deployment's `/tmp` has a separate 1 GiB capacity.
Larger targets can require an explicitly reviewed resource change.

Hopper, IDA, JADX and other optional engines remain separate prerequisites.
macOS application execution and macOS-only tools cannot run inside this Linux
container; Ghidra can statically inspect supported Mac binaries. An advertised
tool does not establish that its optional engine or runtime is available.

The Docker health endpoint checks the transport process. Verify actual readiness
through MCPX with a supported tool on a small, explicitly supplied target.
If container recreation leaves MCPX reporting `Session not found`, recreate only
the `rea` connection with the URL and authentication above. Preserve its private
key and Docker volume; a healthy container does not refresh an old MCP session.

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

The global source is `~/.agents/skills/reverse-engineer-anything/`; Skillshare
links it into `~/.claude/skills/reverse-engineer-anything/`. Personal maintenance
and setup guidance stays in global skills outside the Lunar product repository.
