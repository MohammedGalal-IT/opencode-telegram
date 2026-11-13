import {
  Bridge,
  SessionRef,
  buildProjects,
  chatState,
  createSession,
  defaultDirectory,
  describeSession,
  embyStatus,
  ensureSession,
  findLatestSessionInDir,
  gitStatus,
  isDirectory,
  lastAssistantText,
  listRootSessions,
  persist,
  projectLabel,
  resolveProjectArg,
  resolveSessionArg,
  sessionDir,
  sessionInfo,
  toSessionRef,
} from "./bridge"
import { startRun } from "./events"
import {
  getBatteryInfo,
  hibernateSystem,
  powerGuard,
  renderPowerCard,
  renderPowerKeyboard,
  startPowerGuard,
  stopPowerGuard,
} from "./power"
import { answerCallback, deleteMessage, editHtml, sendChatAction, sendHtml, sendMarkdown } from "./telegram"
import {
  ago,
  errorMessage,
  escapeHtml,
  formatBytes,
  formatDuration,
  logError,
  mdToHtml,
  shortId,
  shortPath,
  truncate,
} from "./util"

const authNotices = new Map<string, number>()

const STOP_TEXT = "⏹ إيقاف"

export function isAllowed(bridge: Bridge, chatId: string): boolean {
  return bridge.config.allowedChatIds.includes(String(chatId))
}

export function mainControlInlineKeyboard(): any {
  return {
    inline_keyboard: [
      [
        { text: "💬 الجلسة الحالية", callback_data: "nav:current" },
        { text: "🔄 مزامنة الجلسة", callback_data: "sync:latest" },
      ],
      [
        { text: "📁 المشاريع", callback_data: "nav:projects" },
        { text: "📑 قائمة الجلسات", callback_data: "nav:sessions" },
      ],
      [
        { text: "⚡ التحكم بالطاقة", callback_data: "power:refresh" },
        { text: "➕ جلسة جديدة", callback_data: "sess_new" },
      ],
    ],
  }
}

export function removeReplyKeyboard(): any {
  return { remove_keyboard: true }
}

export function stopKeyboard(sessionID: string) {
  return { inline_keyboard: [[{ text: "⏹ إيقاف التنفيذ الحالي", callback_data: `stop:${sessionID}` }]] }
}

export function sessionControlKeyboard(ref: SessionRef, hasNewer = false): any {
  const rows: any[][] = []

  // Only show stop button if session is actively executing
  if (ref.busy) {
    rows.push([{ text: "⏹ إيقاف التنفيذ الحالي", callback_data: `stop:${ref.id}` }])
  }

  if (hasNewer) {
    rows.push([{ text: "🔄 مزامنة مع أحدث جلسة", callback_data: "sync:latest" }])
  }

  rows.push([
    { text: "📊 حالة الجلسة وآخر رد", callback_data: `sess_status:${ref.id}` },
    { text: "➕ جلسة جديدة", callback_data: "sess_new" },
  ])

  rows.push([
    { text: "📑 قائمة الجلسات", callback_data: "nav:sessions" },
    { text: "📁 قائمة المشاريع", callback_data: "nav:projects" },
  ])

  return { inline_keyboard: rows }
}

export function statusKeyboard(ref: SessionRef): any {
  const rows: any[][] = []

  if (ref.busy) {
    rows.push([{ text: "⏹ إيقاف التنفيذ الحالي", callback_data: `stop:${ref.id}` }])
  }

  rows.push([
    { text: "🔄 تحديث الحالة", callback_data: `status_refresh:${ref.id}` },
    { text: "💬 الجلسة الحالية", callback_data: "nav:current" },
  ])

  return { inline_keyboard: rows }
}

async function reply(bridge: Bridge, chatId: string, html: string, extra: { reply_markup?: any } = {}) {
  return sendHtml(bridge.client, String(chatId), html, extra)
}

function welcomeText(bridge: Bridge, chatId: string): string {
  const chat = bridge.state.chats[chatId]
  const lines = [
    "🤖 <b>جسر OpenCode — تيليجرام</b>",
    "",
    "أهلاً بك! يمكنك من هنا متابعة مشاريعك والتحاور مع الوكيل مباشرة.",
    "",
    `🆔 معرّف المحادثة: <code>${escapeHtml(chatId)}</code>`,
  ]
  if (chat?.projectDir) lines.push(`📁 المشروع الحالي: <code>${escapeHtml(shortPath(chat.projectDir, 3))}</code>`)
  if (chat?.sessionID) lines.push(`💬 الجلسة الحالية: <code>${escapeHtml(shortId(chat.sessionID))}</code>`)
  lines.push(
    "",
    "استخدم الأزرار السريعة بالأسفل للتحكم الفوري، أو اكتب رسالتك مباشرة للبدء.",
  )
  return lines.join("\n")
}

