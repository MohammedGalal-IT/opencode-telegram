import {
  Bridge,
  Run,
  chatState,
  newRun,
  projectLabel,
  sessionInfo,
} from "./bridge"
import { deleteMessage, editHtml, sendChatAction, sendHtml, sendMarkdown } from "./telegram"
import {
  errorMessage,
  escapeHtml,
  log,
  logError,
  makeShortId,
  mdToHtml,
  shortId,
  sleep,
  truncate,
} from "./util"

const EVENT_TYPES = [
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.text.delta",
  "session.text.ended",
  "session.idle",
  "session.created",
  "session.renamed",
  "permission.asked",
  "permission.replied",
] as const

const LIVE_EDIT_INTERVAL = 1200
const LIVE_TAIL = 2600

export function startRun(bridge: Bridge, sessionID: string, chatId?: string): Run {
  let run = bridge.runs.get(sessionID)
  if (!run || run.finalized) {
    run = newRun(sessionID)
    bridge.runs.set(sessionID, run)
  }
  if (chatId) run.originChat = chatId
  return run
}

function ownerChat(bridge: Bridge, sessionID: string): string | undefined {
  for (const [chatId, chat] of Object.entries(bridge.state.chats)) {
    if (chat?.sessionID === sessionID) return chatId
  }
  return undefined
}

function ensureRun(bridge: Bridge, sessionID: string): Run {
  const existing = bridge.runs.get(sessionID)
  if (existing && !existing.finalized) return existing
  const run = newRun(sessionID)
  run.originChat = ownerChat(bridge, sessionID)
  bridge.runs.set(sessionID, run)
  return run
}

function notificationChats(bridge: Bridge, run: Run): string[] {
  const allowed = bridge.config.allowedChatIds
  if (allowed.length === 0) return []
  const out = new Set<string>()
  if (run.originChat && allowed.includes(run.originChat)) out.add(run.originChat)
  for (const chatId of allowed) {
    if (out.has(chatId)) continue
    const chat = chatState(bridge, chatId)
    if (chat.sessionID === run.sessionID) {
      out.add(chatId)
      continue
    }
    if (chat.muted) continue
    if (bridge.state.followed.includes(run.sessionID) || chat.all || bridge.config.notifyAllSessions) {
      out.add(chatId)
    }
  }
  return [...out]
}

async function cleanupRunMessages(bridge: Bridge, run: Run): Promise<void> {
  if (run.draft) {
    await deleteMessage(bridge.client, run.draft.chatId, run.draft.messageId)
    run.draft = undefined
  }
  if (run.ackChat && run.ackMessageId) {
    await deleteMessage(bridge.client, run.ackChat, run.ackMessageId)
    run.ackMessageId = undefined
  }
}

async function updateDraft(bridge: Bridge, run: Run, force = false): Promise<void> {
  if (!run.originChat || !bridge.config.liveStream) return
  const live = run.live.trim()
  if (!live) return
  const now = Date.now()
  if (run.draft && !force && now - run.draft.lastEdit < LIVE_EDIT_INTERVAL) return
  const tail = live.length > LIVE_TAIL ? "…" + live.slice(-LIVE_TAIL) : live
  const html = `✍️ <i>يكتب…</i>\n\n${mdToHtml(tail, bridge.config.tableMode)}`
  if (!run.draft) {
    try {
      const sent = await sendHtml(bridge.client, run.originChat, html)
      if (sent?.message_id) {
        run.draft = { chatId: run.originChat, messageId: sent.message_id, text: html, lastEdit: now }
      }
    } catch (error) {
      logError("cannot create live draft:", errorMessage(error))
    }
    return
  }
  if (html === run.draft.text) return
  await editHtml(bridge.client, run.draft.chatId, run.draft.messageId, html)
  run.draft.text = html
  run.draft.lastEdit = now
}

