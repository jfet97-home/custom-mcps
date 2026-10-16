# Repository guidance

- A new MCP or changed deployment architecture starts with the global `mcp-service-setup` skill. Ask unresolved questions one at a time about capabilities, limits, source/private paths, runtime, access and lifecycle before installing packages, creating setup files, registering connections or starting services. An install request alone does not authorize a host package, adapter, background process, startup job or Docker restart policy; reuse explicit choices and approvals for the agreed plan.
- Maintain all components in this checkout on `main`; keep deployed changes in committed source.
- Read component-level `AGENTS.md` and `CLAUDE.md` before changing that component.
- Teams uses Python and uv; Atlassian Media uses TypeScript and npm. Run each component's declared lint, type and test checks for relevant changes.
- Pocket uses TypeScript, npm and native Effect v4 MCP. Its Mac service runs as a LaunchAgent with OS secret storage; keep its browser profile, session, backups and deployment state outside the checkout.
- REA packages upstream REA and Supergateway in Docker. Keep its Compose source here, credentials outside the checkout, and the `rea-mcp` project and `rea-mcp_rea_state` volume names stable. Validate Compose and Docker build checks; no local Mac service is needed.
- Keep private credentials, environment settings, token caches and diagnostic output outside Git and Docker build contexts.
- Preserve installed Compose project names, the gateway network and the Teams authentication volume when updating deployment paths.
- Existing nested knowledge bases are local references and remain ignored.
