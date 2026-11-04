.DEFAULT_GOAL := installer
.PHONY: all installer

# Windows PowerShell is available on Windows 10/11; no Unix shell required.
all: installer

installer:
	powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./build.ps1
