# syntax=docker/dockerfile:1.20
#
# Shared media/office tools for container bots. One codebase, two images:
#   target `facade`  the MCP facade (python only; holds the bot tokens, never parses media)
#   target `worker`  ffmpeg/ffprobe + poppler jobs (parses untrusted media; no bot tokens)
#   target `test`    unit tests of the spec validators and the isolation logic
# Gotenberg and Tika are separate ready-made images (see compose.example.yml, tika/Dockerfile).

FROM python:3.13-slim-trixie@sha256:7c61056e61ac89e852de05f3dc6fa51a6dd2181797bceed46aa725dd7cb2cd3b AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app/src PATH=/opt/venv/bin:$PATH
RUN python -m venv /opt/venv \
 && groupadd --gid 10001 media && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin media
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY src /app/src
WORKDIR /app

FROM base AS test
COPY tests /app/tests
RUN python -m unittest discover -s tests -v

FROM base AS facade
LABEL org.opencontainers.image.title="Myrmidon media MCP facade"
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["python", "-c", "import urllib.request as u; u.urlopen('http://127.0.0.1:8080/healthz', timeout=3)"]
ENTRYPOINT ["python", "-m", "media_mcp"]
CMD ["facade"]

FROM base AS worker
LABEL org.opencontainers.image.title="Myrmidon media worker (ffmpeg, poppler)"
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg poppler-utils \
 && rm -rf /var/lib/apt/lists/* \
 && ffmpeg -version | head -1 && pdftoppm -v 2>&1 | head -1
USER 10001:10001
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["python", "-c", "import urllib.request as u; u.urlopen('http://127.0.0.1:8081/healthz', timeout=3)"]
ENTRYPOINT ["python", "-m", "media_mcp"]
CMD ["worker"]
