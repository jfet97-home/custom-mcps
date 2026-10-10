"""Serve the existing Teams tools over HTTP for the local MCPX gateway."""

import os

import uvicorn
from mcp.server.transport_security import TransportSecuritySettings
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from teams_mcp.server import mcp


async def health(_request: Request) -> JSONResponse:
    return JSONResponse(
        {
            "status": "ok",
            "configured": all(
                os.environ.get(name, "").strip()
                for name in ("TEAMS_MCP_TENANT_ID", "TEAMS_MCP_CLIENT_ID")
            ),
        }
    )


def main() -> None:
    os.umask(0o077)
    port = int(os.environ.get("TEAMS_MCP_PORT", "9006"))
    app = mcp.streamable_http_app(
        host="0.0.0.0",
        json_response=True,
        stateless_http=True,
        transport_security=TransportSecuritySettings(
            allowed_hosts=[f"{host}:{port}" for host in ("teams-mcp", "localhost", "127.0.0.1")],
            allowed_origins=[f"http://localhost:{port}", f"http://127.0.0.1:{port}"],
        ),
    )
    app.routes.insert(0, Route("/health", health))
    uvicorn.run(app, host="0.0.0.0", port=port, access_log=False)


if __name__ == "__main__":
    main()
