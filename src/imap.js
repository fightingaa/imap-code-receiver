import { ImapFlow } from "imapflow"
import { simpleParser } from "mailparser"

const TOKEN_URL = process.env.MS_TOKEN_URL || "https://login.microsoftonline.com/common/oauth2/v2.0/token"
const IMAP_HOST = process.env.IMAP_HOST || "outlook.office365.com"
const IMAP_PORT = Number(process.env.IMAP_PORT || 993)
const DEFAULT_SCOPE = process.env.MS_SCOPE || "https://outlook.office.com/IMAP.AccessAsUser.All offline_access"

export async function refreshAccessToken({ clientId, refreshToken }) {
  const body = new URLSearchParams({
    client_id: clientId,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
    scope: DEFAULT_SCOPE,
  })

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || !data.access_token) {
    throw new Error(`刷新 access_token 失败：HTTP ${response.status} ${data.error_description || data.error || ""}`.trim())
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: Number(data.expires_in || 0),
  }
}

function buildKeywordList(input) {
  return String(input || "")
    .split(/[，,\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

function textMatchesKeywords(text, keywords) {
  if (!keywords.length) return true
  const lower = String(text || "").toLowerCase()
  return keywords.some((keyword) => lower.includes(keyword))
}

function extractCode(text, digits) {
  const size = Math.min(Math.max(Number(digits || 6), 4), 10)
  const regex = new RegExp(`(?<!\\d)(\\d{${size}})(?!\\d)`, "g")
  const matches = Array.from(String(text || "").matchAll(regex)).map((item) => item[1])
  return matches[0] || ""
}

function preferredFolders(allFolders) {
  const folders = allFolders.map((folder) => folder.path || folder.name).filter(Boolean)
  const lower = new Map(folders.map((folder) => [folder.toLowerCase(), folder]))
  const names = [
    "inbox",
    "junk email",
    "junk",
    "spam",
    "deleted items",
  ]
  const picked = []
  for (const name of names) {
    const hit = lower.get(name)
    if (hit && !picked.includes(hit)) picked.push(hit)
  }
  if (!picked.length && folders[0]) picked.push(folders[0])
  return picked
}

export async function fetchOtp(account, options = {}) {
  const sinceMinutes = Math.min(Math.max(Number(options.sinceMinutes || 30), 1), 1440)
  const maxMessages = Math.min(Math.max(Number(options.maxMessages || 30), 1), 200)
  const digits = Math.min(Math.max(Number(options.digits || 6), 4), 10)
  const keywords = buildKeywordList(options.keywords)
  const since = options.sentAfterIso ? new Date(options.sentAfterIso) : new Date(Date.now() - sinceMinutes * 60 * 1000)
  const strictSince = options.strictSince !== false

  const token = await refreshAccessToken({ clientId: account.clientId, refreshToken: account.refreshToken })

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: {
      user: account.email,
      accessToken: token.accessToken,
    },
    logger: false,
  })

  const messages = []
  let code = ""
  let codeMessage = null

  try {
    await client.connect()
    const allFolders = await client.list()
    const folders = Array.isArray(options.folders) && options.folders.length
      ? options.folders
      : preferredFolders(allFolders)

    for (const folder of folders) {
      let lock
      try {
        lock = await client.getMailboxLock(folder)
        let uids = await client.search({ since })
        uids = uids.slice(-maxMessages).reverse()
        if (!uids.length) continue

        for await (const msg of client.fetch(uids, { envelope: true, source: true, internalDate: true })) {
          const internalDate = msg.internalDate ? new Date(msg.internalDate) : null
          if (strictSince && internalDate && internalDate < since) continue

          const parsed = await simpleParser(msg.source)
          const subject = parsed.subject || msg.envelope?.subject || ""
          const from = parsed.from?.text || msg.envelope?.from?.map((item) => item.address).join(", ") || ""
          const text = [subject, from, parsed.text || "", parsed.html || ""].join("\n")
          if (!textMatchesKeywords(text, keywords)) continue

          const found = extractCode(text, digits)
          const item = {
            folder,
            subject,
            from,
            date: internalDate ? internalDate.toISOString() : "",
            code: found,
          }
          messages.push(item)
          if (found && !code) {
            code = found
            codeMessage = item
          }
        }
      } catch {
        // 有些租户没有 Junk/Spam 文件夹，跳过。
      } finally {
        lock?.release()
      }

      if (code) break
    }
  } finally {
    try {
      await client.logout()
    } catch {}
  }

  return {
    ok: true,
    code,
    message: codeMessage,
    messages,
    checkedFolders: messages.map((item) => item.folder).filter((value, index, arr) => arr.indexOf(value) === index),
    newRefreshToken: token.refreshToken,
  }
}
