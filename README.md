# Big File Upload

一个面向 PC 的大文件分片上传应用。前端使用 React + Vite，后端使用 Fastify。生产环境由浏览器通过预签名 URL 直接上传到 Cloudflare R2；本地开发使用文件系统模拟 multipart，因此不需要任何云服务账号。

## 功能

- 邮箱验证码登录，包含 TTL、发送冷却、IP/邮箱频控和一次性消费
- PC 拖拽或点击选择多个文件
- Web Worker 抽样 MD5，避免阻塞主线程
- 动态分片规划和 AIMD 并发调节
- XHR 实时字节进度、速度、ETA、暂停、继续、取消和重试
- IndexedDB 与服务端活跃会话共同保存恢复信息；刷新、清除本地数据或换浏览器后重新选择原文件即可续传
- 同一用户内秒传候选匹配
- 图片、视频、音频、PDF、TXT 内容检测和安全预览
- R2 multipart、Turso、Redis、Nodemailer 生产适配器
- 24 小时孤儿 multipart 清理和 Render Cron
- Pino JSON 日志与健康检查

## 本地启动

```bash
cp .env.example .env
npm install
npm run migrate
npm run dev
```

打开 `http://localhost:5173`。开发模式使用 `MAIL_DRIVER=console`，验证码会输出到 API 终端。数据写入 `.data/`。

也可以先执行：

```bash
npm run typecheck
npm test
npm run build
```

## 架构

```text
浏览器 ── 控制 API ──> Fastify ──> Redis / Turso
   │                       │
   └── 预签名分片 PUT ─────┴────> Cloudflare R2
```

生产上传字节不经过 Node，避免 Render 服务成为带宽和内存瓶颈。Node 负责认证、创建 multipart、签名、状态机、合并、Range 内容检测和预览授权。

本地 `LocalStorageProvider` 通过受 HMAC 保护的临时 URL 接收分片，并以流式方式合并文件，用同一套上传协议覆盖主流程。

## 文件类型与安全边界

允许 JPEG、PNG、GIF、WebP、MP4、WebM、MP3、WAV、OGG、FLAC、M4A、PDF 和纯文本。SVG、HTML/XML、归档、可执行文件及无法识别的内容默认拒绝。

服务端以内容签名为最终裁决，不信任扩展名和浏览器声明的 MIME。TXT 没有可靠 magic bytes，项目会检查多个 Range 的编码、NUL 和控制字符比例；这是启发式分类，不等同于完整文件扫描、病毒检测或内容审核。

抽样 MD5 只用于续传和秒传候选查找，不是强完整性证明。默认秒传仅限同一用户。若业务要求零碰撞或跨用户物理去重，应改为完整 SHA-256。

## 生产配置

复制 `.env.example` 的配置到 Render：

- `APP_ORIGIN`
- `COOKIE_SECRET`、`OTP_PEPPER`
- Turso：`DATABASE_URL`、`DATABASE_AUTH_TOKEN`
- Render Key Value：`REDIS_URL`
- R2：`R2_ENDPOINT`、`R2_BUCKET`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`
- 邮件：`MAIL_DRIVER=resend`、`RESEND_API_KEY`、`MAIL_FROM`

Render 免费实例会限制常见 SMTP 出站端口，因此生产 Blueprint 默认通过 Resend HTTPS API 发信。`MAIL_FROM` 必须使用 Resend 已验证域名下的发件地址；未验证域名时可按 Resend 控制台的测试规则配置。API Token 只填写到 Render 环境变量，不要提交到仓库。SMTP 驱动仍保留用于允许 SMTP 出站的其它环境。

使用 `render.yaml` 创建 Web Service、Key Value 和每小时清理 Cron。将 `infra/r2-cors.json` 中的域名替换为真实 Render 域名，并在 R2 上配置 1 天后中止未完成 multipart 的生命周期规则。

## 关键限制

- 浏览器刷新后通常不能继续访问原始 `File`，因此需要用户重新选择同一文件再恢复。
- multipart 的恢复粒度是完整 part，不支持 part 内字节续传。
- 视频/音频是否可播放仍受浏览器 codec 支持影响。
- 没有真实 R2/Turso/Redis/Resend 凭据时，只能验证完整本地主流程，不能声称云端合约已经通过。
