# syntax=docker/dockerfile:1.20
#
# dockergate: the allowlisting proxy in front of the Docker socket for the
# bot-container driver of the board. See docs/myrmidon/dockergate.md.
#
# Build context: tools/dockergate (the Go module; stdlib only, no go.sum).
# The workflow .github/workflows/myrmidon-dockergate.yml builds and publishes
# this image by digest. The base images are pinned by digest; the result is a
# static binary on distroless "static" as the nonroot user (65532).
#
# The context has no .git, so the revision comes in as a build argument and is
# stamped into the binary with -ldflags ("dockergate version" prints it); the
# OCI labels of the image carry it as well.

FROM golang:1.25-bookworm@sha256:3b4a11519ad929d1e1d261a12cff056f0c85b735253d7d861346b9c6f8b36437 AS build
ARG VERSION=dev
ARG REVISION=unknown
WORKDIR /src
ENV CGO_ENABLED=0 GOFLAGS=-mod=mod GOTOOLCHAIN=local
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
RUN go build -trimpath -buildvcs=false \
      -ldflags "-s -w -X main.version=${VERSION}+${REVISION}" \
      -o /out/dockergate ./cmd/dockergate \
 && /out/dockergate version

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /out/dockergate /usr/local/bin/dockergate
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/dockergate"]
CMD ["serve", "--config", "/etc/myrmidon-dockergate/config.json"]