const HELP_TEXT = [
  "📖 <b>الأوامر</b>",
  "",
  "<b>الجلسات</b>",
  "/sync — مزامنة التيليجرام فوراً مع أحدث جلسة نشطة في OpenCode",
  "/new [عنوان] — جلسة جديدة في المشروع الحالي",
  "/current — الجلسة الحالية وتفاصيلها",
  "/status — حالة الجلسة وآخر رد",
  "/sessions — أحدث الجلسات في كل المشاريع",
  "/use &lt;sN | ses_… | اسم المشروع | مسار&gt; — تبديل الجلسة",
  "/rename &lt;عنوان&gt; — إعادة تسمية الجلسة الحالية",
  "",
  "<b>المشاريع</b>",
  "/projects — كل المشاريع مع أزرار اختيار",
  "/git — حالة Git للمشروع الحالي",
  "/emby — حالة تنزيلات emby-dl",
  "",
  "<b>المتابعة والتحكم</b>",
  "/power — حالة البطارية وأزرار التحكم في الطاقة والإسبات",
  "/follow [all] — متابعة الجلسة الحالية أو كل الجلسات",
  "/unfollow [all] — إلغاء المتابعة",
  "/notify — كتم/تشغيل إشعارات هذه المحادثة",
  "/stop — إيقاف تنفيذ الجلسة الحالية",
  "/id — معرّفات المحادثة والجلسة",
  "",
  "اكتب أي نص عادي وسيُرسل إلى الجلسة الحالية.",
].join("\n")

async function selectProject(bridge: Bridge, chatId: string, directory: string): Promise<SessionRef | undefined> {
  const chat = chatState(bridge, chatId)
  chat.projectDir = directory
  const latest = await findLatestSessionInDir(bridge, directory)
  if (latest) {
    chat.sessionID = latest.id
    await persist(bridge)
    return latest
  }
  const created = await createSession(bridge, chatId, directory, `تيليجرام — ${shortPath(directory, 1)}`)
  await persist(bridge)
  return created
}

async function selectSession(bridge: Bridge, chatId: string, sessionID: string): Promise<SessionRef | undefined> {
  const info = await sessionInfo(bridge, sessionID, { refresh: true })
  if (!info) return undefined
  const chat = chatState(bridge, chatId)
  chat.sessionID = info.id
  if (info.dir) chat.projectDir = info.dir
  await persist(bridge)
  return info
}

function sessionLines(bridge: Bridge, chatId: string, refs: SessionRef[], start = 1): string[] {
  const chat = bridge.state.chats[chatId]
  return refs.map((ref, index) => {
    const isCurrent = chat?.sessionID === ref.id
    const mark = isCurrent ? " ⭐ (النشطة حالياً)" : ""
    const flags = [ref.busy ? "⚙️ مشغولة" : "💤 خاملة"]
    return `${index + start}. <b>${escapeHtml(truncate(ref.title, 60))}</b>${mark}\n   ${escapeHtml(
      projectLabel(ref.dir),
    )} — ${flags.join(" — ")} — ${ago(ref.updated)}`
  })
}

function sessionButtons(refs: SessionRef[]): any {
  const rows: any[][] = []
  refs.forEach((ref, index) => {
    rows.push([{ text: `💬 ${index + 1}. ${truncate(ref.title, 35)}`, callback_data: `sess:${ref.id}` }])
  })
  rows.push([
    { text: "➕ جلسة جديدة", callback_data: "sess_new" },
    { text: "🔄 تحديث", callback_data: "sess_refresh" },
  ])
  return { inline_keyboard: rows }
}

function projectButtons(dirs: string[]): any {
  const rows: any[][] = []
  dirs.forEach((dir, index) => {
    rows.push([{ text: `📁 ${index + 1}. ${truncate(shortPath(dir, 2), 35)}`, callback_data: `proj:${index}` }])
  })
  rows.push([{ text: "🔄 تحديث القائمة", callback_data: "proj_refresh" }])
  return { inline_keyboard: rows }
}

export async function sendUnauthorized(bridge: Bridge, chatId: string): Promise<void> {
  const last = authNotices.get(chatId) || 0
  if (Date.now() - last < 20000) return
  authNotices.set(chatId, Date.now())
  const lines = [
    "🔒 <b>هذه المحادثة غير مصرّح لها بعد.</b>",
    "",
    `🆔 معرّف المحادثة: <code>${escapeHtml(chatId)}</code>`,
    "",
    "أضف هذا المعرّف إلى <code>allowedChatIds</code> في الملف:",
    "<code>~/.config/opencode/opencode-telegram.json</code>",
    "",
    "مثال:",
    '<pre>"allowedChatIds": ["' + escapeHtml(chatId) + '"]</pre>',
    "ثم أرسل /start مرة أخرى.",
  ]
  try {
    await sendHtml(bridge.client, chatId, lines.join("\n"))
  } catch (error) {
    logError("cannot send unauthorized notice:", errorMessage(error))
  }
}

