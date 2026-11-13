<div align="center">

# 🤖 OpenCode Telegram Bridge

**Full-featured, interactive Telegram bridge for [OpenCode V2](https://opencode.ai): multi-project tracking, live streaming drafts, interactive permission gates, and remote power management.**

[![OpenCode V2](https://img.shields.io/badge/OpenCode-V2%20Plugin-blue?style=for-the-badge&logo=code)](https://opencode.ai)
[![Telegram Bot API](https://img.shields.io/badge/Telegram-Bot%20API-2CA5E0?style=for-the-badge&logo=telegram)](https://core.telegram.org/bots/api)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux-brightgreen?style=for-the-badge)](https://github.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

[**العربية (Arabic Documentation - README_AR.md)**](README_AR.md) • [**Quickstart**](#-quickstart-guide) • [**Commands**](#-commands--interactive-cards) • [**Power Guard**](#-remote-power--battery-guard)

</div>

---

## 🌟 Overview

**OpenCode Telegram Bridge** is an official OpenCode V2 Server Plugin that enables full two-way control over your AI coding agent and project workspaces directly through **Telegram**. Monitor builds, approve shell tool executions, steer agent prompts, switch sessions across multiple repositories, and even monitor laptop battery health with emergency hibernation triggers—all from your mobile phone.

Architected specifically for the **OpenCode V2 runtime**, it provides robust cross-platform support (Windows & Linux), zero-conflict single-polling lifecycle protection, and an advanced Markdown & table rendering engine tailored for Telegram.

---

## ✨ Highlights & Capabilities

- 💬 **Direct Agent Interaction**: Send prompts, follow-ups, or questions via Telegram. Receive clean Markdown responses with syntax-highlighted code blocks.
- ✍️ **Live Streaming Drafts**: Watch the agent think and draft text in real-time before finalizing the response turn.
- 📊 **Smart Markdown Table Engine**: Automatically renders Markdown tables into either clean Unicode monospace box tables (`<pre>`) or mobile-friendly card lists, eliminating broken columns.
- 🔐 **Interactive Permissions Gate**: Approve or reject system commands and sensitive file edits with one-tap inline buttons (`Once`, `Always`, `Reject`).
- 🔄 **Smart Desktop Session Sync**: Auto-detects active desktop coding sessions and mirrors notifications; seamlessly switch active sessions on the fly with `/sync`.
- ⚡ **Cross-Platform Remote Power Guard**: Query battery state and AC power source; activate a session-only 12% critical hibernation threshold with 16% early warning notifications.
- 🛡️ **Supervised Auto-Recovering Polling**: Resilient against network drops; features zero-conflict OS port locks and automatic reconnect without human intervention.
- 🚀 **Zero-Touch Bot Migration**: Automatically registers cloud commands, configures the native `[ ☰ ]` menu icon, sets localized bot descriptions, and resets update offsets whenever a new bot token is detected.
- 🧹 **Pure Inline UX (No Clunky Bars)**: Fully inline-driven experience with dynamic action cards, leaving the native Telegram input interface completely clean without obtrusive persistent keyboard buttons.
- 🎬 **Independent & Collision-Free**: Complete isolation from other Telegram tools (e.g. `emby-dl`), with strict token validation guards.

---

## 🏛️ Architecture & Data Flow

```text
  ┌─────────────────────────────────────────────────────────────┐
  │                     Telegram Cloud API                      │
  └──────────────┬───────────────────────────────▲──────────────┘
                 │ Updates (Long-Polling)        │ Outbound HTML
                 ▼                               │
  ┌──────────────────────────────────────────────┴──────────────┐
  │                 OpenCode V2 Telegram Bridge                 │
  │  ┌───────────────────────┐       ┌───────────────────────┐  │
  │  │  Supervised Poller    │       │  Event Subscription   │  │
  │  │  (Single-Lock Guard)  │       │  (V2 Core Bus)        │  │
  │  └───────────┬───────────┘       └───────────▲───────────┘  │
  │              │                               │              │
  │              ▼                               │              │
  │      ┌───────────────┐               ┌───────┴───────┐      │
  │      │  Handlers &   │               │ Markdown &    │      │
  │      │  Command Gate │               │ Table Engine  │      │
  │      └───────┬───────┘               └───────▲───────┘      │
  └──────────────┼───────────────────────────────┼──────────────┘
                 ▼                               │
  ┌──────────────────────────────────────────────┴──────────────┐
  │                  OpenCode Server Core (V2)                  │
  │   Sessions • Workspaces • Tool Calls • Permissions • VCS    │
  └─────────────────────────────────────────────────────────────┘
```

---

## 🚀 Quickstart Guide

### 1. Create a Telegram Bot
1. Open Telegram and search for the official **[@BotFather](https://t.me/BotFather)**.
2. Send `/newbot` and follow instructions to name your bot (e.g. `MyOpenCodeBot`).
3. Copy the generated **Bot API Token**.

### 2. Register the Plugin in OpenCode
Add the plugin folder path to your global OpenCode configuration at `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "C:/path/to/integrations/opencode-telegram"
  ]
}
```

### 3. Create Runtime Configuration
Create `~/.config/opencode/opencode-telegram.json` (or copy from `opencode-telegram.example.json`):

```json
{
  "token": "YOUR_TELEGRAM_BOT_TOKEN_HERE",
  "allowedChatIds": [],
  "defaultDirectory": "C:/Users/your-username/Projects/MyProject",
  "liveStream": true,
  "notifyAllSessions": true,
  "tableMode": "smart",
  "pollTimeoutSeconds": 25,
  "debug": false
}
```

### 4. Claim Your Chat ID
1. Open your new bot in Telegram and click **Start** (or send `/start`).
2. The bot will reply with your unique **Telegram Chat ID** and notify you that the chat is unauthorized.
3. Add your Chat ID into `allowedChatIds` in `opencode-telegram.json`:
   ```json
   "allowedChatIds": ["1234567890"]
   ```
4. Save the file. **No server restart is needed!** OpenCode hot-reloads configuration automatically.

---

## 🎮 Commands & Interactive Cards

| Command | Description |
| :--- | :--- |
| `/start` | Launch bot, verify access, and display the quick action card |
| `/menu` | Display the interactive inline control dashboard |
| `/current` | View current session details, activity state, and action buttons |
| `/sync` | One-tap sync with the most recently active session on your desktop |
| `/sessions` | List recent sessions across all projects with active indicators (`⭐`) |
| `/projects` | Browse local repositories/workspaces with direct switch buttons |
| `/new [title]` | Create a fresh session in the current project or specified path |
| `/use <id\|num>` | Switch directly to a session or project directory |
| `/status` | Inspect agent busy state and read the latest assistant message |
| `/power` *(or `/battery`)* | Battery health card with remote hibernation controls |
| `/stop` | Immediately interrupt active agent execution if busy |
| `/follow [all]` | Follow updates for a specific session or all sessions |
| `/unfollow` | Unfollow session notifications |
| `/notify [on\|off]` | Mute or unmute notifications for this chat |
| `/rename <title>` | Rename the current session |
| `/git` | View Git status, branch, and recent commit details |
| `/emby` | Query local media download pipeline status |
| `/id` | Show current Chat ID, Session ID, and active directory |

---

## ⚡ Remote Power & Battery Guard

The plugin contains a standalone, cross-platform power module (`power.ts`):

- **Query Power Status**:
  - **Windows**: Direct native SystemInformation API call.
  - **Linux**: Direct filesystem read from `/sys/class/power_supply/`.
- **Session-Only 12% Hibernation Guard**:
  - Completely non-invasive: does not touch Windows Startup, Task Scheduler, or system daemons.
  - Activated strictly on-demand via Telegram (`/power` -> `Enable Guard`).
  - At **16% battery**: Sends an early warning to plug in the charger.
  - At **12% battery**: Dispatches a critical alert and triggers native OS **Hibernation** (`shutdown /h` on Windows, `systemctl hibernate` on Linux) to preserve open files and unsaved work.
  - Automatically resets to disabled upon system reboot or reload.

---

## ⚙️ Configuration & Auto-Discovery

The bridge features a smart multi-location configuration resolver. You can place your configuration in any of the following locations:

1. **Local Project Folder**: `./opencode-telegram.json` or `./.opencode/opencode-telegram.json` *(ideal for repository-specific or portable setups)*
2. **Global User Config**: `~/.config/opencode/opencode-telegram.json` *(applies across all OpenCode projects)*
3. **Environment Variables**: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_IDS`

> 💡 **Automatic Template Creation**: If no configuration file exists upon first run, the plugin automatically creates a ready-to-use template file at `~/.config/opencode/opencode-telegram.json` and outputs instructions in the server log.

```jsonc
{
  // Secret Bot API token issued by BotFather
  "token": "1234567890:ABCdefGHIjklMNOpqrsTUVwxyz",

  // Security whitelist: only these Telegram Chat IDs can control the agent
  "allowedChatIds": ["1234567890"],

  // Fallback directory when creating sessions from Telegram
  "defaultDirectory": "C:/Users/username/Projects/MyProject",

  // Stream draft messages in real-time while agent is generating text
  "liveStream": true,

  // Mirror desktop/TUI session activity to Telegram
  "notifyAllSessions": true,

  // Table rendering style: "smart" (adaptive), "box" (monospace <pre>), or "list" (card list)
  "tableMode": "smart",

  // Python binary command or absolute path (optional)
  "pythonCommand": "python",

  // Telegram long-poll timeout in seconds
  "pollTimeoutSeconds": 25,

  // Verbose debug logging in telegram-bridge.log
  "debug": false
}
```

---

## 🧪 Automated Testing

The plugin includes an extensive automated test suite covering Markdown rendering, table adaptation, HTML tag balancing, cross-chunk tag propagation, security guards, and battery logic:

```bash
python tests/test_suite.py
```

All 26 test cases are validated with a 100% Quality Score across both Windows and Linux environments.

---

## 📁 Repository Structure

```text
integrations/opencode-telegram/
├── index.ts                     # Plugin entrypoint, lifecycle manager & supervised poller
├── bridge.ts                    # Session state, project resolution, and cache helpers
├── handlers.ts                  # Telegram command routers and inline callback handlers
├── events.ts                    # OpenCode V2 event bus subscription and notification delivery
├── power.ts                     # Cross-platform battery monitor and remote hibernation
├── telegram.ts                  # Telegram Bot API HTTP client and message dispatcher
├── store.ts                     # Configuration loading, validation, and safety checks
├── util.ts                      # Markdown-to-HTML parser, table engine, and tag balancer
├── tests/
│   └── test_suite.py            # Comprehensive 26-point automated test suite
├── opencode-telegram.example.json # Sample configuration template
├── package.json                 # Package metadata and peer dependencies
├── CHANGELOG.md                 # Detailed release history
├── CONTRIBUTING.md              # Contribution and development guidelines
├── LICENSE                      # MIT License
├── README.md                    # English documentation (Primary)
└── README_AR.md                 # Arabic documentation (العربية)
```

---

## 🔒 Security & Privacy

1. **Strict Whitelist**: Any unlisted chat ID attempting to send messages or callbacks is immediately blocked.
2. **External Secrets**: Tokens and Chat IDs live in `~/.config/opencode/`, safely outside version control and protected by `.gitignore`.
3. **Collision Shield**: Automatic token inspection prevents accidental collisions with other bots.

---

## 🤝 Contributing

Contributions are warmly welcome! To propose features or improvements:
1. Fork the repository.
2. Create your branch (`git checkout -b feature/cool-feature`).
3. Commit your changes (`git commit -m 'Add cool feature'`).
4. Push to the branch (`git push origin feature/cool-feature`).
5. Open a Pull Request.

---

## 📄 License

Distributed under the **MIT License**. See [LICENSE](LICENSE) for details.