async function finalize(bridge: Bridge, run: Run): Promise<void> {
  if (run.finalized) return
  run.finalized = true
  if (run.liveTask) {
    try {
      await run.liveTask
    } catch {
      // Ignore draft errors before the final message.
    }
  }
  await cleanupRunMessages(bridge, run)

  const joined = run.texts.join("\n\n").trim()
  const text = joined.length >= run.live.trim().length ? joined : run.live.trim()
  const chats = notificationChats(bridge, run)
  if (chats.length === 0) return

  if (!text) {
    if (run.originChat) {
      await sendHtml(bridge.client, run.originChat, "✅ <b>اكتمل التنفيذ</b> بدون نص.")
    }
    return
  }

  let header = ""
  const needsHeader = chats.some((chatId) => chatId !== run.originChat)
  if (needsHeader) {
    const info = await sessionInfo(bridge, run.sessionID)
    const title = info?.title || shortId(run.sessionID)
    const project = info?.dir ? projectLabel(info.dir) : ""
    header = `🧩 <b>${escapeHtml(title)}</b>${project ? ` — <i>${escapeHtml(project)}</i>` : ""}\n\n`
  }

  const htmlBody = mdToHtml(text, bridge.config.tableMode)
  for (const chatId of chats) {
    const prefix = chatId === run.originChat ? "" : header
    const fullHtml = prefix ? `${prefix}${htmlBody}` : htmlBody
    try {
      await sendHtml(bridge.client, chatId, fullHtml)
    } catch (error) {
      logError(`cannot deliver reply to ${chatId}:`, errorMessage(error))
    }
  }

  // Clean up completed run from memory after 30 seconds
  const cleanupTimer = setTimeout(() => {
    const current = bridge.runs.get(run.sessionID)
    if (current?.finalized) {
      bridge.runs.delete(run.sessionID)
    }
  }, 30000)
  cleanupTimer.unref?.()
}

async function failRun(bridge: Bridge, run: Run, error: any): Promise<void> {
  if (run.finalized) return
  run.finalized = true
  if (run.liveTask) {
    try {
      await run.liveTask
    } catch {
      // Ignore.
    }
  }
  await cleanupRunMessages(bridge, run)
  const message = truncate(errorMessage(error), 900)
  const chats = notificationChats(bridge, run)
  if (chats.length === 0) return
  for (const chatId of chats) {
    try {
      await sendHtml(
        bridge.client,
        chatId,
        `❌ <b>فشل التنفيذ</b>${chatId === run.originChat ? "" : `\nالجلسة: <code>${escapeHtml(shortId(run.sessionID))}</code>`}\n\n<code>${escapeHtml(message)}</code>`,
      )
    } catch (deliveryError) {
      logError("cannot deliver failure:", errorMessage(deliveryError))
    }
  }
}

function permissionHtml(bridge: Bridge, data: any, session: any): string {
  const lines = [
    "🔐 <b>طلب إذن</b>",
    "",
    `الإجراء: <code>${escapeHtml(String(data.action || "—"))}</code>`,
  ]
  const resources = Array.isArray(data.resources) ? data.resources : []
  if (resources.length > 0) {
    lines.push("الموارد:")
    for (const resource of resources.slice(0, 8)) lines.push(`• <code>${escapeHtml(truncate(String(resource), 300))}</code>`)
    if (resources.length > 8) lines.push(`• … و${resources.length - 8} أخرى`)
  }
  if (data.message) lines.push("", escapeHtml(String(data.message)))
  const title = session?.title || shortId(String(data.sessionID || ""))
  const project = session?.dir ? projectLabel(session.dir) : ""
  lines.push("", `الجلسة: <b>${escapeHtml(truncate(String(title), 80))}</b>`)
  if (project) lines.push(`المشروع: <i>${escapeHtml(project)}</i>`)
  return lines.join("\n")
}

async function askPermission(bridge: Bridge, data: any): Promise<void> {
  const allowed = bridge.config.allowedChatIds
  if (allowed.length === 0) return
  const requestID = String(data.id || "")
  const sessionID = String(data.sessionID || "")
  if (!requestID || !sessionID) return

  let token = makeShortId(8)
  while (bridge.pendingPermissions.has(token)) token = makeShortId(8)

  const pending = { sessionID, requestID, createdAt: Date.now(), messages: {} as Record<string, number> }
  bridge.pendingPermissions.set(token, pending)

  const session = await sessionInfo(bridge, sessionID)
  const html = permissionHtml(bridge, data, session)
  const keyboard = {
    inline_keyboard: [
      [{ text: "✅ مرة واحدة", callback_data: `perm:${token}:once` }],
      [{ text: "♾️ دائماً", callback_data: `perm:${token}:always` }],
      [{ text: "⛔ رفض", callback_data: `perm:${token}:reject` }],
    ],
  }

  for (const chatId of allowed) {
    try {
      const sent = await sendHtml(bridge.client, chatId, html, { reply_markup: keyboard })
      if (sent?.message_id) pending.messages[chatId] = sent.message_id
    } catch (error) {
      logError(`cannot send permission request to ${chatId}:`, errorMessage(error))
    }
  }

  if (Object.keys(pending.messages).length === 0) bridge.pendingPermissions.delete(token)
}

async function onPermissionReplied(bridge: Bridge, data: any): Promise<void> {
  const requestID = String(data.requestID || "")
  for (const [token, pending] of bridge.pendingPermissions) {
    if (pending.requestID !== requestID) continue
    bridge.pendingPermissions.delete(token)
    for (const [chatId, messageId] of Object.entries(pending.messages)) {
      await editHtml(bridge.client, chatId, messageId, "<b>✅ تم الرد على الطلب</b>", {
        reply_markup: { inline_keyboard: [] },
      })
    }
  }
}

