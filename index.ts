import { Plugin } from "@opencode/plugin"
import { Bridge, createBridge, persist, refreshConfig } from "./bridge"
import { handleCallback, handleCommand, handleText, isAllowed, sendUnauthorized } from "./handlers"
import { reportStartup, startEvents } from "./events"
import { loadState } from "./store"
import { stopPowerGuard } from "./power"
import { errorMessage, log, logError, parseCommand, sleep } from "./util"

async function handleUpdate(bridge: Bridge, update: any): Promise<void> {
  if (update?.callback_query) {
    const query = update.callback_query
    const chatId = String(query?.message?.chat?.id ?? query?.from?.id ?? "")
    if (!chatId) return
    if (!isAllowed(bridge, chatId)) {
      await sendUnauthorized(bridge, chatId)
      try {
        await bridge.client.call("answerCallbackQuery", {
          callback_query_id: query.id,
          text: "هذه المحادثة غير مصرّح لها.",
          show_alert: true,
        })
      } catch {
        // Ignore callback errors for unauthorized chats.
      }
      return
    }
    await handleCallback(bridge, chatId, query)
    return
  }

  const message = update?.message
  if (!message) return
  const chatId = String(message?.chat?.id ?? "")
  if (!chatId) return
  if (!isAllowed(bridge, chatId)) {
    await sendUnauthorized(bridge, chatId)
    return
  }

  const text = String(message.text ?? "").trim()
  if (!text) {
    await bridge.client
      .call("sendMessage", { chat_id: chatId, text: "أرسل رسالة نصية فقط. الصور والملفات غير مدعومة بعد." })
      .catch(() => undefined)
    return
  }

  const command = parseCommand(text, bridge.me?.username)
  if (command) {
    if (command.name === "__ignore") return
    await handleCommand(bridge, chatId, command.name, command.args)
    return
  }

  await handleText(bridge, chatId, text)
}

async function registerBotCommands(bridge: Bridge): Promise<void> {
  try {
    // 1. Delete any stale webhooks on the new bot so getUpdates works reliably
    await bridge.client.call("deleteWebhook", { drop_pending_updates: false }, undefined, 10000).catch(() => undefined)

    // 2. Register all bot commands
    await bridge.client.call(
      "setMyCommands",
      {
        commands: [
          { command: "start", description: "بدء استخدام الجسر" },
          { command: "menu", description: "لوحة التحكم السريعة" },
          { command: "help", description: "عرض دليل الأوامر" },
          { command: "current", description: "الجلسة الحالية وتفاصيلها" },
          { command: "sync", description: "مزامنة الجلسة النشطة" },
          { command: "sessions", description: "أحدث الجلسات والانتقال" },
          { command: "projects", description: "قائمة المشاريع" },
          { command: "new", description: "إنشاء جلسة جديدة" },
          { command: "use", description: "تبديل الجلسة أو المشروع" },
          { command: "status", description: "حالة الجلسة وآخر رد" },
          { command: "power", description: "حالة البطارية والتحكم بالطاقة" },
          { command: "stop", description: "إيقاف التنفيذ الحالي" },
          { command: "git", description: "حالة مستودع Git" },
          { command: "emby", description: "حالة تنزيلات emby-dl" },
          { command: "follow", description: "متابعة جلسة" },
          { command: "notify", description: "كتم/تشغيل الإشعارات" },
          { command: "id", description: "المعرّفات وحساب المحادثة" },
        ],
      },
      undefined,
      15000,
    )

    // 3. Configure default clean menu button (commands icon, no awkward labels)
    await bridge.client.call("setChatMenuButton", { menu_button: { type: "commands" } }, undefined, 10000).catch(() => undefined)

    // 4. Set bot profile descriptions for first-time visitors
    await bridge.client.call(
      "setMyDescription",
      {
        description: "🤖 المساعد البرمجي الذكي OpenCode — تحكم بكافة مشاريعك وجلسات العمل البرمجية عن بُعد عبر تيليجرام.",
      },
      undefined,
      10000,
    ).catch(() => undefined)

    await bridge.client.call(
      "setMyShortDescription",
      {
        short_description: "جسر OpenCode الذكي للتحكم بالجلسات والمشاريع.",
      },
      undefined,
      10000,
    ).catch(() => undefined)
  } catch (error) {
    logError("cannot register bot commands:", errorMessage(error))
  }
}

const GLOBAL_POLL_RUNNING = Symbol.for("opencode.telegram.bridge.poll_running_single")

