# 011 — Shared Manager terminal interface

Status: implemented for Linux and Windows.

Linux and Windows share the terminal menus, confirmation flow, durable controller
and backup/update formats. The terminal renderer consumes the same input events
on both platforms. Linux uses curses. Windows uses the console input buffer and
VT output from the existing bundled Python runtime. The numbered menu serves
terminals with basic line input.

The Windows console host starts the protected bootstrap controller. Setup,
configuration and local ZIP admission use the existing Windows service and
package paths. The Administrator-only terminal opens one maintenance session per
data root. SYSTEM and Administrators can request shutdown for an installer run.
The host signals completion after the Python controller exits. Service and
on-disk contracts continue to use the existing versioned formats.

An Electron terminal wrapper would require the graphical runtime on a console-only
host. A separate Windows terminal application would duplicate operation policy.
The shared terminal renderer uses the existing controller bundle contents.

Verification covers Linux PTY input, Windows console events and console mode
restoration, native Windows host tests, and packaged installer compilation.
Elevated SCM and Server Core installation require their own acceptance runs.