async function handleEvent(bridge: Bridge, event: any): Promise<void> {
  const data = event?.data || {}
  const sessionID = String(data.sessionID || "")
  if (bridge.config.debug) log("event", event?.type, sessionID ? shortId(sessionID) : "")

  switch (event.type) {
    case "session.execution.started": {
      if (!sessionID) return
      const run = ensureRun(bridge, sessionID)
      // Smart sync: when user starts working on a session (e.g. from Desktop),
      // keep single allowed chat automatically synced to this active session.
      if (!run.originChat && bridge.config.allowedChatIds.length === 1) {
        const singleChatId = bridge.config.allowedChatIds[0]
        const chat = chatState(bridge, singleChatId)
        chat.sessionID = sessionID
        run.originChat = singleChatId
      }
      const chatId = run.originChat
      if (chatId) await sendChatAction(bridge.client, chatId, "typing")
      return
    }

    case "session.text.delta": {
      if (!sessionID) return
      const run = ensureRun(bridge, sessionID)
      run.live += String(data.delta || "")
      if (run.originChat && bridge.config.liveStream) {
        run.liveTask = (run.liveTask || Promise.resolve())
          .then(() => updateDraft(bridge, run))
          .catch((error) => logError("live draft failed:", errorMessage(error)))
      }
      return
    }

    case "session.text.ended": {
      if (!sessionID) return
      const run = ensureRun(bridge, sessionID)
      const text = String(data.text || "")
      if (text && !run.texts.includes(text)) {
        run.texts.push(text)
      }
      return
    }

    case "session.execution.succeeded": {
      if (!sessionID) return
      const run = bridge.runs.get(sessionID)
      if (!run || run.finalized) return
      await finalize(bridge, run)
      return
    }

    case "session.idle": {
      // Do not finalize on idle! Multi-step tool runs trigger idle between steps.
      return
    }

    case "session.execution.failed": {
      if (!sessionID) return
      const existing = bridge.runs.get(sessionID)
      if (existing?.finalized) return
      const run = existing || ensureRun(bridge, sessionID)
      await failRun(bridge, run, data.error || { message: "خطأ غير معروف" })
      return
    }

    case "session.execution.interrupted": {
      if (!sessionID) return
      const run = bridge.runs.get(sessionID)
      if (!run || run.finalized) return
      run.finalized = true
      await cleanupRunMessages(bridge, run)
      if (data.reason === "user" || run.originChat) {
        const chats = notificationChats(bridge, run)
        for (const chatId of chats) {
          await sendHtml(bridge.client, chatId, "⏹ <b>تم إيقاف التنفيذ</b>").catch(() => undefined)
        }
      }
      return
    }

    case "session.created": {
      if (!sessionID) return
      bridge.sessionCache.delete(sessionID)
      return
    }

    case "session.renamed": {
      if (!sessionID) return
      bridge.sessionCache.delete(sessionID)
      return
    }

    case "permission.asked": {
      await askPermission(bridge, data)
      return
    }

    case "permission.replied": {
      await onPermissionReplied(bridge, data)
      return
    }

    default:
      return
  }
}

export function startEvents(bridge: Bridge, signal?: AbortSignal): { stop: () => void; done: Promise<void> } {
  const controller = new AbortController()
  signal?.addEventListener("abort", () => controller.abort(), { once: true })

  const done = (async () => {
    let backoff = 1000
    while (!controller.signal.aborted) {
      try {
        if (bridge.config.debug) log("subscribing to OpenCode events")
        for await (const event of bridge.ctx.event.subscribe({
          types: [...EVENT_TYPES],
          signal: controller.signal,
        })) {
          if (controller.signal.aborted) break
          try {
            await handleEvent(bridge, event)
          } catch (error) {
            logError(`event ${event?.type} failed:`, errorMessage(error))
          }
        }
        backoff = 1000
      } catch (error) {
        if (controller.signal.aborted) break
        logError("event stream ended:", errorMessage(error))
        await sleep(backoff, controller.signal)
        backoff = Math.min(backoff * 2, 30000)
      }
    }
  })()

  return { stop: () => controller.abort(), done }
}

export function reportStartup(bridge: Bridge): void {
  const token = bridge.config.token ? "موجود" : "غير موجود"
  log(`started. token=${token}, allowedChatIds=${bridge.config.allowedChatIds.length}`)
  if (!bridge.config.token) {
    log("Telegram is idle until a bot token is configured in ~/.config/opencode/opencode-telegram.json")
  }
}
