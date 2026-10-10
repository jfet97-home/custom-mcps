# Repository guidance

- Maintain both components in this checkout on `main`; keep deployed changes in committed source.
- Read component-level `AGENTS.md` and `CLAUDE.md` before changing that component.
- Teams uses Python and uv; Atlassian Media uses TypeScript and npm. Run each component's declared lint, type and test checks for relevant changes.
- Keep private credentials, environment settings, token caches and diagnostic output outside Git and Docker build contexts.
- Preserve installed Compose project names, the gateway network and the Teams authentication volume when updating deployment paths.
- Existing nested knowledge bases are local references and remain ignored.
