FROM golang:1.27.3-alpine AS build
WORKDIR /src
COPY server/ ./
RUN go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/voicecord .

FROM scratch
COPY --from=build /out/voicecord /voicecord
COPY LICENSE /LICENSE
COPY --from=build /usr/local/go/LICENSE /GO-LICENSE
USER 65532:65532
ENTRYPOINT ["/voicecord"]
