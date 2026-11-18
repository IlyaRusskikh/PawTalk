.DEFAULT_GOAL := help
.PHONY: all installer help client client-start client-stop manager manager-start manager-stop server server-start server-stop stop
PROFILE ?=
SERVER_PROFILE ?=
SERVER_IP ?= 127.0.0.1
SERVER_PORT ?= 28443

help:
	@echo make client-start / client-stop   - Client review
	@echo make client-start-first / client-stop-first - named Client instance
	@echo Replace first with second, third, or another profile name
	@echo make manager-start / manager-stop - Manager review UI, installed host when available
	@echo make server-start / server-stop   - isolated Server review
	@echo make stop                         - stop all default review components
	@echo Optional: PROFILE=name; SERVER_PROFILE=name SERVER_IP=address SERVER_PORT=28443
	@echo make installer                    - build Windows installer

client: client-start
client-start:
	node tooling/dev/review-app.mjs client start "$(PROFILE)"
client-stop:
	node tooling/dev/review-app.mjs client stop "$(PROFILE)"
client-start-%:
	node tooling/dev/review-app.mjs client start "$*"
client-stop-%:
	node tooling/dev/review-app.mjs client stop "$*"
manager: manager-start
manager-start:
	node tooling/dev/review-app.mjs manager start "$(PROFILE)"
manager-stop:
	node tooling/dev/review-app.mjs manager stop "$(PROFILE)"
server: server-start
server-start:
	node tooling/dev/review-server.mjs --ip "$(SERVER_IP)" --port "$(SERVER_PORT)" $(if $(SERVER_PROFILE),--profile "$(SERVER_PROFILE)")
server-stop:
	node tooling/dev/review-server.mjs --stop $(if $(SERVER_PROFILE),--profile "$(SERVER_PROFILE)")
stop: client-stop manager-stop server-stop

# Windows PowerShell is available on Windows 10/11; no Unix shell required.
all: installer

installer:
	powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./apps/client/windows/scripts/build.ps1
