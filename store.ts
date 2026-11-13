import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { errorMessage, log, logError } from "./util"

export const GLOBAL_CONFIG_PATH = join(homedir(), ".config", "opencode", "opencode-telegram.json")
export const CONFIG_PATH = GLOBAL_CONFIG_PATH
export const STATE_KEY = "bridge.state.v1"

export interface Config {
  token: string
  allowedChatIds: string[]
  defaultDirectory?: string
  liveStream: boolean
  notifyAllSessions: boolean
  pythonCommand: string
  pollTimeoutSeconds: number
  tableMode: "smart" | "box" | "list"
  debug: boolean
}

export interface ChatState {
  sessionID?: string
  projectDir?: string
  muted?: boolean
  all?: boolean
  sessionList?: string[]
  projectList?: string[]
}

export interface State {
  offset: number
  chats: Record<string, ChatState>
  followed: string[]
}

let lastConfigError = ""
let createdTemplateNotice = false

function normalizeIds(value: any): string[] {
  const list = Array.isArray(value) ? value : value == null ? [] : [value]
  return list
    .map((item) => String(item).trim())
    .filter((item) => item.length > 0)
}

/**
 * Searches for configuration in order of precedence:
 * 1. Project local: ./opencode-telegram.json
 * 2. Project .opencode: ./.opencode/opencode-telegram.json
 * 3. Global user config: ~/.config/opencode/opencode-telegram.json
 */
export function resolveConfigFile(): { path: string; exists: boolean } {
  const candidates: string[] = []

  try {
    const cwd = process.cwd()
    if (cwd) {
      candidates.push(join(cwd, "opencode-telegram.json"))
      candidates.push(join(cwd, ".opencode", "opencode-telegram.json"))
    }
  } catch {}

  candidates.push(GLOBAL_CONFIG_PATH)

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return { path: candidate, exists: true }
    }
  }

  return { path: GLOBAL_CONFIG_PATH, exists: false }
}

function ensureConfigTemplate(targetPath: string): void {
  if (createdTemplateNotice || existsSync(targetPath)) return
  try {
    const dir = dirname(targetPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    const template = {
      token: "",
      allowedChatIds: [],
      defaultDirectory: process.cwd().replace(/\\/g, "/") || undefined,
      liveStream: true,
      notifyAllSessions: true,
      tableMode: "smart",
      pollTimeoutSeconds: 25,
      debug: false,
    }
    writeFileSync(targetPath, JSON.stringify(template, null, 2), "utf8")
    log(`No config found. Automatically created template at: ${targetPath}`)
    log("Please add your Telegram bot token from @BotFather to start chatting.")
    createdTemplateNotice = true
  } catch (error) {
    // Non-fatal if filesystem is restricted
  }
}

export function loadConfig(): Config {
  let file: any = {}
  const { path: configPath, exists } = resolveConfigFile()

  if (exists) {
    try {
      file = JSON.parse(readFileSync(configPath, "utf8"))
    } catch (error) {
      const message = errorMessage(error)
      if (message !== lastConfigError) {
        lastConfigError = message
        logError(`cannot parse ${configPath}: ${message}`)
      }
      file = {}
    }
  } else {
    ensureConfigTemplate(configPath)
  }

  const envToken = String(process.env.TELEGRAM_BOT_TOKEN || "").trim()
  const envIds = String(process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_ALLOWED_CHAT_IDS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)

  const rawTableMode = String(file.tableMode || "smart").toLowerCase()
  const tableMode = ["box", "list", "smart"].includes(rawTableMode) ? (rawTableMode as "smart" | "box" | "list") : "smart"

  let token = envToken || String(file.token || "").trim()
  // Safety check: ensure OpenCode never collides with emby-dl bot token
  if (token.startsWith("9025456415:")) {
    logError("Safety check: OpenCode cannot use the emby-dl bot token. They must remain completely separate.")
    token = ""
  }

  const timeout = Number(file.pollTimeoutSeconds)
  return {
    token,
    allowedChatIds: [...normalizeIds(file.allowedChatIds), ...envIds],
    defaultDirectory: String(file.defaultDirectory || process.env.TELEGRAM_DEFAULT_DIR || "") || undefined,
    liveStream: file.liveStream !== false,
    notifyAllSessions: file.notifyAllSessions === true,
    pythonCommand: String(file.pythonCommand || (process.platform === "win32" ? "python" : "python3")),
    pollTimeoutSeconds: Number.isFinite(timeout) && timeout > 0 ? Math.min(50, timeout) : 25,
    tableMode,
    debug: file.debug === true || process.env.TELEGRAM_BRIDGE_DEBUG === "1",
  }
}

export async function loadState(ctx: any): Promise<State> {
  let raw: any = undefined
  try {
    raw = await ctx.storage.get(STATE_KEY)
  } catch (error) {
    logError("cannot read persisted state:", errorMessage(error))
  }
  const value = raw && typeof raw === "object" ? raw : {}
  const chats: Record<string, ChatState> = {}
  if (value.chats && typeof value.chats === "object") {
    for (const [chatId, chat] of Object.entries(value.chats)) {
      if (chat && typeof chat === "object") chats[chatId] = chat as ChatState
    }
  }
  return {
    offset: Number(value.offset) || 0,
    chats,
    followed: Array.isArray(value.followed) ? value.followed.filter((item: any) => typeof item === "string") : [],
  }
}

export async function persistState(ctx: any, state: State): Promise<void> {
  try {
    await ctx.storage.set(STATE_KEY, state)
  } catch (error) {
    logError("cannot persist state:", errorMessage(error))
  }
}
