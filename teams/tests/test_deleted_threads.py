"""Deleted parents must not hide surviving channel replies or other Graph failures."""

import json

import httpx
import pytest
from mcp.server.mcpserver.exceptions import ToolError

from teams_mcp import server
from teams_mcp.graph import GraphClient


@pytest.fixture
async def graph_client(monkeypatch):
    client = GraphClient(lambda: "test-token")
    await client._http.aclose()
    monkeypatch.setattr(server, "_init_if_needed", lambda: None)
    monkeypatch.setattr(server, "_require_auth", lambda: client)
    yield client
    await client._http.aclose()


def install_transport(client, handler):
    client._http = httpx.AsyncClient(
        base_url="https://graph.microsoft.com/v1.0", transport=httpx.MockTransport(handler)
    )


async def read_thread():
    result = await server.mcp.call_tool(
        "list_thread_replies",
        {"team_id": "team", "channel_id": "channel", "message_id": "parent", "limit": 5},
    )
    return json.loads(result.content[0].text)


@pytest.mark.parametrize("reply_count", [0, 2])
async def test_deleted_parent_keeps_replies(graph_client, reply_count):
    requests = []

    def handler(request):
        requests.append(request.url.path)
        if request.url.path.endswith("/replies"):
            assert request.url.params["$top"] == "5"
            return httpx.Response(200, json={"value": [
                {"id": str(i), "messageType": "message", "body": {"content": "reply"}}
                for i in range(reply_count)
            ]})
        return httpx.Response(404, json={"error": {"code": "NotFound", "message": "Gone"}})

    install_transport(graph_client, handler)
    result = await read_thread()
    assert requests[0].endswith("/replies")
    assert result[0]["parentUnavailable"] is True
    assert result[0]["parentReadError"]["status"] == 404
    assert "deletedDateTime" not in result[0]
    assert [message["id"] for message in result[1:]] == [str(i) for i in range(reply_count)]


@pytest.mark.parametrize("status", [401, 403, 500])
async def test_parent_errors_are_not_treated_as_deletion(graph_client, status):
    def handler(request):
        if request.url.path.endswith("/replies"):
            return httpx.Response(200, json={"value": []})
        return httpx.Response(status, json={"error": {"code": "Denied", "message": "Details"}})

    install_transport(graph_client, handler)
    with pytest.raises(ToolError, match=f"Graph API error {status} .*Details"):
        await read_thread()


async def test_reply_404_is_an_error_not_an_empty_thread(graph_client):
    def handler(request):
        assert request.url.path.endswith("/replies")
        return httpx.Response(404, json={"error": {"code": "NotFound", "message": "No thread"}})

    install_transport(graph_client, handler)
    with pytest.raises(ToolError, match="Graph API error 404 .*No thread"):
        await read_thread()


async def test_existing_parent_and_deleted_reply_metadata(graph_client):
    def handler(request):
        if request.url.path.endswith("/replies"):
            return httpx.Response(200, json={"value": [
                {"id": "system", "messageType": "systemEventMessage"},
                {
                    "id": "deleted", "messageType": "message", "body": {"content": None},
                    "deletedDateTime": "2026-10-12T08:34:30Z",
                    "lastModifiedDateTime": "2026-10-12T08:34:30Z",
                },
            ]})
        return httpx.Response(200, json={"id": "parent", "body": {"content": "Hello"}})

    install_transport(graph_client, handler)
    result = await read_thread()
    assert result[0]["content"] == "Hello"
    assert "parentUnavailable" not in result[0]
    assert len(result) == 2
    assert result[1]["deletedDateTime"] == "2026-10-12T08:34:30Z"
    assert result[1]["content"] == ""
