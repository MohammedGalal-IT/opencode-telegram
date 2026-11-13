# Contributing to OpenCode Telegram Bridge

Thank you for your interest in contributing to **OpenCode Telegram Bridge**!

## Development Setup

1. **Clone & Link**:
   Clone this repository or place it in your OpenCode plugins directory.

2. **Register Plugin**:
   Add the directory path to your `~/.config/opencode/opencode.jsonc`:
   ```jsonc
   {
     "plugins": [
       "/path/to/opencode-telegram"
     ]
   }
   ```

3. **Configure Secrets**:
   Create your test configuration at `~/.config/opencode/opencode-telegram.json`:
   ```json
   {
     "token": "YOUR_DEV_BOT_TOKEN",
     "allowedChatIds": ["YOUR_CHAT_ID"],
     "debug": true
   }
   ```

4. **Verify Live Logs**:
   Inspect real-time plugin diagnostics:
   ```sh
   tail -f ~/.config/opencode/telegram-bridge.log
   ```

## Guidelines

- Keep changes consistent with the TypeScript patterns and OpenCode V2 SDK conventions.
- Maintain strict cross-platform compatibility (Windows and Linux).
- Never commit private bot tokens, Chat IDs, or local log files.
- Write clear commit messages and describe changes in your pull request.
