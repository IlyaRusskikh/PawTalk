ARG DISTRO=debian:12-slim
FROM docker:29.9.2-cli AS docker
FROM node:24.22.1-bookworm-slim AS node
FROM ${DISTRO}
RUN apt-get update && apt-get install -y --no-install-recommends python3 openssl ca-certificates curl tar util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /work
