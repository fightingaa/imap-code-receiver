import { connect } from "cloudflare:sockets";

const IMAP_HOST = "outlook.office365.com";
const IMAP_PORT = 993;
const DEFAULT_LIMIT = 20;
const DEFAULT_SINCE_MINUTES = 30;
const TOKEN_ENDPOINT = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const TOKEN_SCOPE = "https://outlook.office.com/IMAP.AccessAsUser.All offline_access";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    try {
      if (request.method === "GET" && url.pathname === "/") {
        return htmlResponse(APP_HTML);
      }

      if (request.method === "GET" && url.pathname === "/api/health") {
        return json({ ok: true, mode: "cloudflare-worker" });
      }

      if (request.method === "POST" && url.pathname === "/api/otp") {
        const payload = await request.json();
        const result = await handleOtp(payload);
        return json(result);
      }

      return json({ ok: false, error: "not_found" }, 404);
    } catch (error) {
      return json(
        {
          ok: false,
          error: error.code || "worker_error",
          detail: error.message || String(error),
        },
        error.status || 500,
      );
    }
  },
};

async function handleOtp(payload) {
  const account = normalizeAccount(payload?.account || payload);
  const digits = clampInt(payload?.digits, 4, 10, 6);
  const limit = clampInt(payload?.limit || payload?.maxMessages, 1, 50, DEFAULT_LIMIT);
  const sinceMinutes = clampInt(payload?.sinceMinutes || payload?.since_minutes, 1, 1440, DEFAULT_SINCE_MINUTES);
  const keywords = String(payload?.keywords || "").trim();
  const strictSince = payload?.strictSince !== false;
  const startedAt = new Date();
  const minDate = new Date(startedAt.getTime() - sinceMinutes * 60_000);

  const token = await refreshAccessToken(account.clientId, account.refreshToken);
  const client = new ImapClient(IMAP_HOST, IMAP_PORT);
  const folders = [];
  const messages = [];

  try {
    await client.connect();
    await client.authenticate(account.email, token);

    const listed = await client.listMailboxes();
    const candidates = pickFolders(listed);

    for (const folder of candidates) {
      try {
        const opened = await client.examine(folder);
        folders.push({ folder, exists: opened.exists });
        if (!opened.exists) continue;

        const uids = await client.searchSince(minDate);
        const selectedUids = uids.slice(-limit).reverse();

        for (const uid of selectedUids) {
          const raw = await client.fetchMessage(uid);
          const parsed = parseFetchedMessage(raw, folder, uid);
          if (strictSince && parsed.date && parsed.date < minDate) continue;
          if (keywords && !containsKeywords(parsed, keywords)) continue;
          parsed.codes = extractCodes(parsed.text, digits);
          messages.push(parsed);
        }
      } catch (error) {
        folders.push({ folder, exists: false, skipped: true, error: trimLog(error.message || error) });
      }
    }

    const codeHit = messages.find((item) => item.codes.length > 0);
    await client.logout().catch(() => {});

    return {
      ok: true,
      code: codeHit?.codes?.[0] || null,
      codes: codeHit?.codes || [],
      found: Boolean(codeHit),
      folders,
      messages: messages.map((item) => ({
        uid: item.uid,
        folder: item.folder,
        from: item.from,
        subject: item.subject,
        date: item.date ? item.date.toISOString() : null,
        codes: item.codes,
        snippet: item.snippet,
      })),
    };
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

function normalizeAccount(input) {
  const account = {
    email: String(input?.email || "").trim(),
    password: String(input?.password || ""),
    clientId: String(input?.clientId || input?.client_id || "").trim(),
    refreshToken: String(input?.refreshToken || input?.refresh_token || "").trim(),
  };

  if (!account.email) throw badRequest("missing_email", "缺少邮箱。");
  if (!account.clientId) throw badRequest("missing_client_id", "缺少 client_id。");
  if (!account.refreshToken) throw badRequest("missing_refresh_token", "缺少 refresh_token。");
  return account;
}

async function refreshAccessToken(clientId, refreshToken) {
  const body = new URLSearchParams();
  body.set("client_id", clientId);
  body.set("refresh_token", refreshToken);
  body.set("grant_type", "refresh_token");
  body.set("scope", TOKEN_SCOPE);

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.access_token) {
    const detail = data.error_description || data.error || `HTTP ${response.status}`;
    throw badRequest("oauth_refresh_failed", detail);
  }

  return data.access_token;
}

class ImapClient {
  constructor(host, port) {
    this.host = host;
    this.port = port;
    this.socket = null;
    this.reader = null;
    this.writer = null;
    this.decoder = new TextDecoder();
    this.encoder = new TextEncoder();
    this.buffer = "";
    this.tagNo = 1;
  }

  async connect() {
    this.socket = connect(
      { hostname: this.host, port: this.port },
      { secureTransport: "on" },
    );
    this.reader = this.socket.readable.getReader();
    this.writer = this.socket.writable.getWriter();
    const greeting = await this.readUntilLine();
    if (!/^\*\s+OK/i.test(greeting)) {
      throw new Error(`IMAP greeting failed: ${trimLog(greeting)}`);
    }
  }

  async authenticate(email, accessToken) {
    const xoauth2 = `user=${email}\x01auth=Bearer ${accessToken}\x01\x01`;
    const encoded = btoaUtf8(xoauth2);
    const response = await this.command(`AUTHENTICATE XOAUTH2 ${encoded}`);
    if (!/OK/i.test(response)) {
      throw badRequest("imap_auth_failed", trimLog(response));
    }
  }

  async listMailboxes() {
    const response = await this.command('LIST "" "*"');
    const names = [];
    for (const line of response.split(/\r?\n/)) {
      const parsed = parseListLine(line);
      if (parsed) names.push(parsed);
    }
    return names;
  }

  async examine(folder) {
    const response = await this.command(`EXAMINE ${quoteImap(folder)}`);
    const exists = Number(response.match(/\*\s+(\d+)\s+EXISTS/i)?.[1] || 0);
    return { exists };
  }

  async searchSince(date) {
    const day = formatImapDate(date);
    const response = await this.command(`UID SEARCH SINCE ${day}`);
    const match = response.match(/\*\s+SEARCH\s+([0-9 ]*)/i);
    const uids = match?.[1]
      ?.trim()
      ?.split(/\s+/)
      ?.map((value) => Number(value))
      ?.filter(Boolean) || [];
    return Array.from(new Set(uids));
  }

  async fetchMessage(uid) {
    return await this.command(`UID FETCH ${uid} (INTERNALDATE BODY.PEEK[])`, 45_000);
  }

  async logout() {
    await this.command("LOGOUT", 5_000);
    await this.close();
  }

  async close() {
    try {
      await this.writer?.close();
    } catch {}
    try {
      await this.reader?.releaseLock();
    } catch {}
    try {
      this.socket?.close?.();
    } catch {}
  }

  async command(command, timeoutMs = 30_000) {
    const tag = `A${this.tagNo++}`;
    await this.write(`${tag} ${command}\r\n`);
    const response = await this.readUntilTag(tag, timeoutMs);
    if (new RegExp(`^${tag}\\s+(NO|BAD)`, "im").test(response)) {
      throw new Error(`IMAP command failed: ${trimLog(response)}`);
    }
    return response;
  }

  async write(text) {
    await this.writer.write(this.encoder.encode(text));
  }

  async readUntilLine(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (!this.buffer.includes("\r\n")) {
      await this.readChunk(deadline);
    }
    const idx = this.buffer.indexOf("\r\n");
    const line = this.buffer.slice(0, idx + 2);
    this.buffer = this.buffer.slice(idx + 2);
    return line;
  }

  async readUntilTag(tag, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    const done = new RegExp(`\\r?\\n${tag}\\s+(OK|NO|BAD)\\b[^\\r\\n]*(?:\\r?\\n|$)`, "i");
    while (!done.test(`\n${this.buffer}`)) {
      await this.readChunk(deadline);
    }
    const match = `\n${this.buffer}`.match(done);
    const end = match.index + match[0].length - 1;
    const response = this.buffer.slice(0, end);
    this.buffer = this.buffer.slice(end);
    return response;
  }

  async readChunk(deadline) {
    if (Date.now() > deadline) throw new Error("IMAP read timeout");
    const result = await Promise.race([
      this.reader.read(),
      sleep(Math.max(1, deadline - Date.now())).then(() => ({ timeout: true })),
    ]);
    if (result.timeout) throw new Error("IMAP read timeout");
    if (result.done) throw new Error("IMAP socket closed");
    this.buffer += this.decoder.decode(result.value, { stream: true });
  }
}

function parseListLine(line) {
  if (!/^\*\s+LIST/i.test(line)) return null;
  const quoted = [...line.matchAll(/"((?:\\.|[^"])*)"/g)].map((m) => m[1].replace(/\\"/g, '"'));
  if (quoted.length) return quoted[quoted.length - 1];
  const parts = line.trim().split(/\s+/);
  return parts[parts.length - 1] || null;
}

