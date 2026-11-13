# Changelog

All notable changes to the **OpenCode Telegram Bridge** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.1.0] - 2026-11-13

### Added
- **Multi-Location Config Auto-Discovery**: Automatically discovers configuration from local project folders (`./opencode-telegram.json`), `.opencode`, or user global directories with automatic template scaffolding.
- **Zero-Touch Bot Migration**: Automatically registers cloud commands, sets up the native `[ ☰ ]` commands icon, updates bot profile descriptions, and resets update offsets upon bot token switch.
- **Smart Markdown Table Engine**: Adaptive rendering for Markdown tables into either clean Unicode monospace box tables (`<pre>`) or mobile-friendly card lists (`tableMode: "smart" | "box" | "list"`).
- **Interactive Action Cards**: Full inline control panels for `/current`, `/sessions`, `/projects`, and `/power`.
- **Active Session Synchronization**: Instant `/sync` command to bind Telegram directly to the most recently active desktop session.
- **Cross-Platform Remote Power Guard**: On-demand battery monitoring and 12% critical hibernation trigger supporting both Windows and Linux.
- **Supervised Polling Watchdog**: Resilient background poll loop with automatic reconnect within 3 seconds of network recovery.
- **Duplicate Polling Shield**: Single-instance mutex preventing 409 Conflict across multiple OpenCode workspaces.
- **Bot Collision Safety Guard**: Automated validation preventing accidental token collisions with `emby-dl` bots.
- **Automated Test Suite**: 26-point automated test script (`tests/test_suite.py`) testing table rendering, chunking, tag balancing, and battery logic.

### Fixed
- Fixed memory leakage by scheduling automatic removal of finalized runs after 30 seconds.
- Fixed raw HTML entity leakage (`<b>`, `<code>`) in bot responses through unified HTML formatting and escaping.
- Fixed early finalized turn terminations during multi-step tool calls by waiting for `session.execution.succeeded`.
- Fixed crash in `/sessions` caused by missing argument passing to `sessionLines`.
- Fixed stale session ID references in callback queries by storing explicit `sessionID` in callback payloads.
- Fixed Telegram client polling timeouts by properly handling normal long-poll cycle completions.
- Removed intrusive native keyboard bars and "القائمة" labels in mobile clients in favor of clean inline keyboards and native command menus.

---

## [1.0.0] - 2026-11-09

### Added
- Initial release of OpenCode V2 Telegram Bridge.
- Two-way chat communication with AI agent through Telegram.
- Live streaming draft updates during agent text generation.
- Interactive permissions gate (`Once`, `Always`, `Reject`).
- Multi-project discovery and session switching.
- Git repository status inspection.
- Hot-reloading configuration from `~/.config/opencode/opencode-telegram.json`.
