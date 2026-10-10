FROM ghcr.io/astral-sh/uv:0.4.30 AS uv
FROM python:3.14-slim

COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock README.md /app/
COPY src /app/src
RUN uv sync --frozen --no-dev --no-editable \
    && useradd --create-home --uid 1000 mcp \
    && install -d -m 700 -o mcp -g mcp /home/mcp/.teams-mcp

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER mcp
EXPOSE 9006
CMD ["/app/.venv/bin/python", "-m", "teams_mcp.http_server"]
