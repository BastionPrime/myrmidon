# syntax=docker/dockerfile:1.20
#
# myrmidon(EGRESS-A): the fleet's outbound proxy for container bots, log-only.
#   target `service`  the proxy (default)
#   target `test`     unit tests
#
# No requirements.txt: the proxy is an HTTP forward proxy plus a CONNECT tunnel,
# and the standard library has both. It holds no bot credentials and parses no
# payload — it writes down where a request was going and passes it on.

FROM python:3.13-slim-trixie@sha256:7c61056e61ac89e852de05f3dc6fa51a6dd2181797bceed46aa725dd7cb2cd3b AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app/src
RUN groupadd --gid 10001 egress \
 && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin egress
COPY src /app/src
WORKDIR /app

FROM base AS test
COPY tests /app/tests
RUN python -m unittest discover -s tests -v

FROM base AS service
LABEL org.opencontainers.image.title="Myrmidon egress proxy (log-only)"
USER 10001:10001
EXPOSE 3128
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["python", "-c", "import urllib.request as u; u.urlopen('http://127.0.0.1:3128/healthz', timeout=3)"]
ENTRYPOINT ["python", "-m", "egress_proxy"]
CMD ["serve"]