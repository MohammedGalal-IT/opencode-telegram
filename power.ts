import { execFile } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import { Bridge } from "./bridge"
import { editHtml, sendHtml } from "./telegram"
import { errorMessage, escapeHtml, log, logError, sleep } from "./util"

const execFileAsync = promisify(execFile)

export interface BatteryInfo {
  hasBattery: boolean
  percent: number
  online: boolean
  charging?: boolean
  description: string
}

export interface PowerGuardState {
  enabled: boolean
  targetPercent: number
  targetChatId?: string
  warnedEarly: boolean
  timer?: NodeJS.Timeout
}

// In-memory runtime state: never persisted to disk or OS, reset on reload/reboot.
export const powerGuard: PowerGuardState = {
  enabled: false,
  targetPercent: 12,
  warnedEarly: false,
}

/**
 * Reads battery level and power source in a cross-platform manner (Windows & Linux).
 */
export async function getBatteryInfo(): Promise<BatteryInfo> {
  const platform = process.platform

  // --- Windows Implementation ---
  if (platform === "win32") {
    try {
      const script =
        "Add-Type -AssemblyName System.Windows.Forms; " +
        "[math]::Round([System.Windows.Forms.SystemInformation]::PowerStatus.BatteryLifePercent * 100).ToString() + '|' + " +
        "([System.Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus -eq 'Online').ToString()"

      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { timeout: 8000, windowsHide: true },
      )

      const parts = String(stdout || "").trim().split("|")
      const percent = parseInt(parts[0] || "0", 10)
      const online = parts[1]?.toLowerCase() === "true"

      if (isNaN(percent) || percent <= 0) {
        return {
          hasBattery: false,
          percent: 0,
          online: true,
          description: "كمبيوتر مكتبي أو بطارية غير متوفرة",
        }
      }

      return {
        hasBattery: true,
        percent,
        online,
        charging: online,
        description: online ? "موصول بالشاحن (AC Online) 🔌" : "يعمل على البطارية (Battery Offline) 🔋",
      }
    } catch (error) {
      logError("Windows battery query failed:", errorMessage(error))
      return {
        hasBattery: false,
        percent: 0,
        online: true,
        description: "تعذّر قراءة البطارية",
      }
    }
  }

  // --- Linux Implementation ---
  if (platform === "linux") {
    try {
      const base = "/sys/class/power_supply"
      if (existsSync(base)) {
        const entries = readdirSync(base)
        const batDir = entries.find((e) => /^(BAT|BATT|battery)/i.test(e))
        const acDir = entries.find((e) => /^(AC|ACAD|ADP|line_power)/i.test(e))

        let percent = 0
        let status = ""
        let online = false

        if (batDir) {
          const capPath = join(base, batDir, "capacity")
          const statPath = join(base, batDir, "status")
          if (existsSync(capPath)) {
            percent = parseInt(readFileSync(capPath, "utf8").trim(), 10) || 0
          }
          if (existsSync(statPath)) {
            status = readFileSync(statPath, "utf8").trim()
          }
        }

        if (acDir) {
          const onlinePath = join(base, acDir, "online")
          if (existsSync(onlinePath)) {
            online = readFileSync(onlinePath, "utf8").trim() === "1"
          }
        } else {
          online = status.toLowerCase() === "charging" || status.toLowerCase() === "full"
        }

        if (batDir && percent > 0) {
          return {
            hasBattery: true,
            percent,
            online,
            charging: status.toLowerCase() === "charging",
            description: online ? "موصول بالشاحن (AC Online) 🔌" : "يعمل على البطارية (Battery Offline) 🔋",
          }
        }
      }
    } catch (error) {
      logError("Linux power_supply read failed:", errorMessage(error))
    }

    return {
      hasBattery: false,
      percent: 0,
      online: true,
      description: "بطارية غير متوفرة أو نظام غير محمول",
    }
  }

  // Fallback for other platforms (e.g. Darwin / BSD)
  return {
    hasBattery: false,
    percent: 0,
    online: true,
    description: "نظام التشغيل غير مدعوم لمراقبة البطارية",
  }
}

/**
 * Triggers system hibernation in a cross-platform manner.
 */
export async function hibernateSystem(): Promise<{ success: boolean; error?: string }> {
  const platform = process.platform
  try {
    if (platform === "win32") {
      await execFileAsync("shutdown.exe", ["/h"], { timeout: 10000, windowsHide: true })
      return { success: true }
    }
    if (platform === "linux") {
      await execFileAsync("systemctl", ["hibernate"], { timeout: 10000 })
      return { success: true }
    }
    return { success: false, error: `نظام التشغيل ${platform} غير مدعوم للإسبات المباشر` }
  } catch (error) {
    return { success: false, error: errorMessage(error) }
  }
}

/**
 * Starts the in-memory power guard loop.
 */
