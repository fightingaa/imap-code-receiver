# IMAP Code Receiver

导入这种格式的邮箱：

```text
email----password----client_id----refresh_token
```

然后用 Microsoft Outlook IMAP OAuth2 读取验证码邮件。

这个项目适合单独开 GitHub 仓库。

注意：GitHub Pages 不能部署这个服务。它需要后端刷新 access_token 并连接 IMAP。

现在提供两种部署：

- Cloudflare Workers：不用 Tunnel，不用 Zero Trust，不需要绑卡。账号保存在浏览器 localStorage。
- Node/Docker：账号保存在服务端 JSON 文件。

## 功能

- 批量导入 `imap_ok.txt` 格式账号
- 本地 JSON 存储账号池
- Outlook / Hotmail / Live OAuth2 refresh_token 换 access_token
- IMAP 读取 Inbox / Junk Email / Junk / Spam
- 按关键词筛选验证码邮件
- 取码一次，不做后台轮询
- 可设置 `ADMIN_TOKEN` 做简单访问保护

## Cloudflare Workers 部署

这个方式对应 Cloudflare Dashboard 里的 `Workers & Pages`。

不走 Tunnel。

不需要 Zero Trust。

不需要在 Cloudflare 端保存邮箱账号。

### 1. 推送到 GitHub

已经推送过可以跳过。

```bash
git add .
git commit -m "add cloudflare worker version"
git push
```

### 2. 在 Cloudflare 创建 Worker

进入：

```text
Workers & Pages -> Create application -> Import a repository
```

选择仓库：

```text
fightingaa/imap-code-receiver
```

构建配置：

```text
Framework preset: None
Build command: npm install
Deploy command: npx wrangler deploy
Root directory: /
```

部署后会得到：

```text
https://imap-code-receiver.<你的 workers.dev 子域>.workers.dev
```

### 3. 可选：设置访问口令

如果要保护接口：

```text
Worker -> Settings -> Variables and Secrets -> Add
```

添加：

```text
ADMIN_TOKEN=一串随机字符串
```

页面里 `ADMIN_TOKEN` 输入框也填同一个。

不设置也能用，但公开地址任何人都能调用接口。

### 4. 使用

打开 Worker 地址。

导入：

```text
email----password----client_id----refresh_token
```

点击取码。

Worker 会实时：

```text
refresh_token -> access_token -> IMAP XOAUTH2 -> INBOX/Junk Email -> 提取验证码
```

账号只在当前浏览器保存。

## 启动

```bash
cd imap-code-receiver
npm install
cp .env.example .env
npm start
```

打开：

```text
http://127.0.0.1:8787
```

如果 `.env` 里设置了：

```text
ADMIN_TOKEN=change-me
```

前端页面的“访问 Token”也要填同一个值。

## 导入格式

支持：

```text
account@hotmail.com----password----client_id----refresh_token
```

也兼容：

```text
account@hotmail.com|password|client_id|refresh_token
account@hotmail.com,password,client_id,refresh_token
account@hotmail.com password client_id refresh_token
```

当前项目按你现有 `imap_ok.txt` 的顺序处理：

```text
email----password----client_id----refresh_token
```

不要把真实 `imap_ok.txt` 提交到 GitHub。

## API

### 导入账号

```bash
curl -X POST http://127.0.0.1:8787/api/accounts/import \
  -H "content-type: application/json" \
  -H "x-admin-token: change-me" \
  -d '{"text":"a@hotmail.com----pass----client_id----refresh_token"}'
```

### 列出账号

```bash
curl http://127.0.0.1:8787/api/accounts \
  -H "x-admin-token: change-me"
```

### 取验证码

```bash
curl -X POST http://127.0.0.1:8787/api/otp \
  -H "content-type: application/json" \
  -H "x-admin-token: change-me" \
  -d '{"email":"a@hotmail.com","keywords":"openai verification","digits":6,"sinceMinutes":30}'
```

## 部署到 GitHub + Docker 主机

```bash
# 1. 新建 GitHub 仓库，把 imap-code-receiver 目录内容提交上去
cd imap-code-receiver
git init
git add .
git commit -m "init imap code receiver"
git branch -M main
git remote add origin git@github.com:YOUR_NAME/imap-code-receiver.git
git push -u origin main

# 2. 服务器拉代码
 git clone git@github.com:YOUR_NAME/imap-code-receiver.git
 cd imap-code-receiver

# 3. Docker 运行
 docker build -t imap-code-receiver .
 docker run -d \
   --name imap-code-receiver \
   -p 8787:8787 \
   -e ADMIN_TOKEN='change-me' \
   -e DATA_DIR='/app/data' \
   -v $(pwd)/data:/app/data \
   imap-code-receiver
```

## Cloudflare Tunnel 部署

如果 Zero Trust 能正常开通，也可以用 Docker Compose + Cloudflare Tunnel。

如果 Free 计划要求绑卡且绑卡失败，就不要走这条。

先在 Cloudflare 创建 Tunnel：

```text
Zero Trust -> Networks -> Tunnels -> Create a tunnel -> Cloudflared
```

Public Hostname 配置：

```text
Subdomain: imap
Domain: yourdomain.com
Type: HTTP
URL: http://imap-code-receiver:8787
```

复制环境变量模板：

```bash
cp .env.tunnel.example .env
```

修改 `.env`：

```text
ADMIN_TOKEN=一个随机长字符串
CLOUDFLARE_TUNNEL_TOKEN=Cloudflare 给你的 tunnel token
```

启动：

```bash
docker compose up -d --build
```

访问：

```text
https://imap.yourdomain.com
```

页面里的“访问 Token”填写 `ADMIN_TOKEN`。

详细说明见：

```text
deploy/cloudflared/README.md
```

## 部署到 Render / Railway

配置：

```text
Build Command: npm install
Start Command: npm start
Environment:
  ADMIN_TOKEN=一个随机长字符串
  DATA_DIR=/data
```

如果平台支持持久卷，把 `/data` 挂成持久目录。

## 安全边界

- `refresh_token` 等同邮箱长期访问凭据。
- 不要把导入文件提交到仓库。
- 公开部署必须设置 `ADMIN_TOKEN`。
- 多人共用时，建议每个人单独部署一份。
- 如果要做真正多用户，需要加登录、权限隔离和数据库加密。