export async function handleText(bridge: Bridge, chatId: string, text: string): Promise<void> {
  const body = String(text || "").trim()
  if (!body) return

  // Handle quick menu keyboard buttons
  if (/^(💬|الجلسة الحالية)/i.test(body)) {
    await commandCurrent(bridge, chatId)
    return
  }
  if (/^(🔄|مزامنة)/i.test(body)) {
    await commandSync(bridge, chatId)
    return
  }
  if (/^(📁|المشاريع)/i.test(body)) {
    await commandProjects(bridge, chatId)
    return
  }
  if (/^(📑|الجلسات)/i.test(body)) {
    await commandSessions(bridge, chatId)
    return
  }
  if (/^(⚡|الطاقة|التحكم بالطاقة)/i.test(body)) {
    await commandPower(bridge, chatId, "")
    return
  }
  if (/^(➕|جلسة جديدة)/i.test(body)) {
    await commandNew(bridge, chatId, "")
    return
  }
  if (/^(❓|مساعدة|المساعدة)/i.test(body)) {
    await reply(bridge, chatId, HELP_TEXT, { reply_markup: mainControlInlineKeyboard() })
    return
  }

  const ref = await ensureSession(bridge, chatId)
  if (!ref) {
    await reply(bridge, chatId, "❌ تعذّر إنشاء جلسة. تحقّق من مجلد المشروع في الإعدادات.")
    return
  }
  await promptSession(bridge, chatId, ref.id, body)
}

async function promptSession(bridge: Bridge, chatId: string, sessionID: string, text: string): Promise<void> {
  const run = startRun(bridge, sessionID, chatId)
  const short = shortId(sessionID)
  await sendChatAction(bridge.client, chatId, "typing")
  try {
    const ack = await sendHtml(
      bridge.client,
      chatId,
      `📨 <b>أُرسلت إلى الجلسة</b> <code>${escapeHtml(short)}</code>\n<i>سيظهر الرد هنا عند اكتماله.</i>`,
      { reply_markup: stopKeyboard(sessionID) },
    )
    if (ack?.message_id) {
      run.ackChat = chatId
      run.ackMessageId = ack.message_id
    }
  } catch (error) {
    logError("cannot send acknowledgement:", errorMessage(error))
  }

  try {
    await bridge.ctx.session.prompt({ sessionID, text, delivery: "steer", metadata: { source: "telegram" } })
  } catch (error) {
    try {
      await bridge.ctx.session.prompt({ sessionID, text, delivery: "queue", metadata: { source: "telegram" } })
    } catch (retryError) {
      run.finalized = true
      bridge.runs.delete(sessionID)
      if (run.ackChat && run.ackMessageId) await deleteMessage(bridge.client, run.ackChat, run.ackMessageId)
      await reply(bridge, chatId, `❌ فشل إرسال الرسالة:\n<code>${escapeHtml(errorMessage(retryError))}</code>`)
    }
  }
}

export async function handleCommand(bridge: Bridge, chatId: string, name: string, args: string): Promise<void> {
  switch (name) {
    case "start":
      await reply(bridge, chatId, welcomeText(bridge, chatId), { reply_markup: mainControlInlineKeyboard() })
      await reply(bridge, chatId, "✨ <i>تم تفعيل لوحة التحكم المضمنة وإزالة أشرطة القائمة السفلية.</i>", {
        reply_markup: removeReplyKeyboard(),
      })
      return
    case "menu":
      await reply(bridge, chatId, "📋 <b>لوحة التحكم السريعة</b>\nاضغط على أي خيار أدناه:", {
        reply_markup: mainControlInlineKeyboard(),
      })
      return
    case "help":
      await reply(bridge, chatId, HELP_TEXT, { reply_markup: mainControlInlineKeyboard() })
      return
    case "new":
      await commandNew(bridge, chatId, args)
      return
    case "projects":
      await commandProjects(bridge, chatId)
      return
    case "sessions":
      await commandSessions(bridge, chatId)
      return
    case "use":
      await commandUse(bridge, chatId, args)
      return
    case "current":
      await commandCurrent(bridge, chatId)
      return
    case "sync":
      await commandSync(bridge, chatId)
      return
    case "status":
      await commandStatus(bridge, chatId)
      return
    case "git":
      await commandGit(bridge, chatId)
      return
    case "emby":
      await commandEmby(bridge, chatId)
      return
    case "stop":
      await commandStop(bridge, chatId)
      return
    case "follow":
      await commandFollow(bridge, chatId, args, true)
      return
    case "unfollow":
      await commandFollow(bridge, chatId, args, false)
      return
    case "notify":
      await commandNotify(bridge, chatId)
      return
    case "rename":
      await commandRename(bridge, chatId, args)
      return
    case "id":
      await commandId(bridge, chatId)
      return
    case "power":
    case "battery":
      await commandPower(bridge, chatId, args)
      return
    default:
      await reply(bridge, chatId, `❓ أمر غير معروف: <code>/${escapeHtml(name)}</code>\n\n${HELP_TEXT}`)
  }
}

async function commandNew(bridge: Bridge, chatId: string, args: string): Promise<void> {
  const directory = defaultDirectory(bridge, chatId)
  if (!isDirectory(directory)) {
    await reply(bridge, chatId, `❌ المجلد غير موجود:\n<code>${escapeHtml(directory)}</code>`)
    return
  }
  const ref = await createSession(bridge, chatId, directory, args || undefined)
  if (!ref) {
    await reply(bridge, chatId, "❌ تعذّر إنشاء الجلسة.")
    return
  }
  await reply(
    bridge,
    chatId,
    [
      "✅ <b>جلسة جديدة</b>",
      `📁 ${escapeHtml(projectLabel(ref.dir))}`,
      `💬 ${escapeHtml(ref.title)}`,
      `<code>${escapeHtml(ref.id)}</code>`,
      "",
      "أرسل رسالتك الآن.",
    ].join("\n"),
    { reply_markup: sessionControlKeyboard(ref) },
  )
}

