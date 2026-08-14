# Big File Upload

面向 PC 的大文件分片上传应用。生产运行时已从 Render/Fastify 迁移到 Cloudflare Workers：Hono 提供控制 API，Workers Static Assets 同源托管 React 前端，Durable Objects 保存会话/OTP/频控临时状态，Cron Trigger 每小时清理过期 multipart。

Turso 数据库和 Cloudflare R2 桶原位保留。上传分片仍由浏览器通过 S3 预签名 URL 直传 R2，文件字节不经过 Worker。

## 架构

```text
浏览器 ── /api/* ──> Cloudflare Worker (Hono) ──> Turso
   │                         │
   │                         ├── Durable Objects（会话/OTP/频控）
   │                         └── Resend
   └── 预签名分片 PUT ─────────────> 原 Cloudflare R2 桶

React 静态资源 ──> Workers Static Assets
每小时清理 ──────> Worker Cron Trigger
```

## 本地验证

要求 Node.js 22+。

```bash
npm install
npm run typecheck
npm test
npm run build
```

启动完整 Worker 预览前，复制 `.dev.vars.example` 为 `.dev.vars` 并填写现有 Turso、R2、Resend 凭据：

```bash
cp .dev.vars.example .dev.vars
npm run dev
```

Wrangler 默认在 `http://localhost:8787` 提供 API 和前端。若只运行 Vite，开发代理也默认指向该端口。

## Cloudflare 配置

非敏感变量、Static Assets、Durable Object migration 和 Cron 已写入 `wrangler.jsonc`。首次部署前交互式写入 secrets：

```bash
npx wrangler secret put COOKIE_SECRET
npx wrangler secret put OTP_PEPPER
npx wrangler secret put DATABASE_URL
npx wrangler secret put DATABASE_AUTH_TOKEN
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put MAIL_FROM
npx wrangler secret put R2_ENDPOINT
npx wrangler secret put R2_BUCKET
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

数据库继续使用原 Turso 地址和 Token，R2 继续使用原 bucket 和 S3 API Token。不要导出、复制或重建业务数据。

更新 `infra/r2-cors.json` 中的 workers.dev 子域名和正式域名后，把规则应用到原 R2 bucket。过渡期可同时保留两个 HTTPS 来源，上线稳定后再收紧。

## 构建与部署检查

```bash
npm run cf:types
npm run cf:dry-run
npm run cf:startup
```

确认检查通过后执行：

```bash
npx wrangler deploy
```

部署到 workers.dev 后按 `cloudflare-migration-plan.md` 第 9 节完成 OTP、分片直传、续传、秒传、预览、Range 下载和 Cron 冒烟测试，再绑定自定义域名。Render 服务在正式域名验证完成前保持运行；`render.yaml` 仅作为回滚配置保留。

## 维护命令

`npm run migrate` 和 `npm run cleanup` 是 Node 维护脚本，读取仓库根目录 `.env`。Worker 的每小时清理由 Cron 自动执行，一般无需手动运行 cleanup。

## 安全边界

- Cookie 使用 Hono WebCrypto 签名；迁移切换后旧 Render Cookie 会失效，用户需重新登录一次。
- OTP、Session、频控和秒传挑战均为带 TTL 的临时数据，不从 Redis 迁移。
- 允许 JPEG、PNG、GIF、WebP、MP4、WebM、MP3、WAV、OGG、FLAC、M4A、PDF 和纯文本；服务端仍以内容检测为最终裁决。
- 抽样指纹只用于续传和同用户秒传候选匹配，不作为完整性或安全证明。