async function pollLoop(bridge: Bridge, signal: AbortSignal): Promise<void> {
  const g = globalThis as any
  if (g[GLOBAL_POLL_RUNNING]) {
    log("polling loop is already running in this server process; keeping duplicate as passive event listener.")
    return
  }
  g[GLOBAL_POLL_RUNNING] = true

  let missingLogged = false
  let backoff = 1000
  let lastError = ""

  try {
    while (!signal.aborted) {
    const config = refreshConfig(bridge)

    if (!config.token) {
      if (!missingLogged) {
        log("waiting for a bot token in ~/.config/opencode/opencode-telegram.json")
        missingLogged = true
      }
      await sleep(5000, signal)
      continue
    }
    missingLogged = false

    if (!bridge.me) {
      try {
        bridge.me = await bridge.client.call("getMe", {}, signal, 15000)
        log(`connected as @${bridge.me?.username || bridge.me?.first_name || "bot"}`)
        lastError = ""
        await registerBotCommands(bridge)
      } catch (error) {
        const message = errorMessage(error)
        if (message !== lastError) {
          lastError = message
          logError("cannot reach Telegram (check the token):", message)
        }
        await sleep(backoff, signal)
        backoff = Math.min(backoff * 2, 60000)
        continue
      }
    }

    if (config.allowedChatIds.length === 0) {
      if (!missingLogged) {
        log("no allowedChatIds yet; send /start to the bot to discover your chat ID")
        missingLogged = true
      }
    }

    const timeout = config.pollTimeoutSeconds
    try {
      const updates = await bridge.client.call(
        "getUpdates",
        { offset: bridge.state.offset, timeout, allowed_updates: ["message", "callback_query"] },
        signal,
        timeout * 1000 + 20000,
      )
      backoff = 1000
      lastError = ""
      if (Array.isArray(updates) && updates.length > 0) {
        for (const update of updates) {
          if (signal.aborted) break
          bridge.state.offset = Math.max(bridge.state.offset, Number(update?.update_id || 0) + 1)
          try {
            await handleUpdate(bridge, update)
          } catch (error) {
            logError("update handling failed:", errorMessage(error))
          }
        }
        await persist(bridge)
      }
    } catch (error) {
      if (signal.aborted) break
      const message = errorMessage(error)
      const isTimeout = /timed out|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(message)
      if (!isTimeout) {
        if (message !== lastError) {
          lastError = message
          logError("getUpdates failed:", message)
        }
        await sleep(backoff, signal)
        backoff = Math.min(backoff * 2, 30000)
      } else {
        backoff = 1000
        lastError = ""
        await sleep(300, signal)
      }
    }
  }
} finally {
  delete (globalThis as any)[GLOBAL_POLL_RUNNING]
}
}

const HUB_KEY = Symbol.for("opencode.telegram.bridge.v1")

interface Hub {
  controller: AbortController
  promise: Promise<Bridge>
  stop: () => void
  refCount: number
  cleanupTimer?: NodeJS.Timeout
}

function hubStore(): Record<symbol, Hub> {
  return globalThis as any
}

async function runSupervisedPoll(bridge: Bridge, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      await pollLoop(bridge, signal)
    } catch (error) {
      if (signal.aborted) break
      logError("pollLoop crashed, auto-recovering in 3s:", errorMessage(error))
    }
    if (signal.aborted) break
    await sleep(3000, signal)
  }
}

async function startBridge(ctx: any, controller: AbortController): Promise<Bridge> {
  const state = await loadState(ctx)
  const bridge = createBridge(ctx, { abort: controller }, state)
  reportStartup(bridge)

  startEvents(bridge, controller.signal)
  runSupervisedPoll(bridge, controller.signal).catch((err) => {
    logError("supervised poll stopped:", errorMessage(err))
  })

  return bridge
}

function acquire(ctx: any): Promise<Bridge> {
  const store = hubStore()
  if (store[HUB_KEY] && !store[HUB_KEY].controller?.signal?.aborted) {
    const hub = store[HUB_KEY]
    if (hub.cleanupTimer) {
      clearTimeout(hub.cleanupTimer)
      hub.cleanupTimer = undefined
    }
    hub.refCount = (hub.refCount || 0) + 1
    hub.promise
      .then((bridge) => {
        bridge.ctx = ctx
      })
      .catch(() => undefined)
    return hub.promise
  }

  const controller = new AbortController()
  const promise = startBridge(ctx, controller)

  store[HUB_KEY] = {
    controller,
    promise,
    refCount: 1,
    stop: () => {
      controller.abort()
      stopPowerGuard()
      delete store[HUB_KEY]
    },
  }

  return promise
}

function release(): void {
  const store = hubStore()
  const hub = store[HUB_KEY]
  if (!hub) return
  hub.refCount = Math.max(0, (hub.refCount || 1) - 1)
  if (hub.refCount === 0) {
    if (hub.cleanupTimer) clearTimeout(hub.cleanupTimer)
    // 2-second debounce: allows multi-workspace switching or hot reload to acquire
    // without killing the bridge. If no workspace remains after 2s, stop cleanly.
    hub.cleanupTimer = setTimeout(() => {
      if (hub.refCount === 0) {
        log("all workspaces closed; stopping background bridge instance.")
        hub.stop()
      }
    }, 2000)
    if (typeof (hub.cleanupTimer as any)?.unref === "function") {
      ;(hub.cleanupTimer as any).unref()
    }
  }
}

export default Plugin.define({
  id: "telegram.bridge",
  async setup(ctx) {
    await acquire(ctx)
    return () => release()
  },
})
