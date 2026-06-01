import fs from "node:fs/promises"
import path from "node:path"

const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), "data")
const STORE_PATH = path.join(DATA_DIR, "accounts.json")

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase()
}

export function maskSecret(value, head = 4, tail = 4) {
  const text = String(value || "")
  if (!text) return ""
  if (text.length <= head + tail + 2) return "•".repeat(Math.min(text.length, 10))
  return `${text.slice(0, head)}…${text.slice(-tail)}`
}

async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true })
  try {
    await fs.access(STORE_PATH)
  } catch {
    await fs.writeFile(STORE_PATH, "[]", "utf8")
  }
}

export async function readAccounts() {
  await ensureStore()
  const raw = await fs.readFile(STORE_PATH, "utf8")
  const data = JSON.parse(raw || "[]")
  return Array.isArray(data) ? data : []
}

export async function writeAccounts(accounts) {
  await ensureStore()
  const tmp = `${STORE_PATH}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(accounts, null, 2), "utf8")
  await fs.rename(tmp, STORE_PATH)
}

export function parseImportText(text) {
  const lines = String(text || "").split(/\r?\n/)
  const accounts = []
  const errors = []

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue

    let parts
    if (line.includes("----")) parts = line.split("----")
    else if (line.includes("|")) parts = line.split("|")
    else if (line.includes(",")) parts = line.split(",")
    else parts = line.split(/\s+/)

    parts = parts.map((item) => item.trim())
    if (parts.length < 4) {
      errors.push({ line: index + 1, error: "字段不足，应为 email----password----client_id----refresh_token" })
      continue
    }

    const [email, password, clientId, refreshToken] = parts
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      errors.push({ line: index + 1, error: "邮箱格式不对" })
      continue
    }
    if (!clientId || !refreshToken) {
      errors.push({ line: index + 1, error: "client_id / refresh_token 不能为空" })
      continue
    }

    accounts.push({
      email: normalizeEmail(email),
      password,
      clientId,
      refreshToken,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastCheckAt: "",
      lastCode: "",
      lastSubject: "",
      note: "",
    })
  }

  return { accounts, errors }
}

export async function upsertImportedAccounts(imported, { replace = false } = {}) {
  const current = replace ? [] : await readAccounts()
  const byEmail = new Map(current.map((item) => [normalizeEmail(item.email), item]))

  for (const item of imported) {
    const key = normalizeEmail(item.email)
    const old = byEmail.get(key)
    byEmail.set(key, {
      ...(old || {}),
      ...item,
      email: key,
      createdAt: old?.createdAt || item.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  }

  const next = Array.from(byEmail.values()).sort((a, b) => a.email.localeCompare(b.email))
  await writeAccounts(next)
  return next
}

export function publicAccount(account) {
  return {
    email: account.email,
    passwordMasked: maskSecret(account.password, 2, 2),
    clientIdMasked: maskSecret(account.clientId, 6, 6),
    refreshTokenMasked: maskSecret(account.refreshToken, 6, 6),
    createdAt: account.createdAt || "",
    updatedAt: account.updatedAt || "",
    lastCheckAt: account.lastCheckAt || "",
    lastCode: account.lastCode || "",
    lastSubject: account.lastSubject || "",
    note: account.note || "",
  }
}

export async function findAccount(email) {
  const key = normalizeEmail(email)
  const accounts = await readAccounts()
  return accounts.find((item) => normalizeEmail(item.email) === key) || null
}

export async function updateAccount(email, patch) {
  const key = normalizeEmail(email)
  const accounts = await readAccounts()
  const next = accounts.map((item) => {
    if (normalizeEmail(item.email) !== key) return item
    return { ...item, ...patch, updatedAt: new Date().toISOString() }
  })
  await writeAccounts(next)
  return next.find((item) => normalizeEmail(item.email) === key) || null
}

export async function deleteAccount(email) {
  const key = normalizeEmail(email)
  const accounts = await readAccounts()
  const next = accounts.filter((item) => normalizeEmail(item.email) !== key)
  await writeAccounts(next)
  return accounts.length - next.length
}
