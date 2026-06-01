let accounts = []

const $ = (id) => document.getElementById(id)

function token() {
  return $("adminToken").value.trim()
}

function headers(extra = {}) {
  const t = token()
  return {
    "content-type": "application/json",
    ...(t ? { "x-admin-token": t } : {}),
    ...extra,
  }
}

function show(message, type = "ok") {
  const el = $("result")
  el.className = `notice ${type}`
  el.textContent = message
}

function hideNotice() {
  $("result").className = "notice hidden"
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: headers(options.headers || {}),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok || data?.ok === false) {
    throw new Error(data?.detail || data?.error || `HTTP ${response.status}`)
  }
  return data
}

function renderAccounts() {
  const q = $("search").value.trim().toLowerCase()
  const rows = accounts.filter((item) => !q || item.email.toLowerCase().includes(q))
  $("countText").textContent = `共 ${accounts.length} 个，当前显示 ${rows.length} 个。`
  $("emailSelect").innerHTML = rows
    .map((item) => `<option value="${escapeHtml(item.email)}">${escapeHtml(item.email)}</option>`)
    .join("")
  $("accountsBody").innerHTML = rows.map((item) => `
    <tr>
      <td><div class="email">${escapeHtml(item.email)}</div><div>${escapeHtml(item.note || "")}</div></td>
      <td><code>${escapeHtml(item.passwordMasked || "")}</code></td>
      <td><code>${escapeHtml(item.clientIdMasked || "")}</code></td>
      <td><code>${escapeHtml(item.refreshTokenMasked || "")}</code></td>
      <td>${escapeHtml(formatDate(item.lastCheckAt))}<div>${escapeHtml(item.lastSubject || "")}</div></td>
      <td class="code">${escapeHtml(item.lastCode || "-")}</td>
      <td>
        <div class="actions">
          <button onclick="fetchCode('${escapeAttr(item.email)}')">取码</button>
          <button class="danger" onclick="removeAccount('${escapeAttr(item.email)}')">删除</button>
        </div>
      </td>
    </tr>
  `).join("") || `<tr><td colspan="7">暂无账号。</td></tr>`
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]))
}

function escapeAttr(value) {
  return String(value || "").replace(/[\\']/g, "")
}

function formatDate(value) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString("zh-CN", { hour12: false })
}

async function loadAccounts() {
  hideNotice()
  const data = await api("/api/accounts", { method: "GET", headers: token() ? { "x-admin-token": token() } : {} })
  accounts = data.accounts || []
  renderAccounts()
}

async function importAccounts() {
  const text = $("importText").value
  if (!text.trim()) return show("导入内容为空。", "err")
  $("importBtn").disabled = true
  try {
    const data = await api("/api/accounts/import", {
      method: "POST",
      body: JSON.stringify({ text, replace: $("replaceImport").checked }),
    })
    accounts = data.accounts || []
    renderAccounts()
    show(`导入完成：新增/更新 ${data.imported} 个，总数 ${data.total} 个，错误 ${data.errors?.length || 0} 行。`)
  } catch (error) {
    show(error.message, "err")
  } finally {
    $("importBtn").disabled = false
  }
}

async function fetchCode(email) {
  const target = email || $("emailSelect").value
  if (!target) return show("先选择邮箱。", "err")
  $("otpBtn").disabled = true
  show(`正在取码：${target}`)
  try {
    const data = await api("/api/otp", {
      method: "POST",
      body: JSON.stringify({
        email: target,
        keywords: $("keywords").value.trim(),
        digits: Number($("digits").value || 6),
        sinceMinutes: Number($("sinceMinutes").value || 30),
      }),
    })
    await loadAccounts()
    if (data.code) {
      show(`取码成功：${target} => ${data.code}。主题：${data.message?.subject || "-"}`)
    } else {
      show(`已读取 ${data.messages?.length || 0} 封邮件，未发现验证码。`, "err")
    }
  } catch (error) {
    show(error.message, "err")
  } finally {
    $("otpBtn").disabled = false
  }
}

async function removeAccount(email) {
  if (!confirm(`删除 ${email}？`)) return
  try {
    await api(`/api/accounts/${encodeURIComponent(email)}`, { method: "DELETE" })
    await loadAccounts()
    show("已删除。")
  } catch (error) {
    show(error.message, "err")
  }
}

window.fetchCode = fetchCode
window.removeAccount = removeAccount

$("refreshBtn").addEventListener("click", loadAccounts)
$("importBtn").addEventListener("click", importAccounts)
$("otpBtn").addEventListener("click", () => fetchCode())
$("search").addEventListener("input", renderAccounts)
$("adminToken").addEventListener("change", loadAccounts)

loadAccounts().catch((error) => show(error.message, "err"))
