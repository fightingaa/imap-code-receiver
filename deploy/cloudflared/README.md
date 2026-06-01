# Cloudflare Tunnel 搭建文档

目标：

```text
https://imap.yourdomain.com
        ↓
Cloudflare Tunnel
        ↓
imap-code-receiver
        ↓
Outlook IMAP 取验证码
```

适合只做验证码读取。

Cloudflare 免费用户可以用。

## 准备

需要：

- 一个已经接入 Cloudflare 的域名
- 一台能长期运行的机器
  - VPS
  - 家里电脑
  - Windows 服务器
  - Linux 服务器
- Docker 和 Docker Compose
- 本项目目录：`imap-code-receiver`

不要把真实 `imap_ok.txt`、`.env`、`data/accounts.json` 提交到 GitHub。

## 方式一：Docker Compose + Tunnel Token

推荐这个。

### 1. 创建 Cloudflare Tunnel

打开 Cloudflare 控制台：

```text
https://one.dash.cloudflare.com/
```

进入：

```text
Zero Trust -> Networks -> Tunnels
```

点击：

```text
Create a tunnel
```

选择：

```text
Cloudflared
```

Tunnel 名字填：

```text
imap-code
```

创建后，Cloudflare 会让你选择运行方式。

选择 Docker。

它会给你一条类似这样的命令：

```bash
docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token eyJhIjoi...xxx
```

复制里面 `--token` 后面的整段 token。

### 2. 添加 Public Hostname

在 Tunnel 页面里点：

```text
Public Hostname -> Add a public hostname
```

填写：

```text
Subdomain: imap
Domain: yourdomain.com
Path: 留空
Type: HTTP
URL: imap-code-receiver:8787
```

保存。

最后访问地址会是：

```text
https://imap.yourdomain.com
```

### 3. 配置项目环境变量

进入项目目录：

```bash
cd imap-code-receiver
```

复制模板：

```bash
cp .env.tunnel.example .env
```

Windows PowerShell：

```powershell
Copy-Item .env.tunnel.example .env
```

编辑 `.env`：

```text
ADMIN_TOKEN=换成一个随机长字符串
CLOUDFLARE_TUNNEL_TOKEN=粘贴 Cloudflare 给你的 tunnel token
```

示例：

```text
ADMIN_TOKEN=8df8f65d2f6a4e7ea3f8d44c0dd0b9a9
CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoixxxxxxxxxxxxxxxx"
```

`ADMIN_TOKEN` 是网页访问密钥。

别人打开页面后，要在“访问 Token”里填它。

### 4. 启动服务

```bash
docker compose up -d --build
```

查看运行状态：

```bash
docker compose ps
```

正常会看到两个容器：

```text
imap-code-receiver
imap-code-tunnel
```

### 5. 看日志

全部日志：

```bash
docker compose logs -f
```

只看取码服务：

```bash
docker compose logs -f imap-code-receiver
```

只看 Cloudflare Tunnel：

```bash
docker compose logs -f cloudflared
```

看到类似内容就说明 Tunnel 连上了：

```text
Registered tunnel connection
```

### 6. 访问页面

打开：

```text
https://imap.yourdomain.com
```

页面上填：

```text
访问 Token = ADMIN_TOKEN
```

然后导入邮箱：

```text
email----password----client_id----refresh_token
```

点击取码。

## 方式二：本机先测试

不接 Cloudflare，先确认服务能跑。

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

如果本地能正常导入和取码，再上 Tunnel。

## 方式三：不用 Docker 跑服务，只用 cloudflared 暴露

如果你已经用 `npm start` 跑了服务：

```text
http://127.0.0.1:8787
```

那 Cloudflare Public Hostname 的 URL 填：

```text
http://127.0.0.1:8787
```

然后在机器上安装 cloudflared。

登录：

```bash
cloudflared tunnel login
```

创建 Tunnel：

```bash
cloudflared tunnel create imap-code
```

配置 DNS：

```bash
cloudflared tunnel route dns imap-code imap.yourdomain.com
```

创建配置文件：

Linux：

```text
~/.cloudflared/config.yml
```

Windows：

```text
C:\Users\你的用户名\.cloudflared\config.yml
```

内容：

```yaml
tunnel: imap-code
credentials-file: /root/.cloudflared/imap-code.json

ingress:
  - hostname: imap.yourdomain.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

启动：

```bash
cloudflared tunnel run imap-code
```

这个方式适合调试。

长期运行更推荐 Docker Compose。

## 更新服务

```bash
cd imap-code-receiver
git pull
docker compose up -d --build
```

## 停止服务

```bash
docker compose down
```

## 重启服务

```bash
docker compose restart
```

## 数据位置

账号池保存在：

```text
imap-code-receiver/data/accounts.json
```

只要不删 `data/`，重启不会丢。

## 备份数据

```bash
cp data/accounts.json accounts.backup.json
```

恢复：

```bash
cp accounts.backup.json data/accounts.json
docker compose restart imap-code-receiver
```

## 建议加 Cloudflare Access

如果这个页面要给别人用，建议再加一层 Cloudflare Access。

路径：

```text
Zero Trust -> Access -> Applications -> Add an application -> Self-hosted
```

填写：

```text
Application name: imap-code
Application domain: imap.yourdomain.com
```

Policy 示例：

```text
Allow -> Emails -> 你的邮箱 / 允许访问的人
```

这样访问页面前，Cloudflare 会先要求登录。

页面里面仍然保留 `ADMIN_TOKEN`。

## 常见问题

### 1. 访问 502

先看容器：

```bash
docker compose ps
```

再看日志：

```bash
docker compose logs -f
```

如果 `imap-code-receiver` 没起来，先修 Node 服务。

如果 `cloudflared` 没连上，检查 `CLOUDFLARE_TUNNEL_TOKEN`。

### 2. Cloudflare 页面显示服务不可达

Docker Compose 模式下，Public Hostname URL 必须是：

```text
http://imap-code-receiver:8787
```

不是：

```text
http://127.0.0.1:8787
```

因为 cloudflared 在容器里。

容器里的 `127.0.0.1` 指的是 cloudflared 自己，不是取码服务。

### 3. 页面提示 unauthorized

说明 `ADMIN_TOKEN` 没填对。

检查 `.env`：

```text
ADMIN_TOKEN=xxx
```

页面“访问 Token”也要填 `xxx`。

### 4. 导入成功但取不到验证码

检查：

- 邮件是否真的到了
- 是否在 Junk / Spam
- 关键词是否太严格
- `sinceMinutes` 是否太短
- refresh_token 是否有效

可以先把关键词留空，只按 6 位数字取。

### 5. Outlook IMAP 登录失败

常见原因：

- refresh_token 过期
- client_id 不匹配
- 账号被风控
- Microsoft 临时拒绝 IMAP OAuth

换一条邮箱记录测试。

## 最小安全要求

必须做：

```text
ADMIN_TOKEN=随机长字符串
```

不要做：

```text
ADMIN_TOKEN=123456
ADMIN_TOKEN=password
ADMIN_TOKEN=admin
```

不要公开：

```text
imap_ok.txt
.env
data/accounts.json
```
