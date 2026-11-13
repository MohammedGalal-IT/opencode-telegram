import { balanceHtmlTags, errorMessage, mdToHtml, splitHtml, stripHtml } from "./util"

export class TelegramClient {
  constructor(private readonly getToken: () => string) {}

  async call(method: string, payload: any = {}, signal?: AbortSignal, timeoutMs = 45000): Promise<any> {
    const token = this.getToken()
    if (!token) throw new Error("Telegram bot token is missing")

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error("Telegram request timed out")), timeoutMs)
    const onAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener("abort", onAbort, { once: true })

    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload ?? {}),
        signal: controller.signal,
      })
      const body = await response.text()
      let data: any = {}
      try {
        data = body ? JSON.parse(body) : {}
      } catch {
        data = {}
      }
      if (!response.ok || data.ok === false) {
        const description = data?.description || body.slice(0, 300) || response.statusText
        throw new Error(`${method} failed (${response.status}): ${description}`)
      }
      return data.result
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    }
  }
}

function parseEntityError(message: string): boolean {
  return /can't parse entities|unsupported start tag|can't find end tag|entity/i.test(message)
}

export async function sendPayload(client: TelegramClient, payload: any): Promise<any> {
  try {
    return await client.call("sendMessage", payload, undefined, 20000)
  } catch (error) {
    const message = errorMessage(error)
    if (payload?.parse_mode && parseEntityError(message)) {
      const fallback: any = { ...payload, text: stripHtml(payload.text) }
      delete fallback.parse_mode
      return client.call("sendMessage", fallback, undefined, 20000)
    }
    throw error
  }
}

export async function sendHtml(
  client: TelegramClient,
  chatId: string,
  html: string,
  extra: { reply_markup?: any } = {},
): Promise<any> {
  const chunks = splitHtml(html, 3800)
  if (chunks.length === 0) return undefined
  let last: any = undefined
  for (let index = 0; index < chunks.length; index += 1) {
    const payload: any = {
      chat_id: chatId,
      text: chunks[index],
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }
    if (index === chunks.length - 1 && extra.reply_markup) payload.reply_markup = extra.reply_markup
    last = await sendPayload(client, payload)
  }
  return last
}

export async function sendMarkdown(
  client: TelegramClient,
  chatId: string,
  markdown: string,
  extra: { reply_markup?: any } = {},
): Promise<any> {
  return sendHtml(client, chatId, mdToHtml(markdown), extra)
}

export async function editHtml(
  client: TelegramClient,
  chatId: string,
  messageId: number,
  html: string,
  extra: { reply_markup?: any } = {},
): Promise<void> {
  if (!messageId) return
  const safeHtml = balanceHtmlTags(html)
  try {
    const payload: any = {
      chat_id: chatId,
      message_id: messageId,
      text: safeHtml,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }
    if (extra.reply_markup) payload.reply_markup = extra.reply_markup
    await client.call("editMessageText", payload, undefined, 15000)
  } catch (error) {
    const message = errorMessage(error)
    if (/message is not modified/i.test(message)) return
    if (parseEntityError(message)) {
      try {
        await client.call(
          "editMessageText",
          {
            chat_id: chatId,
            message_id: messageId,
            text: stripHtml(html),
            disable_web_page_preview: true,
          },
          undefined,
          15000,
        )
      } catch {
        // The message may have been deleted or is too old; never crash the bridge for this.
      }
      return
    }
    // Ignore other edit failures: stale drafts are common and harmless.
  }
}

export async function deleteMessage(client: TelegramClient, chatId: string, messageId?: number): Promise<void> {
  if (!messageId) return
  try {
    await client.call("deleteMessage", { chat_id: chatId, message_id: messageId }, undefined, 10000)
  } catch {
    // Deleting is best effort only.
  }
}

export async function sendChatAction(
  client: TelegramClient,
  chatId: string,
  action: string = "typing",
): Promise<void> {
  try {
    await client.call("sendChatAction", { chat_id: chatId, action }, undefined, 10000)
  } catch {
    // Ignore typing indicator failures.
  }
}

export async function answerCallback(
  client: TelegramClient,
  callbackQueryId: string,
  text?: string,
  showAlert = false,
): Promise<void> {
  try {
    await client.call(
      "answerCallbackQuery",
      {
        callback_query_id: callbackQueryId,
        text: text || undefined,
        show_alert: showAlert || undefined,
      },
      undefined,
      10000,
    )
  } catch {
    // Ignore.
  }
}
