import { execFile } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import { Config, State, loadConfig, persistState } from "./store"
import { TelegramClient } from "./telegram"
import { ago, errorMessage, isBusySession, logError, samePath, shortId, shortPath } from "./util"

const execFileAsync = promisify(execFile)

export interface SessionRef {
  id: string
  title: string
  dir: string
  projectID?: string
  busy: boolean
  updated: number
  agent?: string
  model?: string
  cost?: number
}

export interface Run {
  sessionID: string
  originChat?: string
  started: number
  texts: string[]
  live: string
  draft?: { chatId: string; messageId: number; text: string; lastEdit: number }
  ackChat?: string
  ackMessageId?: number
  finalized: boolean
  liveTask?: Promise<void>
}

export interface PendingPermission {
  sessionID: string
  requestID: string
  createdAt: number
  messages: Record<string, number>
}

export interface Bridge {
  ctx: any
  hub: { abort: AbortController }
  config: Config
  state: State
  client: TelegramClient
  me?: any
  runs: Map<string, Run>
  pendingPermissions: Map<string, PendingPermission>
  sessionCache: Map<string, { ref: SessionRef; at: number }>
  lastAuthError: string
}

export function createBridge(ctx: any, hub: { abort: AbortController }, state: State): Bridge {
  const bridge: Bridge = {
    ctx,
    hub,
    config: loadConfig(),
    state,
    client: undefined as any,
    me: undefined,
    runs: new Map(),
    pendingPermissions: new Map(),
    sessionCache: new Map(),
    lastAuthError: "",
  }
  bridge.client = new TelegramClient(() => bridge.config.token)
  return bridge
}

export function refreshConfig(bridge: Bridge): Config {
  const config = loadConfig()
  if (config.token !== bridge.config.token) {
    bridge.me = undefined
    bridge.state.offset = 0
    bridge.lastAuthError = ""
    bridge.runs.clear()
    bridge.pendingPermissions.clear()
    persist(bridge).catch(() => undefined)
  }
  bridge.config = config
  return config
}

export async function persist(bridge: Bridge): Promise<void> {
  await persistState(bridge.ctx, bridge.state)
}

export function chatState(bridge: Bridge, chatId: string) {
  if (!bridge.state.chats[chatId]) bridge.state.chats[chatId] = {}
  return bridge.state.chats[chatId]
}

export function sessionDir(session: any): string {
  return String(session?.location?.directory || session?.directory || "")
}

export function toSessionRef(session: any): SessionRef {
  const s = session?.data && typeof session.data === "object" ? session.data : session
  const model = s?.model
  return {
    id: String(s?.id || ""),
    title: String(s?.title || shortId(String(s?.id || ""))),
    dir: sessionDir(s),
    projectID: s?.projectID,
    busy: isBusySession(s),
    updated: Number(s?.time?.updated) || 0,
    agent: s?.agent ? String(s.agent) : undefined,
    model: model ? `${model.providerID || ""}/${model.id || ""}` : undefined,
    cost: Number(s?.cost) || 0,
  }
}

export async function listRootSessions(bridge: Bridge, limit = 100): Promise<any[]> {
  try {
    const page = await bridge.ctx.session.list({ limit, order: "desc" })
    const data = Array.isArray(page) ? page : page?.data
    if (!Array.isArray(data)) return []
    return data.filter((session: any) => !session?.parentID)
  } catch (error) {
    logError("session.list failed:", errorMessage(error))
    return []
  }
}

export async function sessionInfo(
  bridge: Bridge,
  sessionID: string,
  options: { refresh?: boolean } = {},
): Promise<SessionRef | undefined> {
  const id = String(sessionID || "")
  if (!id) return undefined
  const cached = bridge.sessionCache.get(id)
  if (!options.refresh && cached && Date.now() - cached.at < 15000) return cached.ref
  try {
    const session = await bridge.ctx.session.get({ sessionID: id })
    const ref = toSessionRef(session)
    bridge.sessionCache.set(id, { ref, at: Date.now() })
    return ref
  } catch {
    bridge.sessionCache.delete(id)
    return undefined
  }
}

export function defaultDirectory(bridge: Bridge, chatId: string): string {
  const chat = bridge.state.chats[chatId]
  return (
    chat?.projectDir ||
    bridge.config.defaultDirectory ||
    bridge.ctx.location?.project?.canonical ||
    bridge.ctx.location?.directory ||
    process.cwd()
  )
}

export async function createSession(
  bridge: Bridge,
  chatId: string,
  directory: string,
  title?: string,
): Promise<SessionRef | undefined> {
  const sessionTitle = title?.trim() || `Telegram ${new Date().toLocaleString("ar-EG")}`
  let created: any
  try {
    created = await bridge.ctx.session.create({
      title: sessionTitle,
      location: { directory },
    })
  } catch (error) {
    logError("session.create with location failed, retrying:", errorMessage(error))
    created = await bridge.ctx.session.create({ title: sessionTitle })
    try {
      await bridge.ctx.session.move({ sessionID: created.id, directory })
    } catch (moveError) {
      logError("session.move failed:", errorMessage(moveError))
    }
  }
  if (!created?.id) return undefined
  const chat = chatState(bridge, chatId)
  chat.sessionID = created.id
  chat.projectDir = directory
  await persist(bridge)
  const ref = toSessionRef(created)
  bridge.sessionCache.set(ref.id, { ref, at: Date.now() })
  return ref
}

