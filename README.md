# IMAP Code Receiver

导入这种格式的邮箱：

```text
email----password----client_id----refresh_token
```

然后用 Microsoft Outlook IMAP OAuth2 读取验证码邮件。

这个项目适合单独开 GitHub 仓库。

注意：GitHub Pages 不能部署这个服务。它需要服务端去刷新 access_token 和连接 IMAP。可以部署到 VPS、Docker、Render、Railway、Fly.io、Zeabur、Vercel Serverless 以外的常驻 Node 服务。

## 功能

- 批量导入 `imap_ok.txt` 格式账号
- 本地 JSON 存储账号池
- Outlook / Hotmail / Live OAuth2 refresh_token 换 access_token
- IMAP 读取 Inbox / Junk Email / Junk / Spam
- 按关键词筛选验证码邮件
- 取码一次，不做后台轮询
- 可设置 `ADMIN_TOKEN` 做简单访问保护

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

推荐用 Docker Compose + Cloudflare Tunnel。

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
