---
name: use-rea-mcp
description: Use the existing Docker-hosted REA service through Lunar MCPX to inspect user-selected apps, binaries and packages. Prepare approved host artifacts in a shared target folder and translate their paths for the container. Complements reverse-engineer-anything with deployment usage guidance; service installation and maintenance are separate tasks.
---

# Use REA through MCPX

Use the existing MCPX server named `rea`. Combine this skill's file-access and
routing instructions with `reverse-engineer-anything` for analysis methods,
target-specific tools and evidence interpretation. Keep the upstream skill
installed separately through Skillshare. Use `use-lunar-mcpx` for gateway
discovery and schema lookup.

REA runs inside a Linux container. Every path passed to its tools must exist
inside that container; a Mac path does not become accessible just because the
assistant can read it locally.

## Select and prepare the target

1. Resolve the app, binary or package selected by the user. Ask when its identity
   is ambiguous; nearby files and earlier reports do not select a new target.
2. Establish the existing file-access mapping before copying. The intended
   workflow uses one agreed host folder outside Git, mounted read-only into REA
   as `/targets`. Verify the actual host source and container destination from
   existing deployment metadata; do not assume this mount exists. **The current
   Compose configuration has no host target mount.** The host folder still needs
   to be chosen and its mount configured as a separate setup change.
3. If this mapping is missing, explain that target preparation is blocked and
   resolve the folder/access choice with the user before proceeding. Do not
   create an arbitrary staging folder, change Compose or restart the service as
   part of an ordinary analysis request. Reuse a mapping already agreed and
   configured; do not ask for the same choice on every investigation.
4. With the mapping available, an assistant with host filesystem tools copies
   only the selected target and approved companion files into an investigation
   directory in that folder. Preserve the originals, existing staged targets,
   bundle layout and resource relationships. Check symlinks: references outside
   the shared tree are not automatically available inside Docker. An assistant
   with only MCP access must have a local assistant or the user prepare the files.
5. Translate the staged path to its verified container path. For a bundle staged
   under `<host-target-folder>/<investigation>/Foo.app`, the container sees
   `/targets/<investigation>/Foo.app`. Native analysis may need its executable,
   such as `/targets/<investigation>/Foo.app/Contents/MacOS/Foo`; resolve that
   executable from the actual bundle metadata instead of guessing its name.
   Existing explicit container paths can be used directly without a host copy.

Once configured, the read-only input mount prevents REA from changing the staged
inputs. REA and Ghidra write their own analysis state in separate writable
locations. See the [deployment guide](../../README.md#targets-and-capabilities)
for the included engines and supported analysis capabilities.

## Analyse through the existing connection

Discover `rea` with the advertised MCPX tools, search for the required operation,
inspect its complete schema, then call its exact returned name. Some clients
expose REA tools directly. Do not replace the existing connection with a direct
client registration or a host `npx` installation.

- For JavaScript/Electron trees and ASAR files, follow the upstream JavaScript
  workflow; these operations do not need Ghidra.
- For native binaries, open the selected container path with `provider_id:
  "ghidra"` when that provider is available, then query the functions needed for
  the task. Ghidra import and analysis start on the first provider-backed query;
  a successful open alone does not prove decompilation works.
- Use the connected server's actual schemas and availability. Read the current
  session when diagnosing a blocker or reusing work; avoid readiness checks
  before every supported analysis. Close the native session opened for this
  investigation when finished so its owned Ghidra process and project are released.

Linux-hosted Ghidra can statically inspect supported Mac binaries. Running a Mac
application or observing its live process needs macOS-side tools and a separately
agreed runtime workflow. Missing access or engines is not authorization to add
host services, widen mounts or install another provider.

Report the target identity, host-to-container mapping when used, actual evidence
and remaining limits. Identify staged files or exported results retained after
the task; preserve unrelated targets and user files during cleanup.
