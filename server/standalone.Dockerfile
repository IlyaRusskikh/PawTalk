FROM golang:1.27.3-alpine AS build
WORKDIR /src
COPY server/ ./
RUN go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/pawtalk .

FROM livekit/livekit-server:v1.13.11 AS media

FROM alpine:3.23
RUN apk add --no-cache ca-certificates \
    && addgroup -g 65532 pawtalk && adduser -D -H -u 65532 -G pawtalk pawtalk \
    && mkdir /data && chown pawtalk:pawtalk /data
COPY --from=build /out/pawtalk /pawtalk
COPY --from=media /livekit-server /livekit-server
COPY LICENSE /LICENSE
COPY THIRD_PARTY_NOTICES.md /THIRD_PARTY_NOTICES.md
COPY --from=build /usr/local/go/LICENSE /GO-LICENSE
COPY licenses/livekit-server.APACHE2.txt /LIVEKIT-LICENSE
COPY licenses/go-runtime.txt /GO-DEPENDENCIES-LICENSE
USER 65532:65532
VOLUME ["/data"]
EXPOSE 18443/tcp 18444/tcp 18445/udp
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["/pawtalk", "serve", "healthcheck"]
ENTRYPOINT ["/pawtalk", "serve"]
