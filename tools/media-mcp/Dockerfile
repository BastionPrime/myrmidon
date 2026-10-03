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
# The spool volume is mounted here. A named volume takes owner and mode from this directory on
# first use, so it must exist and belong to the service user or nothing can be written.
RUN mkdir -p /spool && chown 10001:10001 /spool && chmod 0750 /spool
WORKDIR /app

FROM base AS test
COPY tests /app/tests
RUN python -m unittest discover -s tests -v

# LibreDWG (dwg2dxf / dwg2SVG): same tools the bots used on the host, built from
# the GNU release so no vendored binaries enter the image. The build stays in
# this stage; the worker stage copies only the installed files.
FROM base AS libredwg
USER root
ARG LIBREDWG_VERSION=0.13.3
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential libtool tar xz-utils curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL "https://ftp.gnu.org/gnu/libredwg/libredwg-${LIBREDWG_VERSION}.tar.xz" -o /tmp/libredwg.tar.xz \
 && echo "83f1f6e78a744777a481ff4520e4cef3f8ac4b2c1c25671077ca12fe81e8816e  /tmp/libredwg.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/libredwg.tar.xz -C /tmp \
 && cd "/tmp/libredwg-${LIBREDWG_VERSION}" \
 && ./configure --prefix=/usr/local --disable-bindings \
 && make -j"$(nproc)" \
 && make install \
 && rm -rf /tmp/libredwg*

FROM base AS facade
LABEL org.opencontainers.image.title="Myrmidon media MCP facade"
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["python", "-c", "import urllib.request as u; u.urlopen('http://127.0.0.1:8080/healthz', timeout=3)"]
ENTRYPOINT ["python", "-m", "media_mcp"]
CMD ["facade"]

FROM base AS worker
LABEL org.opencontainers.image.title="Myrmidon media worker (ffmpeg, poppler, LibreDWG)"
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg poppler-utils \
 && rm -rf /var/lib/apt/lists/* \
 && ffmpeg -version | head -1 && pdftoppm -v 2>&1 | head -1
# ezdxf stays in its own venv so the service environment is untouched; the
# dwg_convert job script runs under that venv. The worker copies the module
# tree in before the shim is created (COPY src is already on base).
RUN python -m venv /opt/cad \
 && /opt/cad/bin/pip install --no-cache-dir "ezdxf==1.4.4" "pillow" \
 && ln -s /app/src/media_mcp/dwg_convert.py /usr/local/bin/dwg_convert \
 && /opt/cad/bin/python -c "import ezdxf; from ezdxf.addons.drawing.svg import SVGBackend; print('ezdxf', ezdxf.__version__)"
COPY --from=libredwg /usr/local/bin/dwg2dxf /usr/local/bin/dwg2SVG /usr/local/bin/
COPY --from=libredwg /usr/local/lib/libredwg.so.0* /usr/local/lib/
RUN ldconfig /usr/local/lib && dwg2dxf --version | head -1 && dwg2SVG --version | head -1
USER 10001:10001
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["python", "-c", "import urllib.request as u; u.urlopen('http://127.0.0.1:8081/healthz', timeout=3)"]
ENTRYPOINT ["python", "-m", "media_mcp"]
CMD ["worker"]
