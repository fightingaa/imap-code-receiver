import express from "express"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  deleteAccount,
  findAccount,
  parseImportText,
  publicAccount,
  readAccounts,
  updateAccount,
  upsertImportedAccounts,
} from "./store.js"
import { fetchOtp } from "./imap.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PORT = Number(process.env.PORT || 8787)
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "")

const app = express()
app.use(express.json({ limit: "10mb" }))
app.use(express.urlencoded({ extended: true, limit: "10mb" }))
app.use(express.static(path.join(__dirname, "..", "public")))

function requireAuth(req, res, next) {
  if (!ADMIN_TOKEN) return next()
  const header = String(req.headers.authorization || "")
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : ""
  const token = String(req.headers["x-admin-token"] || bearer || req.query.token || "")
  if (token === ADMIN_TOKEN) return next()
  res.status(401).json({ ok: false, error: "unauthorized", detail: "ADMIN_TOKEN 不正确。" })
}

app.get("/health", (_req, res) => {
  res.json({ ok: true })
})

app.get("/api/accounts", requireAuth, async (_req, res) => {
  const accounts = await readAccounts()
  res.json({ ok: true, count: accounts.length, accounts: accounts.map(publicAccount) })
})

app.post("/api/accounts/import", requireAuth, async (req, res) => {
  const text = String(req.body.text || "")
  const replace = req.body.replace === true || req.body.replace === "true"
  const parsed = parseImportText(text)
  if (!parsed.accounts.length) {
    return res.status(400).json({ ok: false, error: "empty_import", detail: "没有解析到有效账号。", errors: parsed.errors })
  }
  const accounts = await upsertImportedAccounts(parsed.accounts, { replace })
  res.json({
    ok: true,
    imported: parsed.accounts.length,
    total: accounts.length,
    errors: parsed.errors,
    accounts: accounts.map(publicAccount),
  })
})

app.delete("/api/accounts/:email", requireAuth, async (req, res) => {
  const deleted = await deleteAccount(req.params.email)
  res.json({ ok: true, deleted })
})

app.post("/api/otp", requireAuth, async (req, res) => {
  const email = String(req.body.email || "")
  const account = await findAccount(email)
  if (!account) {
    return res.status(404).json({ ok: false, error: "account_not_found", detail: "账号不存在。" })
  }

  try {
    const result = await fetchOtp(account, {
      keywords: req.body.keywords || "",
      digits: req.body.digits || 6,
      sinceMinutes: req.body.sinceMinutes || 30,
      maxMessages: req.body.maxMessages || 30,
      sentAfterIso: req.body.sentAfterIso || "",
      strictSince: req.body.strictSince !== false,
    })

    const patch = {
      lastCheckAt: new Date().toISOString(),
      lastCode: result.code || "",
      lastSubject: result.message?.subject || "",
    }
    if (result.newRefreshToken && result.newRefreshToken !== account.refreshToken) {
      patch.refreshToken = result.newRefreshToken
    }
    await updateAccount(account.email, patch)

    res.json(result)
  } catch (error) {
    await updateAccount(account.email, {
      lastCheckAt: new Date().toISOString(),
      note: error instanceof Error ? error.message : String(error),
    })
    res.status(500).json({
      ok: false,
      error: "fetch_otp_failed",
      detail: error instanceof Error ? error.message : String(error),
    })
  }
})

app.listen(PORT, () => {
  console.log(`imap-code-receiver listening on http://127.0.0.1:${PORT}`)
})
