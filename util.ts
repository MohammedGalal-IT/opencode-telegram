// Small, dependency-free helpers shared by the Telegram bridge.
import { appendFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const LOG_PATH = join(homedir(), ".config", "opencode", "telegram-bridge.log")
const LOG_LIMIT = 1_500_000

function stringifyArg(value: any): string {
  if (typeof value === "string") return value
  if (value instanceof Error) return value.stack || value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function writeLog(level: string, args: any[]) {
  try {
    let size = 0
    try {
      size = statSync(LOG_PATH).size
    } catch {
      size = 0
    }
    if (size > LOG_LIMIT) writeFileSync(LOG_PATH, "", "utf8")
    const line = `${new Date().toISOString()} ${level} ${args.map(stringifyArg).join(" ")}\n`
    appendFileSync(LOG_PATH, line, "utf8")
  } catch {
    // Logging must never break the bridge.
  }
}

export function errorMessage(error: any): string {
  if (!error) return "unknown error"
  if (typeof error === "string") return error
  if (typeof error.message === "string" && error.message) return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export function log(...args: any[]) {
  console.log("[telegram-bridge]", ...args)
  writeLog("INFO", args)
}

export function logError(...args: any[]) {
  console.error("[telegram-bridge]", ...args)
  writeLog("ERROR", args)
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export function shortId(id: string, size = 10): string {
  const value = String(id || "")
  if (value.length <= size) return value
  return value.slice(0, size)
}

export function shortPath(path: string, parts = 2): string {
  const value = String(path || "")
  if (!value) return ""
  const split = value.split(/[\\/]+/).filter(Boolean)
  return split.slice(-parts).join("/")
}

export function normPath(path: string): string {
  return String(path || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase()
}

export function samePath(a: string, b: string): boolean {
  return normPath(a) === normPath(b)
}

export function truncate(text: string, limit: number): string {
  const value = String(text || "")
  if (value.length <= limit) return value
  return value.slice(0, Math.max(0, limit - 1)).trimEnd() + "…"
}

export function escapeHtml(text: string): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

export function stripHtml(text: string): string {
  return String(text ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

export function getOpenTags(html: string): string[] {
  const stack: string[] = []
  const tagRegex = /<(\/)?([a-zA-Z0-9_-]+)(?:\s+[^>]*)?(\/)?>/g
  let match: RegExpExecArray | null
  while ((match = tagRegex.exec(html)) !== null) {
    const isClosing = Boolean(match[1])
    const tagName = match[2].toLowerCase()
    const isSelfClosing = Boolean(match[3]) || tagName === "br" || tagName === "hr"
    if (isSelfClosing) continue
    if (!isClosing) {
      stack.push(tagName)
    } else {
      const idx = stack.lastIndexOf(tagName)
      if (idx !== -1) {
        stack.splice(idx, 1)
      }
    }
  }
  return stack
}

/**
 * Ensures all opened Telegram HTML tags are properly closed,
 * preventing "can't find end tag" errors during chunking and streaming drafts.
 */
export function balanceHtmlTags(html: string): string {
  const stack = getOpenTags(html)
  let out = html
  while (stack.length > 0) {
    const tag = stack.pop()
    out += `</${tag}>`
  }
  return out
}

export type TableMode = "smart" | "box" | "list"

function stripMarkdown(text: string): string {
  return String(text ?? "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .trim()
}

function parseMarkdownTable(raw: string): { headers: string[]; rows: string[][] } | null {
  const lines = raw
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length < 2) return null

  const parseRow = (line: string): string[] => {
    let clean = line
    if (clean.startsWith("|")) clean = clean.slice(1)
    if (clean.endsWith("|")) clean = clean.slice(0, -1)
    return clean.split("|").map((c) => c.trim())
  }

  const headers = parseRow(lines[0])
  const sep = parseRow(lines[1])
  if (headers.length === 0 || sep.length === 0) return null
  const isSep = sep.every((s) => /^:?-{2,}:?$/.test(s))
  if (!isSep) return null

  const rows = lines.slice(2).map(parseRow)
  return { headers, rows }
}

function renderTableBox(headers: string[], rows: string[][]): string {
  const cleanHeaders = headers.map(stripMarkdown)
  const cleanRows = rows.map((r) => r.map(stripMarkdown))
  const colCount = cleanHeaders.length
  const widths = cleanHeaders.map((h) => Math.max(3, h.length))

  for (const row of cleanRows) {
    for (let i = 0; i < colCount; i++) {
      const cell = row[i] || ""
      widths[i] = Math.max(widths[i], cell.length)
    }
  }

  const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - text.length))

  const top = "┌" + widths.map((w) => "─".repeat(w + 2)).join("┬") + "┐"
  const mid = "├" + widths.map((w) => "─".repeat(w + 2)).join("┼") + "┤"
  const bot = "└" + widths.map((w) => "─".repeat(w + 2)).join("┴") + "┘"

  const headerLine = "│ " + cleanHeaders.map((h, i) => pad(h, widths[i])).join(" │ ") + " │"
  const dataLines = cleanRows.map((r) => {
    return "│ " + Array.from({ length: colCount }, (_, i) => pad(r[i] || "", widths[i])).join(" │ ") + " │"
  })

  const full = [top, headerLine, mid, ...dataLines, bot].join("\n")
  return `<pre>${escapeHtml(full)}</pre>`
}

function renderTableList(headers: string[], rows: string[][]): string {
  const items: string[] = []
  if (headers.length === 2) {
    for (const row of rows) {
      const c0 = stripMarkdown(row[0] || "")
      const c1 = stripMarkdown(row[1] || "")
      items.push(`• <b>${escapeHtml(c0)}</b>: ${escapeHtml(c1)}`)
    }
  } else {
    rows.forEach((row, idx) => {
      const title = stripMarkdown(row[0] || `عنصر ${idx + 1}`)
      const lines = [`📌 <b>${escapeHtml(title)}</b>`]
      for (let i = 1; i < headers.length; i++) {
        const h = stripMarkdown(headers[i] || `حقل ${i}`)
        const v = stripMarkdown(row[i] || "—")
        lines.push(`  • ${escapeHtml(h)}: ${escapeHtml(v)}`)
      }
      items.push(lines.join("\n"))
    })
  }
  return items.join("\n\n")
}

function renderTable(raw: string, mode: TableMode = "smart"): string {
  const parsed = parseMarkdownTable(raw)
  if (!parsed) return raw
  const { headers, rows } = parsed
  if (mode === "box") return renderTableBox(headers, rows)
  if (mode === "list") return renderTableList(headers, rows)

  const hasLongCells = rows.some((r) => r.some((c) => c.length > 45))
  if (headers.length === 2 && !hasLongCells) {
    return renderTableList(headers, rows)
  }
  return renderTableBox(headers, rows)
}

/**
 * Robust Markdown -> Telegram HTML conversion.
 * 1. Markdown tables are converted to clean Monospace boxes or key-value cards.
 * 2. Code fences, inline code, and links are extracted and protected.
 * 3. The remaining text is fully HTML-escaped.
 * 4. Standard Markdown syntax (bold, italic, headers, strike, lists, quotes) is converted to Telegram HTML tags.
 * 5. Protected blocks are restored and all open tags are balanced.
 */
export function mdToHtml(markdown: string, tableMode: TableMode = "smart"): string {
  const source = String(markdown ?? "")
  if (!source) return ""

  const blocks: string[] = []
  const placeholder = (idx: number) => `\u0000TG_BLK_${idx}\u0000`

  // 0. Markdown tables
  const tableRegex = /((?:^[ \t]*\|?[^\n\|]+\|[^\n]*\n)[ \t]*\|?(?:\s*:?-{2,}:?\s*\|)+\s*(?:\s*:?-{2,}:?\s*)?(?:\n[ \t]*\|?[^\n\|]+\|[^\n]*)+)/gm
  let value = source.replace(tableRegex, (_match, tableRaw) => {
    const rendered = renderTable(tableRaw, tableMode)
    blocks.push(rendered)
    return placeholder(blocks.length - 1)
  })

  // 1. Multi-line code fences: ```lang\ncode\n```
  value = value.replace(/```([A-Za-z0-9_+.-]*)[^\n]*\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const cleaned = String(code ?? "").replace(/\n$/, "")
    const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : ""
    blocks.push(`<pre><code${langAttr}>${escapeHtml(cleaned)}</code></pre>`)
    return placeholder(blocks.length - 1)
  })

  // 2. Inline code: `code`
  value = value.replace(/`([^`\n]+)`/g, (_match, code) => {
    blocks.push(`<code>${escapeHtml(code)}</code>`)
    return placeholder(blocks.length - 1)
  })

  // 3. Links: [text](https://...)
  value = value.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, text, url) => {
    blocks.push(`<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`)
    return placeholder(blocks.length - 1)
  })

  // 4. Escape the remaining text so any raw <, >, & cannot break Telegram HTML entities
  value = escapeHtml(value)

  // 5. Convert markdown formatting
  // Headers (# Header)
  value = value.replace(/(^|\n)#{1,6}\s+([^\n]+)/g, "$1<b>$2</b>")
  // Bold (**text** or __text__)
  value = value.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
  value = value.replace(/(^|\s)__([^_\n]+)__(\s|$)/g, "$1<b>$2</b>$3")
  // Italic (*text* or _text_)
  value = value.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>")
  // Strikethrough (~~text~~)
  value = value.replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
  // Bullet lists (- or * at start of line)
  value = value.replace(/(^|\n)\s*[-*+]\s+/g, "$1• ")
  // Block quotes (> quote or &gt; quote)
  value = value.replace(/(^|\n)(?:>|&gt;)\s*([^\n]+)/g, "$1<blockquote>$2</blockquote>")

  // 6. Restore protected blocks
  value = value.replace(/\u0000TG_BLK_(\d+)\u0000/g, (_match, index) => blocks[Number(index)] ?? "")

  // 7. Ensure valid closing tags
  return balanceHtmlTags(value)
}

/** Split already-rendered HTML without cutting inside a tag, entity, or surrogate pair, propagating open tags. */
export function splitHtml(html: string, limit = 3800): string[] {
  const value = String(html ?? "")
  if (!value) return []
  if (value.length <= limit) return [balanceHtmlTags(value)]
  const chunks: string[] = []
  let rest = value
  let activePrefix = ""

  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit)
    if (cut < Math.floor(limit * 0.55)) cut = limit
    const open = rest.lastIndexOf("<", cut)
    const close = rest.lastIndexOf(">", cut)
    if (open > close) cut = open

    // Avoid cutting inside an HTML entity (e.g. &amp;)
    const lastAmp = rest.lastIndexOf("&", cut)
    const lastSemi = rest.lastIndexOf(";", cut)
    if (lastAmp > lastSemi && cut - lastAmp < 10) {
      cut = lastAmp
    }

    // Avoid splitting surrogate pairs
    if (cut > 0 && rest.charCodeAt(cut - 1) >= 0xd800 && rest.charCodeAt(cut - 1) <= 0xdbff) {
      cut -= 1
    }

    if (cut <= 0) cut = limit

    const slice = activePrefix + rest.slice(0, cut)
    const openTags = getOpenTags(slice)
    chunks.push(balanceHtmlTags(slice))

    activePrefix = openTags.map((t) => `<${t}>`).join("")
    rest = rest.slice(cut).replace(/^\n+/, "")
  }

  if (rest) {
    chunks.push(balanceHtmlTags(activePrefix + rest))
  }
  return chunks
}

export function formatBytes(input: number): string {
  let value = Number(input)
  if (!Number.isFinite(value) || value <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(index === 0 ? 0 : 2)} ${units[index]}`
}

export function formatDuration(input: number): string {
  let seconds = Math.max(0, Math.round(Number(input) || 0))
  if (seconds < 60) return `${seconds} ث`
  const minutes = Math.floor(seconds / 60)
  seconds %= 60
  if (minutes < 60) return `${minutes} د ${seconds} ث`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return `${hours} س ${restMinutes} د`
  const days = Math.floor(hours / 24)
  return `${days} ي ${hours % 24} س`
}

export function ago(timestamp: number): string {
  const value = Number(timestamp) || 0
  if (!value) return "—"
  const diff = Date.now() - value
  if (diff < 5000) return "الآن"
  return `منذ ${formatDuration(diff / 1000)}`
}

export function parseCommand(text: string, botUsername?: string) {
  const match = String(text || "").match(/^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/)
  if (!match) return null
  const target = match[2]
  if (target && botUsername && target.toLowerCase() !== botUsername.toLowerCase()) {
    return { name: "__ignore", args: "" }
  }
  return { name: match[1].toLowerCase(), args: (match[3] || "").trim() }
}

export function makeShortId(size = 8): string {
  return Math.random().toString(36).slice(2, 2 + size)
}

export function isBusySession(session: any): boolean {
  const busy = Number(session?.time?.busy) || 0
  const idle = Number(session?.time?.idle) || 0
  return busy > idle
}
