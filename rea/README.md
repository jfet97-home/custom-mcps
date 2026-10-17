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

The container communicates with MCPX over its Docker network and publishes no
host port. Credentials and mutable state are kept outside the source checkout.

## Targets and capabilities

REA receives container filesystem paths. Compose mounts
`${REA_TARGETS_DIR:-${HOME}/.local/share/rea-targets}` read-only at `/targets`.
The host directory must already exist. Copy selected files or application bundles
into an investigation directory there; new files are visible without recreating
the container. A file at `<host-target-folder>/investigation/example.jar` is
available to REA as `/targets/investigation/example.jar`.
The [usage skill](skills/use-rea-mcp/SKILL.md) records target selection, copying and
host-to-container path translation.

The image supports JavaScript/package inspection and native analysis with Ghidra.
Hopper, IDA, JADX and other optional engines are not bundled. Ghidra can statically
inspect supported Mac binaries; running Mac applications or observing their live
processes requires macOS-side tools. Use the connected server's schemas and
availability rather than assuming every advertised tool has its prerequisites.

## Investigation skills

Two complementary skills cover investigation:

- `reverse-engineer-anything` supplies the upstream analysis methods and evidence
  workflows, installed from the matching REA release.
- [use-rea-mcp](skills/use-rea-mcp/SKILL.md) supplies usage instructions for this
  Docker/MCPX deployment, including target preparation and container paths.

Skillshare makes both available globally; this repository remains the source for
`use-rea-mcp`.

Personal deployment, authentication, upgrades, target-mount setup and recovery
procedures live in the global `rea-mcp` maintenance skill, outside this repository.