async function commandProjects(bridge: Bridge, chatId: string): Promise<void> {
  const sessions = await listRootSessions(bridge)
  const projects = buildProjects(sessions)
  if (projects.length === 0) {
    await reply(bridge, chatId, "📁 لا توجد مشاريع بعد. استخدم /new لإنشاء جلسة في المشروع الافتراضي.")
    return
  }
  const listed = projects.slice(0, 20)
  const chat = chatState(bridge, chatId)
  chat.projectList = listed.map((project) => project.dir)
  await persist(bridge)
  const lines = ["📁 <b>المشاريع</b>", ""]
  listed.forEach((project, index) => {
    lines.push(
      `${index + 1}. <b>${escapeHtml(projectLabel(project.dir))}</b> — ${project.count} جلسة — ${ago(project.updated)}`,
    )
  })
  lines.push("", "اختر مشروعاً بزر، أو استخدم <code>/use اسم المشروع</code>.")
  await reply(bridge, chatId, lines.join("\n"), { reply_markup: projectButtons(listed.map((p) => p.dir)) })
}

async function commandSessions(bridge: Bridge, chatId: string): Promise<void> {
  const sessions = await listRootSessions(bridge, 60)
  if (sessions.length === 0) {
    await reply(bridge, chatId, "💬 لا توجد جلسات بعد.")
    return
  }
  const refs = sessions.slice(0, 20).map(toSessionRef)
  const chat = chatState(bridge, chatId)
  chat.sessionList = refs.map((ref) => ref.id)
  await persist(bridge)
  const lines = ["📑 <b>أحدث الجلسات</b>", "", ...sessionLines(bridge, chatId, refs)]
  lines.push("", "اختر جلسة بزر، أو استخدم <code>/use s1</code>.")
  await reply(bridge, chatId, lines.join("\n"), { reply_markup: sessionButtons(refs) })
}

async function commandUse(bridge: Bridge, chatId: string, args: string): Promise<void> {
  const value = String(args || "").trim()
  if (!value) {
    await reply(bridge, chatId, "استخدم: <code>/use s1</code> أو <code>/use ses_…</code> أو <code>/use اسم المشروع</code>")
    return
  }
  const sessionID = resolveSessionArg(bridge, chatId, value)
  if (sessionID) {
    const info = await selectSession(bridge, chatId, sessionID)
    if (!info) {
      await reply(bridge, chatId, "❌ لم أجد هذه الجلسة.")
      return
    }
    await reply(bridge, chatId, `✅ الجلسة الحالية:\n${escapeHtml(describeSession(info))}`)
    return
  }
  const sessions = await listRootSessions(bridge)
  const directory = isDirectory(value) ? value : resolveProjectArg(bridge, chatId, value, sessions)
  if (!directory) {
    await reply(bridge, chatId, "❌ لم أجد جلسة أو مشروعاً بهذا الاسم. جرّب /projects أو /sessions.")
    return
  }
  const ref = await selectProject(bridge, chatId, directory)
  if (!ref) {
    await reply(bridge, chatId, `❌ تعذّر فتح المشروع:\n<code>${escapeHtml(directory)}</code>`)
    return
  }
  await reply(
    bridge,
    chatId,
    `✅ المشروع الحالي: <b>${escapeHtml(projectLabel(directory))}</b>\n${escapeHtml(describeSession(ref))}`,
    { reply_markup: sessionControlKeyboard(ref) },
  )
}

async function currentRef(bridge: Bridge, chatId: string): Promise<SessionRef | undefined> {
  const chat = bridge.state.chats[chatId]
  if (chat?.sessionID) {
    const info = await sessionInfo(bridge, chat.sessionID, { refresh: true })
    if (info) return info
  }
  return ensureSession(bridge, chatId)
}

async function commandCurrent(bridge: Bridge, chatId: string): Promise<void> {
  const ref = await currentRef(bridge, chatId)
  if (!ref) {
    await reply(bridge, chatId, "💬 لا توجد جلسة حالية. استخدم /new أو /sync.")
    return
  }

  const sessions = await listRootSessions(bridge)
  sessions.sort((a, b) => (Number(b?.time?.updated) || 0) - (Number(a?.time?.updated) || 0))
  const latest = sessions[0]
  const hasNewer = latest && latest.id !== ref.id

  const lines = [
    "💬 <b>الجلسة الحالية</b>",
    `العنوان: <b>${escapeHtml(ref.title)}</b>`,
    `المعرّف: <code>${escapeHtml(ref.id)}</code>`,
    `المشروع: <code>${escapeHtml(ref.dir || "—")}</code>`,
    `الحالة: ${ref.busy ? "⚙️ مشغولة" : "💤 خاملة"}`,
    `الوكيل: ${escapeHtml(ref.agent || "—")}`,
    `النموذج: ${escapeHtml(ref.model || "—")}`,
    `التكلفة: $${(ref.cost || 0).toFixed(4)}`,
    `آخر نشاط: ${ago(ref.updated)}`,
  ]

  if (hasNewer) {
    lines.push(
      "",
      `💡 <i>توجد جلسة أحدث نشطة: <b>${escapeHtml(latest.title || shortId(latest.id))}</b></i>`,
      "استخدم /sync للتبديل إليها مباشرة.",
    )
  }

  await reply(bridge, chatId, lines.join("\n"), {
    reply_markup: sessionControlKeyboard(ref, hasNewer),
  })
}