export async function ensureSession(bridge: Bridge, chatId: string): Promise<SessionRef | undefined> {
  const chat = chatState(bridge, chatId)
  if (chat.sessionID) {
    const info = await sessionInfo(bridge, chat.sessionID)
    if (info) return info
    chat.sessionID = undefined
  }

  const sessions = await listRootSessions(bridge)
  const preferred =
    (chat.projectDir ? sessions.find((session) => samePath(sessionDir(session), chat.projectDir!)) : undefined) ||
    sessions[0]
  if (preferred?.id) {
    chat.sessionID = preferred.id
    if (!chat.projectDir) chat.projectDir = sessionDir(preferred)
    await persist(bridge)
    return toSessionRef(preferred)
  }

  return createSession(bridge, chatId, defaultDirectory(bridge, chatId))
}

export function buildProjects(sessions: any[]) {
  const map = new Map<string, { dir: string; count: number; updated: number; title: string }>()
  for (const session of sessions) {
    const dir = sessionDir(session)
    if (!dir) continue
    const key = dir.replace(/\\/g, "/").toLowerCase()
    const current = map.get(key) || { dir, count: 0, updated: 0, title: "" }
    current.count += 1
    const updated = Number(session?.time?.updated) || 0
    if (updated > current.updated) {
      current.updated = updated
      current.title = String(session?.title || "")
    }
    map.set(key, current)
  }
  return [...map.values()].sort((a, b) => b.updated - a.updated)
}

export async function findLatestSessionInDir(bridge: Bridge, directory: string): Promise<SessionRef | undefined> {
  const sessions = await listRootSessions(bridge)
  const match = sessions.find((session) => samePath(sessionDir(session), directory))
  return match ? toSessionRef(match) : undefined
}

export function projectByName(sessions: any[], name: string): string | undefined {
  const projects = buildProjects(sessions)
  const needle = String(name || "").toLowerCase()
  const exact = projects.find((project) => project.dir.replace(/\\/g, "/").toLowerCase() === needle)
  if (exact) return exact.dir
  const byBase = projects.find((project) => {
    const parts = project.dir.split(/[\\/]+/).filter(Boolean)
    return (parts[parts.length - 1] || "").toLowerCase() === needle
  })
  return byBase?.dir
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function resolveProjectArg(bridge: Bridge, chatId: string, arg: string, sessions: any[]): string | undefined {
  const value = String(arg || "").trim().replace(/^["']|["']$/g, "")
  if (!value) return undefined
  const projectIndex = value.match(/^p(\d+)$/i)
  if (projectIndex) {
    const list = bridge.state.chats[chatId]?.projectList || []
    return list[Number(projectIndex[1]) - 1]
  }
  if (isDirectory(value)) return value
  return projectByName(sessions, value)
}

export function resolveSessionArg(bridge: Bridge, chatId: string, arg: string): string | undefined {
  const value = String(arg || "").trim().replace(/^["']|["']$/g, "")
  if (!value) return undefined
  const sessionIndex = value.match(/^s(\d+)$/i)
  if (sessionIndex) {
    const list = bridge.state.chats[chatId]?.sessionList || []
    return list[Number(sessionIndex[1]) - 1]
  }
  if (value.startsWith("ses_")) return value
  return undefined
}

export function newRun(sessionID: string): Run {
  return {
    sessionID,
    started: Date.now(),
    texts: [],
    live: "",
    finalized: false,
  }
}

export async function gitStatus(directory: string): Promise<{ status?: string; log?: string }> {
  try {
    const status = await execFileAsync("git", ["-C", directory, "status", "--short", "--branch"], {
      timeout: 10000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    })
    let log = ""
    try {
      const last = await execFileAsync("git", ["-C", directory, "log", "-1", "--pretty=format:%h %s (%cr)"], {
        timeout: 10000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      })
      log = String(last.stdout || "").trim()
    } catch {
      log = ""
    }
    return { status: String(status.stdout || "").trim(), log }
  } catch {
    return {}
  }
}

export async function embyStatus(bridge: Bridge, directory: string): Promise<any> {
  const script = join(directory, "emby_dl.py")
  if (!existsSync(script)) return { found: false }
  try {
    const result = await execFileAsync(bridge.config.pythonCommand, [script, "status", "--json"], {
      cwd: directory,
      timeout: 25000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    })
    return { found: true, data: JSON.parse(String(result.stdout || "{}")) }
  } catch (error) {
    return { found: true, error: errorMessage(error) }
  }
}

export async function lastAssistantText(bridge: Bridge, sessionID: string): Promise<string> {
  try {
    const messages = await bridge.ctx.session.context({ sessionID })
    if (!Array.isArray(messages)) return ""
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.type !== "assistant") continue
      const content = Array.isArray(message.content) ? message.content : []
      const text = content
        .filter((part: any) => part?.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text)
        .join("\n")
        .trim()
      if (text) return text
    }
  } catch {
    // Ignore context errors.
  }
  return ""
}

export function modelLabel(session: any): string {
  const model = session?.model
  if (!model) return "—"
  return `${model.providerID || ""}/${model.id || ""}`
}

export function projectLabel(directory: string): string {
  return shortPath(directory, 2) || directory || "—"
}

export function describeSession(ref: SessionRef | undefined): string {
  if (!ref) return "لا توجد جلسة"
  return `${ref.title} — ${projectLabel(ref.dir)} — ${ago(ref.updated)}`
}