export function startPowerGuard(bridge: Bridge, chatId: string, targetPercent = 12): void {
  stopPowerGuard()
  powerGuard.enabled = true
  powerGuard.targetPercent = targetPercent
  powerGuard.targetChatId = chatId
  powerGuard.warnedEarly = false

  log(`Power guard enabled for chat ${chatId} at ${targetPercent}%.`)

  powerGuard.timer = setInterval(async () => {
    if (!powerGuard.enabled) return
    try {
      const info = await getBatteryInfo()
      if (!info.hasBattery) return

      // If connected to AC power, reset early warning
      if (info.online) {
        powerGuard.warnedEarly = false
        return
      }

      // Early warning at 16%
      if (!info.online && info.percent <= 16 && info.percent > targetPercent && !powerGuard.warnedEarly) {
        powerGuard.warnedEarly = true
        if (powerGuard.targetChatId) {
          const warnHtml = [
            "⚠️ <b>تنبيه انخفاض البطارية</b>",
            "",
            `نسبة الشحن الحالية: <b>${info.percent}%</b> (غير موصول بالشاحن).`,
            `يرجى توصيل الشاحن لتجنب إسبات الجهاز التلقائي عند <b>${targetPercent}%</b> ⚡.`,
          ].join("\n")
          await sendHtml(bridge.client, powerGuard.targetChatId, warnHtml).catch(() => undefined)
        }
      }

      // Critical trigger at targetPercent (default 12%)
      if (!info.online && info.percent <= targetPercent && info.percent > 0) {
        log(`Power guard: battery reached ${info.percent}%. Hibernating now.`)
        const targetChat = powerGuard.targetChatId
        stopPowerGuard()

        if (targetChat) {
          const critHtml = [
            "🚨 <b>تنبيه حرج للبطارية — إسبات الجهاز</b>",
            "",
            `وصلت نسبة الشحن إلى <b>${info.percent}%</b> والجهاز غير موصول بالشاحن.`,
            "",
            "💤 <b>جاري إدخال الجهاز في وضع الإسبات (Hibernate) الآن</b> لحفظ أعمالك وحماية حالة النظام.",
          ].join("\n")
          await sendHtml(bridge.client, targetChat, critHtml).catch(() => undefined)
        }

        await sleep(5000)
        await hibernateSystem()
      }
    } catch (error) {
      logError("Power guard tick error:", errorMessage(error))
    }
  }, 45000)
  if (typeof (powerGuard.timer as any)?.unref === "function") {
    ;(powerGuard.timer as any).unref()
  }
}

/**
 * Stops the in-memory power guard loop.
 */
export function stopPowerGuard(): void {
  if (powerGuard.timer) {
    clearInterval(powerGuard.timer)
    powerGuard.timer = undefined
  }
  powerGuard.enabled = false
  powerGuard.warnedEarly = false
}

/**
 * Renders the HTML card for battery and power management.
 */
export function renderPowerCard(info: BatteryInfo, guard: PowerGuardState): string {
  const lines = ["⚡ <b>التحكم في الطاقة والبطارية</b>", ""]

  if (!info.hasBattery) {
    lines.push("🖥️ <b>نوع الجهاز</b>: كمبيوتر مكتبي (أو بطارية غير متوفرة)")
    lines.push(`الحالة: ${escapeHtml(info.description)}`)
  } else {
    const batteryIcon = info.percent > 75 ? "🔋" : info.percent > 25 ? "🪫" : "⚠️"
    lines.push(`${batteryIcon} <b>نسبة الشحن</b>: <b>${info.percent}%</b>`)
    lines.push(`🔌 <b>مصدر الطاقة</b>: ${escapeHtml(info.description)}`)
  }

  lines.push("")
  if (guard.enabled) {
    lines.push(`🛡️ <b>الحماية التلقائية</b>: 🟢 <b>مفعّلة لهذه الجلسة</b> (إسبات تلقائي عند <b>${guard.targetPercent}%</b>)`)
  } else {
    lines.push("🛡️ <b>الحماية التلقائية</b>: ⚪ <b>متوقفة</b> (غير نشطة افتراضياً)")
  }

  return lines.join("\n")
}

/**
 * Builds interactive inline keyboard buttons for power control.
 */
export function renderPowerKeyboard(guard: PowerGuardState, confirmHibernate = false): any {
  if (confirmHibernate) {
    return {
      inline_keyboard: [
        [{ text: "⚠️ تأكيد: إسبات الجهاز الآن 💤", callback_data: "power:hib_confirm" }],
        [{ text: "❌ تراجع / إلغاء", callback_data: "power:refresh" }],
      ],
    }
  }

  const guardButton = guard.enabled
    ? { text: "🛑 إيقاف الحماية عند 12%", callback_data: "power:disable" }
    : { text: "⚡ تفعيل الإسبات عند 12%", callback_data: "power:enable" }

  return {
    inline_keyboard: [
      [guardButton],
      [{ text: "💤 إسبات الجهاز الآن", callback_data: "power:hib_ask" }],
      [{ text: "🔄 تحديث الحالة", callback_data: "power:refresh" }],
    ],
  }
}
