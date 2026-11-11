ARG DISTRO=debian:12-slim
FROM docker:29.9.2-cli AS docker
FROM ${DISTRO}
RUN apt-get update && apt-get install -y --no-install-recommends python3 openssl ca-certificates curl tar util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins
WORKDIR /work
