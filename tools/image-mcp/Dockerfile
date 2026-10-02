# syntax=docker/dockerfile:1.20
#
# Shared image-generation MCP service for container bots. One codebase, two images:
#   target `facade`  the MCP facade that holds the per-bot tokens and the gateway key
#   target `test`    unit tests of the validators, the budget and the store isolation
# The service talks to the model gateway over HTTP; there is no worker and no local model.

FROM python:3.13-slim-trixie@sha256:7c61056e61ac89e852de05f3dc6fa51a6dd2181797bceed46aa725dd7cb2cd3b AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app/src PATH=/opt/venv/bin:$PATH
RUN python -m venv /opt/venv \
 && groupadd --gid 10001 image && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin image
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY src /app/src
# The spool volume is mounted here. A named volume takes owner and mode from this directory on
# first use, so it must exist and belong to the service user or nothing can be written.
RUN mkdir -p /spool && chown 10001:10001 /spool && chmod 0750 /spool
WORKDIR /app

FROM base AS test
COPY tests /app/tests
RUN python -m unittest discover -s tests -v

FROM base AS facade
LABEL org.opencontainers.image.title="Myrmidon image MCP facade"
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["python", "-c", "import urllib.request as u; u.urlopen('http://127.0.0.1:8080/healthz', timeout=3)"]
ENTRYPOINT ["python", "-m", "image_mcp"]