async function commandSync(bridge: Bridge, chatId: string): Promise<void> {
  const sessions = await listRootSessions(bridge)
  if (sessions.length === 0) {
    await reply(bridge, chatId, "💬 لا توجد جلسات حالية في OpenCode.")
    return
  }
  sessions.sort((a, b) => (Number(b?.time?.updated) || 0) - (Number(a?.time?.updated) || 0))
  const latest = sessions[0]
  const chat = chatState(bridge, chatId)
  const prevId = chat.sessionID

  chat.sessionID = latest.id
  const dir = sessionDir(latest)
  if (dir) chat.projectDir = dir
  await persist(bridge)

  const ref = toSessionRef(latest)
  const isSame = prevId === latest.id

  const lines = [
    isSame ? "✅ <b>محادثتك متزامنة بالفعل مع أحدث جلسة نشطة</b>:" : "🔄 <b>تمت المزامنة والتبديل إلى الجلسة النشطة</b>:",
    "",
    `💬 <b>${escapeHtml(ref.title)}</b>`,
    `المعرّف: <code>${escapeHtml(shortId(ref.id))}</code>`,
    `المشروع: 📁 <code>${escapeHtml(projectLabel(ref.dir))}</code>`,
    `الحالة: ${ref.busy ? "⚙️ الوكيل يعمل الآن" : "💤 خاملة"} (${ago(ref.updated)})`,
    "",
    "يمكنك الآن إرسال رسالتك مباشرة وستصل إلى هذه الجلسة.",
  ]
  await reply(bridge, chatId, lines.join("\n"), { reply_markup: sessionControlKeyboard(ref) })
}

async function commandStatus(bridge: Bridge, chatId: string): Promise<void> {
  const ref = await currentRef(bridge, chatId)
  if (!ref) {
    await reply(bridge, chatId, "💬 لا توجد جلسة حالية. استخدم /new.")
    return
  }
  const text = await lastAssistantText(bridge, ref.id)
  const chat = bridge.state.chats[chatId]
  const lines = [
    "📊 <b>حالة الجلسة</b>",
    `الجلسة: ${escapeHtml(ref.title)}`,
    `الحالة: ${ref.busy ? "⚙️ قيد التنفيذ" : "💤 خاملة"}`,
    `آخر نشاط: ${ago(ref.updated)}`,
    `متابعة هذه الجلسة: ${bridge.state.followed.includes(ref.id) ? "نعم" : "لا"}`,
    `متابعة الكل: ${chat?.all ? "نعم" : "لا"}`,
    `إشعارات المحادثة: ${chat?.muted ? "مكتومة" : "مفعّلة"}`,
    "",
    "📝 <b>آخر رد</b>",
    text ? mdToHtml(truncate(text, 2500), bridge.config.tableMode) : "<i>لا يوجد رد بعد.</i>",
  ]
  await reply(bridge, chatId, lines.join("\n"), { reply_markup: statusKeyboard(ref) })
}

async function commandGit(bridge: Bridge, chatId: string): Promise<void> {
  const ref = await currentRef(bridge, chatId)
  const directory = ref?.dir || defaultDirectory(bridge, chatId)
  if (!directory) {
    await reply(bridge, chatId, "📁 لا أعرف مجلد المشروع الحالي.")
    return
  }
  const result = await gitStatus(directory)
  if (!result.status) {
    await reply(bridge, chatId, `📁 <b>${escapeHtml(projectLabel(directory))}</b>\n\nليس مستودع Git أو git غير متاح.`)
    return
  }
  const lines = [
    `🌿 <b>${escapeHtml(projectLabel(directory))}</b>`,
    "",
    "<pre>" + escapeHtml(truncate(result.status, 3000)) + "</pre>",
  ]
  if (result.log) lines.push("", `آخر التزام: <code>${escapeHtml(result.log)}</code>`)
  await reply(bridge, chatId, lines.join("\n"))
}