function pickFolders(names) {
  const all = new Set(["INBOX"]);
  for (const name of names) {
    const lower = name.toLowerCase();
    if (lower === "inbox") all.add(name);
    if (lower.includes("junk") || lower.includes("spam") || lower.includes("垃圾") || lower.includes("迷惑")) {
      all.add(name);
    }
  }
  all.add("Junk Email");
  return [...all].filter(Boolean);
}

function parseFetchedMessage(response, folder, uid) {
  const internalDateRaw = response.match(/INTERNALDATE\s+"([^"]+)"/i)?.[1] || "";
  const internalDate = internalDateRaw ? new Date(internalDateRaw) : null;
  const raw = stripImapFetchEnvelope(response);
  const headers = raw.split(/\r?\n\r?\n/)[0] || "";
  const subject = decodeMimeWords(unfoldHeader(headers.match(/^Subject:\s*(.+)$/im)?.[1] || ""));
  const from = decodeMimeWords(unfoldHeader(headers.match(/^From:\s*(.+)$/im)?.[1] || ""));
  const dateHeader = headers.match(/^Date:\s*(.+)$/im)?.[1] || "";
  const date = parseDate(dateHeader) || parseDate(internalDateRaw) || internalDate;
  const text = decodeMessageText(raw);
  const snippet = compact(text).slice(0, 180);

  return {
    uid,
    folder,
    from,
    subject,
    date,
    text,
    snippet,
    codes: [],
  };
}

