# syntax=docker/dockerfile:1.20
#
# fleetd: the fleet service for a second machine's bot containers
# (FLEETD-VMEXEC). See docs/myrmidon/fleetd-vmexec.md.
#
# Build context: tools/fleetd (the Go module; stdlib only, no go.sum).
# The workflow .github/workflows/myrmidon-fleetd.yml builds and publishes
# this image by digest, by the pattern of myrmidon-dockergate.yml. The base
# images are pinned by digest; the result is a static binary on distroless
# "static" as the nonroot user (65532).

FROM golang:1.25-bookworm@sha256:3b4a11519ad929d1e1d261a12cff056f0c85b735253d7d861346b9c6f8b36437 AS build
ARG VERSION=dev
ARG REVISION=unknown
WORKDIR /src
ENV CGO_ENABLED=0 GOFLAGS=-mod=mod GOTOOLCHAIN=local
COPY go.mod ./
COPY cmd ./cmd
RUN go build -trimpath -buildvcs=false \
      -ldflags "-s -w" \
      -o /out/fleetd ./cmd/fleetd

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /out/fleetd /usr/local/bin/fleetd
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/fleetd"]
CMD ["--config", "/etc/myrmidon-fleetd/config.json"]