async function commandEmby(bridge: Bridge, chatId: string): Promise<void> {
  const ref = await currentRef(bridge, chatId)
  const directory = ref?.dir || defaultDirectory(bridge, chatId)
  const result = await embyStatus(bridge, directory)
  if (!result.found) {
    await reply(bridge, chatId, `📥 لم أجد <code>emby_dl.py</code> في:\n<code>${escapeHtml(directory)}</code>`)
    return
  }
  if (result.error) {
    await reply(bridge, chatId, `❌ فشل تشغيل emby_dl:\n<code>${escapeHtml(truncate(result.error, 800))}</code>`)
    return
  }
  const data = result.data || {}
  const state = data.state || {}
  const percent = Number(state.percent)
  const lines = [
    "📥 <b>حالة emby-dl</b>",
    `التشغيل: ${data.running ? "✅ يعمل" : "⏹ متوقف"}`,
    `القفل: ${data.lock_held ? "مقفل" : "غير مقفل"}`,
  ]
  if (state.label) lines.push(`الحالة: ${escapeHtml(String(state.label))}`)
  if (Number.isFinite(percent)) lines.push(`التقدم: ${percent.toFixed(2)}%`)
  if (state.downloaded != null && state.total != null) {
    lines.push(`البيانات: ${formatBytes(Number(state.downloaded))} / ${formatBytes(Number(state.total))}`)
  }
  if (state.speed_bps != null) lines.push(`السرعة: ${formatBytes(Number(state.speed_bps))}/ث`)
  if (state.eta_seconds != null) lines.push(`المتبقي: ${formatDuration(Number(state.eta_seconds))}`)
  if (state.updated_at) lines.push(`آخر تحديث: ${ago(Date.parse(String(state.updated_at)))}`)
  await reply(bridge, chatId, lines.join("\n"))
}

async function commandStop(bridge: Bridge, chatId: string): Promise<void> {
  const ref = await currentRef(bridge, chatId)
  if (!ref) {
    await reply(bridge, chatId, "💬 لا توجد جلسة حالية.")
    return
  }
  try {
    const result = await bridge.ctx.session.interrupt({ sessionID: ref.id, resume: false })
    await reply(
      bridge,
      chatId,
      result?.interrupted ? `⏹ تم إيقاف الجلسة <code>${escapeHtml(shortId(ref.id))}</code>.` : "الجلسة غير قيد التنفيذ.",
    )
  } catch (error) {
    await reply(bridge, chatId, `❌ فشل الإيقاف:\n<code>${escapeHtml(errorMessage(error))}</code>`)
  }
}

async function commandFollow(bridge: Bridge, chatId: string, args: string, follow: boolean): Promise<void> {
  const value = String(args || "").trim().toLowerCase()
  if (value === "all" || value === "الكل") {
    const chat = chatState(bridge, chatId)
    chat.all = follow
    await persist(bridge)
    await reply(bridge, chatId, follow ? "🔔 متابعة كل الجلسات مفعّلة لهذه المحادثة." : "🔕 متابعة كل الجلسات متوقفة.")
    return
  }

  let sessionID = value ? resolveSessionArg(bridge, chatId, value) : undefined
  if (!sessionID) {
    const ref = value ? undefined : await currentRef(bridge, chatId)
    sessionID = ref?.id
  }
  if (!sessionID && value) {
    const sessions = await listRootSessions(bridge)
    const info = sessions.find((session) => String(session?.id || "").startsWith(value))
    sessionID = info?.id
  }
  if (!sessionID) {
    await reply(bridge, chatId, "استخدم: <code>/follow</code> أو <code>/follow all</code> أو <code>/follow s1</code>")
    return
  }

  const list = new Set(bridge.state.followed)
  if (follow) list.add(sessionID)
  else list.delete(sessionID)
  bridge.state.followed = [...list]
  await persist(bridge)
  await reply(
    bridge,
    chatId,
    `${follow ? "🔔 متابعة" : "🔕 إلغاء متابعة"} الجلسة <code>${escapeHtml(shortId(sessionID))}</code>.`,
  )
}

async function commandNotify(bridge: Bridge, chatId: string): Promise<void> {
  const chat = chatState(bridge, chatId)
  chat.muted = !chat.muted
  await persist(bridge)
  await reply(
    bridge,
    chatId,
    chat.muted
      ? "🔕 تم كتم إشعارات الجلسات الأخرى. تبقى ردود الجلسة الحالية وطلبات الإذن مفعّلة."
      : "🔔 تم تشغيل الإشعارات لهذه المحادثة.",
  )
}

async function commandRename(bridge: Bridge, chatId: string, args: string): Promise<void> {
  const title = String(args || "").trim()
  if (!title) {
    await reply(bridge, chatId, "استخدم: <code>/rename عنوان جديد</code>")
    return
  }
  const ref = await currentRef(bridge, chatId)
  if (!ref) {
    await reply(bridge, chatId, "💬 لا توجد جلسة حالية.")
    return
  }
  try {
    await bridge.ctx.session.update({ sessionID: ref.id, title })
    bridge.sessionCache.delete(ref.id)
    await reply(bridge, chatId, `✅ أُعيدت التسمية إلى: <b>${escapeHtml(title)}</b>`)
  } catch (error) {
    await reply(bridge, chatId, `❌ فشل التعديل:\n<code>${escapeHtml(errorMessage(error))}</code>`)
  }
}

async function commandId(bridge: Bridge, chatId: string): Promise<void> {
  const chat = bridge.state.chats[chatId]
  const lines = [
    "🆔 <b>المعرّفات</b>",
    `المحادثة: <code>${escapeHtml(chatId)}</code>`,
    `الجلسة: <code>${escapeHtml(chat?.sessionID || "—")}</code>`,
    `المشروع: <code>${escapeHtml(chat?.projectDir || defaultDirectory(bridge, chatId) || "—")}</code>`,
    `البوت: ${bridge.me?.username ? "@" + escapeHtml(bridge.me.username) : "—"}`,
    `المصرّح لهم: ${bridge.config.allowedChatIds.length}`,
  ]
  await reply(bridge, chatId, lines.join("\n"))
}