function stripImapFetchEnvelope(response) {
  const literal = response.match(/\{(\d+)\}\r?\n([\s\S]*)\r?\nA\d+\s+OK/i);
  if (literal) return literal[2].replace(/\r?\n\)\s*$/, "");
  return response;
}

function decodeMessageText(raw) {
  let text = raw;
  text = decodeQuotedPrintable(text);
  text = decodeBase64MimeSections(text);
  text = stripHtml(text);
  return text;
}

function extractCodes(text, digits) {
  const re = new RegExp(`(?<!\\d)(\\d{${digits}})(?!\\d)`, "g");
  const blocked = new Set(["000000", "111111", "123456", "654321"]);
  const codes = [];
  for (const match of text.matchAll(re)) {
    const code = match[1];
    if (blocked.has(code)) continue;
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

function containsKeywords(parsed, keywords) {
  const haystack = `${parsed.from}\n${parsed.subject}\n${parsed.text}`.toLowerCase();
  return keywords
    .split(/[,\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .every((item) => haystack.includes(item));
}

function decodeQuotedPrintable(input) {
  return input
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeBase64MimeSections(input) {
  return input.replace(
    /Content-Transfer-Encoding:\s*base64[\s\S]*?\r?\n\r?\n([A-Za-z0-9+/=\r\n]{40,})/gi,
    (_, body) => {
      try {
        const clean = body.replace(/[^A-Za-z0-9+/=]/g, "");
        return atobUtf8(clean);
      } catch {
        return body;
      }
    },
  );
}

function decodeMimeWords(input) {
  return input.replace(/=\?([^?]+)\?([BQ])\?([^?]+)\?=/gi, (_, charset, encoding, data) => {
    try {
      if (encoding.toUpperCase() === "B") {
        return atobUtf8(data);
      }
      return decodeQuotedPrintable(data.replace(/_/g, " "));
    } catch {
      return data;
    }
  });
}

function unfoldHeader(value) {
  return String(value || "").replace(/\r?\n[\t ]+/g, " ").trim();
}

function stripHtml(input) {
  return input
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function parseDate(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time) : null;
}

function quoteImap(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function formatImapDate(date) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${date.getUTCDate()}-${months[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

function btoaUtf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function atobUtf8(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function compact(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function trimLog(value) {
  return compact(value).slice(0, 500);
}

function clampInt(value, min, max, fallback) {
  const num = Number.parseInt(value, 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function badRequest(code, message) {
  const error = new Error(message);
  error.status = 400;
  error.code = code;
  return error;
}

function json(data, status = 200) {
  return withCors(
    new Response(JSON.stringify(data, null, 2), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
  );
}

function htmlResponse(html) {
  return withCors(
    new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
  );
}

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

const APP_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>IMAP 验证码接收器</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f5f5f5; color: #111827; }
    .wrap { max-width: 1160px; margin: 0 auto; padding: 32px 20px 60px; }
    h1 { margin: 0 0 8px; font-size: 30px; }
    h2 { margin: 0 0 14px; font-size: 20px; }
    p { color: #4b5563; line-height: 1.6; }
    .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 14px; box-shadow: 0 2px 8px #0000000f; padding: 22px; margin-top: 18px; }
    label { display: block; font-weight: 700; margin: 12px 0 8px; }
    input, textarea, select { width: 100%; box-sizing: border-box; border: 1px solid #d1d5db; border-radius: 10px; padding: 12px 14px; font: inherit; background: #fff; }
    textarea { min-height: 140px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    button { border: 1px solid #d1d5db; background: #fff; border-radius: 10px; padding: 11px 16px; font-weight: 700; cursor: pointer; }
    button.primary { background: #0b74de; color: #fff; border-color: #0b74de; }
    button.danger { color: #dc2626; }
    button:disabled { opacity: .55; cursor: not-allowed; }
    .row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
    .muted { color: #6b7280; }
    .ok { color: #059669; font-weight: 700; }
    .bad { color: #dc2626; font-weight: 700; }
    .code { font-size: 34px; font-weight: 800; letter-spacing: 3px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid #e5e7eb; text-align: left; padding: 12px 8px; vertical-align: top; }
    th { white-space: nowrap; }
    .mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    .log { background: #f8fafc; color: #111827; border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; min-height: 70px; line-height: 1.7; }
    .log pre { white-space: pre-wrap; background: #111827; color: #e5e7eb; border-radius: 10px; padding: 12px; overflow: auto; max-height: 220px; }
    .status-title { font-size: 18px; font-weight: 800; margin-bottom: 6px; }
    .status-ok { color: #059669; }
    .status-warn { color: #d97706; }
    .status-bad { color: #dc2626; }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; background: #eef2ff; color: #3730a3; font-size: 13px; font-weight: 700; margin: 0 6px 6px 0; }
    details { margin-top: 10px; }
    summary { cursor: pointer; color: #4b5563; font-weight: 700; }
    @media (max-width: 800px) { .row { grid-template-columns: 1fr; } table { display: block; overflow-x: auto; } }
  </style>
</head>
<body>
  <main class="wrap">
    <h1>IMAP 验证码接收器</h1>
    <p>导入 <span class="mono">email----password----client_id----refresh_token</span>。账号只保存在当前浏览器 localStorage，不会写入 Cloudflare。</p>

    <section class="card">
      <h2>导入邮箱</h2>
      <textarea id="importText" placeholder="account@hotmail.com----password----client_id----refresh_token"></textarea>
      <div class="actions">
        <button class="primary" id="importBtn">导入</button>
        <button id="clearBtn">清空本地账号</button>
      </div>
      <p class="muted" id="summary">未导入账号。</p>
    </section>

    <section class="card">
      <h2>取码</h2>
      <label>邮箱</label>
      <select id="accountSelect"></select>
      <div class="actions">
        <button class="primary" id="fetchBtn">取码</button>
        <button id="copyBtn">复制验证码</button>
      </div>
      <p>结果：<span class="code" id="code">-</span></p>
      <div class="log" id="log">等待操作。</div>
    </section>

    <section class="card">
      <h2>账号列表</h2>
      <table>
        <thead>
          <tr>
            <th>邮箱</th>
            <th>密码</th>
            <th>Client ID</th>
            <th>Refresh Token</th>
            <th>最近验证码</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody id="tbody"></tbody>
      </table>
    </section>
  </main>

  <script>
    const ACCOUNT_KEY = "imap-code-receiver:accounts:v1";
    const state = {
      accounts: JSON.parse(localStorage.getItem(ACCOUNT_KEY) || "[]"),
      lastCode: "",
    };

    const $ = (id) => document.getElementById(id);

    function save() {
      localStorage.setItem(ACCOUNT_KEY, JSON.stringify(state.accounts));
      render();
    }

    function mask(value, keep = 4) {
      value = String(value || "");
      if (!value) return "-";
      if (value.length <= keep * 2) return "••••••";
      return value.slice(0, keep) + "…" + value.slice(-keep);
    }

    function parseLine(line) {
      const raw = line.trim();
      if (!raw) return null;
      let sep = "----";
      let parts = raw.split(sep);
      if (parts.length < 4) { sep = "|"; parts = raw.split(sep); }
      if (parts.length < 4) { sep = ","; parts = raw.split(sep); }
      if (parts.length < 4) { sep = " "; parts = raw.split(/\\s+/); }
      if (parts.length < 4) throw new Error("格式错误：" + raw.slice(0, 80));
      return {
        email: parts[0].trim(),
        password: parts[1].trim(),
        clientId: parts[2].trim(),
        refreshToken: parts.slice(3).join(sep === " " ? "" : sep).trim(),
        lastCode: "",
        lastAt: "",
      };
    }

    function render() {
      const select = $("accountSelect");
      select.innerHTML = "";
      for (const account of state.accounts) {
        const option = document.createElement("option");
        option.value = account.email;
        option.textContent = account.email;
        select.appendChild(option);
      }

      $("summary").textContent = "本地已保存 " + state.accounts.length + " 个邮箱。";
      $("fetchBtn").disabled = state.accounts.length === 0;

      const tbody = $("tbody");
      tbody.innerHTML = "";
      for (const account of state.accounts) {
        const tr = document.createElement("tr");
        tr.innerHTML =
          "<td><b>" + escapeHtml(account.email) + "</b></td>" +
          "<td class='mono'>" + mask(account.password) + "</td>" +
          "<td class='mono'>" + mask(account.clientId, 8) + "</td>" +
          "<td class='mono'>" + mask(account.refreshToken, 8) + "</td>" +
          "<td>" + (account.lastCode ? "<b class='ok'>" + account.lastCode + "</b><br><span class='muted'>" + account.lastAt + "</span>" : "-") + "</td>" +
          "<td><button data-email='" + escapeHtml(account.email) + "'>删除</button></td>";
        tbody.appendChild(tr);
      }
      tbody.querySelectorAll("button").forEach((btn) => {
        btn.onclick = () => {
          state.accounts = state.accounts.filter((item) => item.email !== btn.dataset.email);
          save();
        };
      });
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    }

    function log(value) {
      $("log").textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    }

    function logHtml(html) {
      $("log").innerHTML = html;
    }

    function renderOtpResult(data) {
      if (data.code) {
        const folders = renderFolderPills(data.folders);
        const messages = renderMessageList(data.messages);
        logHtml(
          "<div class='status-title status-ok'>已找到验证码</div>" +
          "<div>验证码：<b class='code'>" + escapeHtml(data.code) + "</b></div>" +
          "<div class='muted'>已读取邮箱，命中文章来自最近邮件。</div>" +
          folders +
          messages +
          renderRawDetails(data)
        );
        return;
      }

      const folders = renderFolderPills(data.folders);
      const messages = renderMessageList(data.messages);
      const readCount = Array.isArray(data.messages) ? data.messages.length : 0;
      logHtml(
        "<div class='status-title status-warn'>未找到验证码</div>" +
        "<div>邮箱连接正常，但最近 30 分钟内没有识别到 6 位验证码。</div>" +
        "<div class='muted'>已读取 " + readCount + " 封候选邮件。可以确认验证码邮件是否已送达，或重新发送后再点取码。</div>" +
        folders +
        messages +
        renderRawDetails(data)
      );
    }

    function renderFetchError(error) {
      logHtml(
        "<div class='status-title status-bad'>取码失败</div>" +
        "<div>" + escapeHtml(error.message || String(error)) + "</div>"
      );
    }

    function renderFolderPills(folders) {
      if (!Array.isArray(folders) || !folders.length) return "";
      return "<div style='margin-top:10px'>" + folders.map((item) => {
        const label = item.skipped
          ? item.folder + "：跳过"
          : item.folder + "：" + (item.exists || 0) + " 封";
        return "<span class='pill'>" + escapeHtml(label) + "</span>";
      }).join("") + "</div>";
    }

    function renderMessageList(messages) {
      if (!Array.isArray(messages) || !messages.length) return "<div class='muted' style='margin-top:8px'>没有候选邮件。</div>";
      const rows = messages.slice(0, 5).map((item) => {
        const title = item.subject || "(无主题)";
        const date = item.date ? new Date(item.date).toLocaleString() : "-";
        const codes = item.codes && item.codes.length ? "，验证码 " + item.codes.join(", ") : "";
        return "<li><b>" + escapeHtml(title) + "</b><br><span class='muted'>" + escapeHtml(item.folder || "-") + " · " + escapeHtml(date) + codes + "</span></li>";
      }).join("");
      return "<ul style='margin:10px 0 0 20px;padding:0'>" + rows + "</ul>";
    }

    function renderRawDetails(data) {
      return "<details><summary>查看原始响应</summary><pre>" + escapeHtml(JSON.stringify(data, null, 2)) + "</pre></details>";
    }

    $("importBtn").onclick = () => {
      try {
        const lines = $("importText").value.split(/\\r?\\n/).filter((line) => line.trim());
        const imported = lines.map(parseLine);
        const map = new Map(state.accounts.map((item) => [item.email.toLowerCase(), item]));
        for (const account of imported) map.set(account.email.toLowerCase(), { ...map.get(account.email.toLowerCase()), ...account });
        state.accounts = [...map.values()];
        $("importText").value = "";
        save();
        log("导入完成：" + imported.length + " 个。");
      } catch (error) {
        log("导入失败：" + error.message);
      }
    };

    $("clearBtn").onclick = () => {
      if (!confirm("清空当前浏览器保存的邮箱？")) return;
      state.accounts = [];
      save();
    };

    $("fetchBtn").onclick = async () => {
      const account = state.accounts.find((item) => item.email === $("accountSelect").value);
      if (!account) return log("请选择邮箱。");

      $("fetchBtn").disabled = true;
      $("code").textContent = "-";
      log("正在刷新 OAuth token，并读取 INBOX / Junk Email。");
      try {
        const response = await fetch("/api/otp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            account,
          }),
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.detail || data.error || "取码失败");
        if (data.code) {
          $("code").textContent = data.code;
          state.lastCode = data.code;
          account.lastCode = data.code;
          account.lastAt = new Date().toLocaleString();
          save();
        } else {
          $("code").textContent = "-";
        }
        renderOtpResult(data);
      } catch (error) {
        renderFetchError(error);
      } finally {
        $("fetchBtn").disabled = state.accounts.length === 0;
      }
    };

    $("copyBtn").onclick = async () => {
      if (!state.lastCode) return;
      await navigator.clipboard.writeText(state.lastCode);
    };

    render();
  </script>
</body>
</html>`;