async function commandPower(bridge: Bridge, chatId: string, args: string): Promise<void> {
  const sub = String(args || "").trim().toLowerCase()
  if (sub === "on" || sub === "auto on" || sub === "12" || sub === "auto") {
    startPowerGuard(bridge, chatId, 12)
    const info = await getBatteryInfo()
    await reply(
      bridge,
      chatId,
      `🟢 <b>تم تفعيل حماية البطارية والإسبات التلقائي عند 12%</b> لهذا التشغيل فقط.\n\n` +
        renderPowerCard(info, powerGuard),
      { reply_markup: renderPowerKeyboard(powerGuard) },
    )
    return
  }

  if (sub === "off" || sub === "auto off" || sub === "stop") {
    stopPowerGuard()
    const info = await getBatteryInfo()
    await reply(
      bridge,
      chatId,
      `⚪ <b>تم إيقاف الحماية التلقائية</b>.\n\n` + renderPowerCard(info, powerGuard),
      { reply_markup: renderPowerKeyboard(powerGuard) },
    )
    return
  }

  if (sub === "hibernate" || sub === "hib") {
    await reply(bridge, chatId, "💤 <b>جاري إدخال الجهاز في وضع الإسبات (Hibernate) الآن...</b>")
    await sleep(2000)
    const res = await hibernateSystem()
    if (!res.success) {
      await reply(bridge, chatId, `❌ <b>تعذّر إسبات الجهاز</b>:\n<code>${escapeHtml(res.error || "خطأ غير معروف")}</code>`)
    }
    return
  }

  const info = await getBatteryInfo()
  await reply(bridge, chatId, renderPowerCard(info, powerGuard), {
    reply_markup: renderPowerKeyboard(powerGuard),
  })
}

export async function handleCallback(bridge: Bridge, chatId: string, query: any): Promise<void> {
  const data = String(query?.data || "")
  const queryId = String(query?.id || "")
  const [kind, first, second] = data.split(":")

  if (kind === "power") {
    const action = first
    const msgId = query?.message?.message_id

    if (action === "refresh") {
      const info = await getBatteryInfo()
      if (msgId) {
        await editHtml(bridge.client, chatId, msgId, renderPowerCard(info, powerGuard), {
          reply_markup: renderPowerKeyboard(powerGuard),
        })
      }
      await answerCallback(bridge.client, queryId, "تم تحديث حالة الطاقة ⚡")
      return
    }

    if (action === "enable") {
      startPowerGuard(bridge, chatId, 12)
      const info = await getBatteryInfo()
      if (msgId) {
        await editHtml(
          bridge.client,
          chatId,
          msgId,
          `🟢 <b>تم تفعيل الحماية التلقائية عند 12%</b> (لهذه الجلسة فقط).\n\n` +
            renderPowerCard(info, powerGuard),
          { reply_markup: renderPowerKeyboard(powerGuard) },
        )
      }
      await answerCallback(bridge.client, queryId, "تم تفعيل الإسبات التلقائي عند 12%")
      return
    }

    if (action === "disable") {
      stopPowerGuard()
      const info = await getBatteryInfo()
      if (msgId) {
        await editHtml(
          bridge.client,
          chatId,
          msgId,
          `⚪ <b>تم إيقاف الحماية التلقائية</b>.\n\n` + renderPowerCard(info, powerGuard),
          { reply_markup: renderPowerKeyboard(powerGuard) },
        )
      }
      await answerCallback(bridge.client, queryId, "تم إيقاف الحماية")
      return
    }

    if (action === "hib_ask") {
      const info = await getBatteryInfo()
      if (msgId) {
        await editHtml(
          bridge.client,
          chatId,
          msgId,
          renderPowerCard(info, powerGuard) + "\n\n⚠️ <b>هل أنت متأكد من إدخال الجهاز في وضع الإسبات الآن؟</b>",
          { reply_markup: renderPowerKeyboard(powerGuard, true) },
        )
      }
      await answerCallback(bridge.client, queryId)
      return
    }

    if (action === "hib_confirm") {
      await answerCallback(bridge.client, queryId, "جاري إدخال الجهاز في وضع الإسبات…")
      if (msgId) {
        await editHtml(
          bridge.client,
          chatId,
          msgId,
          "💤 <b>جاري إدخال الجهاز في وضع الإسبات (Hibernate) الآن...</b>\nسيتم حفظ حالة النظام واسترجاعها بدقة عند تشغيل الجهاز مجدداً.",
          { reply_markup: { inline_keyboard: [] } },
        )
      }
      await sleep(2500)
      const res = await hibernateSystem()
      if (!res.success) {
        await reply(bridge, chatId, `❌ <b>تعذّر إسبات الجهاز</b>:\n<code>${escapeHtml(res.error || "خطأ غير معروف")}</code>`)
      }
      return
    }
    return
  }

  if (kind === "sess_status") {
    await answerCallback(bridge.client, queryId)
    await commandStatus(bridge, chatId)
    return
  }

  if (kind === "sess_new") {
    await answerCallback(bridge.client, queryId, "إنشاء جلسة جديدة…")
    await commandNew(bridge, chatId, "")
    return
  }

  if (kind === "nav") {
    await answerCallback(bridge.client, queryId)
    if (first === "sessions") await commandSessions(bridge, chatId)
    else if (first === "projects") await commandProjects(bridge, chatId)
    else if (first === "current") await commandCurrent(bridge, chatId)
    return
  }

  if (kind === "status_refresh") {
    await answerCallback(bridge.client, queryId, "تم تحديث الحالة 🔄")
    await commandStatus(bridge, chatId)
    return
  }

  if (kind === "proj_refresh") {
    await answerCallback(bridge.client, queryId, "تم تحديث قائمة المشاريع 🔄")
    await commandProjects(bridge, chatId)
    return
  }

  if (kind === "sess_refresh") {
    await answerCallback(bridge.client, queryId, "تم تحديث قائمة الجلسات 🔄")
    await commandSessions(bridge, chatId)
    return
  }

  if (kind === "sync") {
    await commandSync(bridge, chatId)
    await answerCallback(bridge.client, queryId, "تمت المزامنة بنجاح 🔄")
    return
  }

  if (kind === "stop") {
    const sessionID = first
    if (!sessionID) {
      await answerCallback(bridge.client, queryId, "طلب غير صالح", true)
      return
    }
    try {
      const result = await bridge.ctx.session.interrupt({ sessionID, resume: false })
      await answerCallback(
        bridge.client,
        queryId,
        result?.interrupted ? "تم إيقاف التنفيذ" : "الجلسة غير قيد التنفيذ",
        true,
      )
    } catch (error) {
      await answerCallback(bridge.client, queryId, errorMessage(error).slice(0, 180), true)
    }
    return
  }

  if (kind === "perm") {
    const token = first
    const decision = second
    const pending = bridge.pendingPermissions.get(token)
    if (!pending) {
      await answerCallback(bridge.client, queryId, "انتهت صلاحية الطلب أو تم الرد عليه.", true)
      return
    }
    if (decision !== "once" && decision !== "always" && decision !== "reject") {
      await answerCallback(bridge.client, queryId, "قرار غير معروف", true)
      return
    }
    try {
      await bridge.ctx.permission.reply({
        sessionID: pending.sessionID,
        requestID: pending.requestID,
        decision,
      })
      bridge.pendingPermissions.delete(token)
      const label =
        decision === "once" ? "✅ سُمح مرة واحدة" : decision === "always" ? "✅ سُمح دائماً" : "⛔ تم الرفض"
      for (const [messageChat, messageId] of Object.entries(pending.messages)) {
        await editHtml(bridge.client, messageChat, messageId, `<b>${label}</b>`, { reply_markup: { inline_keyboard: [] } })
      }
      await answerCallback(bridge.client, queryId, label.replace(/^[^\s]+\s/, ""))
    } catch (error) {
      await answerCallback(bridge.client, queryId, errorMessage(error).slice(0, 180), true)
    }
    return
  }

  if (kind === "proj") {
    const chat = bridge.state.chats[chatId]
    const directory = chat?.projectList?.[Number(first)]
    if (!directory) {
      await answerCallback(bridge.client, queryId, "انتهت القائمة. أرسل /projects من جديد.", true)
      return
    }
    await answerCallback(bridge.client, queryId, "جارٍ فتح المشروع…")
    const ref = await selectProject(bridge, chatId, directory)
    if (!ref) {
      await reply(bridge, chatId, `❌ تعذّر فتح المشروع:\n<code>${escapeHtml(directory)}</code>`)
      return
    }
    await reply(
      bridge,
      chatId,
      `✅ المشروع الحالي: <b>${escapeHtml(projectLabel(directory))}</b>\n${escapeHtml(describeSession(ref))}`,
      { reply_markup: sessionControlKeyboard(ref) },
    )
    if (query?.message?.message_id) {
      await editHtml(
        bridge.client,
        chatId,
        query.message.message_id,
        `✅ تم اختيار <b>${escapeHtml(projectLabel(directory))}</b>`,
        { reply_markup: { inline_keyboard: [] } },
      )
    }
    return
  }

  if (kind === "sess") {
    const chat = bridge.state.chats[chatId]
    const sessionID = chat?.sessionList?.[Number(first)]
    if (!sessionID) {
      await answerCallback(bridge.client, queryId, "انتهت القائمة. أرسل /sessions من جديد.", true)
      return
    }
    await answerCallback(bridge.client, queryId, "جارٍ التبديل…")
    const info = await selectSession(bridge, chatId, sessionID)
    if (!info) {
      await reply(bridge, chatId, "❌ لم أعد أجد هذه الجلسة.")
      return
    }
    await reply(bridge, chatId, `✅ الجلسة الحالية:\n${escapeHtml(describeSession(info))}`, {
      reply_markup: sessionControlKeyboard(info),
    })
    if (query?.message?.message_id) {
      await editHtml(bridge.client, chatId, query.message.message_id, `✅ تم اختيار <b>${escapeHtml(truncate(info.title, 60))}</b>`, {
        reply_markup: { inline_keyboard: [] },
      })
    }
    return
  }

  await answerCallback(bridge.client, queryId, "زر غير معروف", true)
}
