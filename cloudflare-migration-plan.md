# 迁移方案：Render → Cloudflare Workers

> 状态：评估完成，待评审
> 目标部署形态：Cloudflare Worker（Hono） + Workers Static Assets + Cron Trigger，替换 Render Web Service / Key Value / Cron
> 数据策略：**Turso 数据库与 R2 文件原位保留，零迁移、零拷贝**；仅替换临时 KV（会话/OTP/频控）

---

## 1. 背景与目标

当前项目部署在 Render，存在两个痛点：

| 痛点 | 现状 | 迁移后 |
|---|---|---|
| 冷启动时间过长 | Render 免费实例闲置约 15 分钟后休眠，首次请求需等待实例启动（可达数十秒） | Worker 冷启动毫秒级；静态资源走边缘缓存，近似零延迟 |
| 无法使用自定义域名 | Render 免费套餐不支持自定义域名 | Cloudflare 自定义域名免费、即时生效、自动 TLS |

本次迁移的目标：

1. 解决上述两个痛点；
2. **业务数据（Turso + R2）保持原有数据，不做迁移**；
3. 保持"浏览器直传 R2，字节不经过服务器"的带宽架构不变；
4. 尽可能复用现有代码分层（`Database` / `KvStore` / `StorageProvider` / `Mailer` 接口），把改造面控制在适配层与路由层。

---

## 2. 现状架构盘点

```text
浏览器 ── 控制 API ──> Fastify (Render, Node 22) ──> Redis (Render Key Value) / Turso
   │                       │
   └── 预签名分片 PUT ─────┴────> Cloudflare R2 (S3 兼容 API, AWS SDK v3)
   │
   └── 静态资源 web/dist ──> 由 Fastify 直接托管
Render Cron (每小时) ──> 清理 24h 孤儿 multipart + 标记 DB 状态 EXPIRED
```

| 组件 | 当前实现 | 迁移友好度 | 说明 |
|---|---|---|---|
| API 框架 | Fastify 5（Node http 语义） | ★★☆☆☆ | 唯一需要较大改动的部分 |
| 数据库 | Turso（`@libsql/client`，libsql:// 协议，HTTPS） | ★★★★★ | Worker 原生可连，数据原位保留 |
| KV | Redis（`redis` npm 包，Render Key Value） | ★★★☆☆ | 需替换实现；数据全部为 TTL 临时数据，无需迁移 |
| 文件存储 | Cloudflare R2，AWS SDK v3 + presigner 预签名 | ★★★★★ | 已经是 Cloudflare 产品，原桶保留 |
| 邮件 | Resend（纯 HTTPS fetch）+ SMTP（nodemailer） | ★★★★☆ | Resend 直接可用；SMTP 驱动不迁移（生产本来就用 Resend） |
| 前端 | React + Vite，`web/dist` 由 Fastify 静态托管 | ★★★★☆ | 改为 Workers Static Assets 同源托管 |
| 定时任务 | Render Cron 每小时 | ★★★★☆ | 改为 Cloudflare Cron Triggers（免费） |

关键有利条件：项目从第一天起就把上传字节直连 R2、把业务逻辑抽到接口之后，**迁移本质上只是换一个 HTTP 运行时**。

---

## 3. 目标架构

```text
浏览器 ── /api/* ──> Cloudflare Worker (Hono) ──> Turso (原位，数据不变)
   │                        │
   │                        ├── Cloudflare KV / Durable Object（替换 Redis 的 6 个方法）
   │                        ├── Resend（发 OTP 邮件，不变）
   └── 预签名分片 PUT ──────┴────> Cloudflare R2（同桶，对象不变）

前端静态资源 ──> 同一 Worker 的 Static Assets（SPA 回退到 index.html）
清理任务 ──> 同一 Worker 的 Cron Trigger（每小时，替代 Render Cron）
自定义域名 ──> Worker 自定义域（免费，自动 TLS）
```

数据流关键路径（预签名分片上传）保持不变：`POST /api/uploads/prepare` 创建 multipart → `POST /api/uploads/:id/part-urls` 返回预签名 URL → 浏览器直传 R2 → `ack` → `complete`。

---

## 4. 数据与外部依赖策略（零迁移原则）

| 数据 | 策略 | 动作 | 迁移成本 |
|---|---|---|---|
| **Turso 数据库**（users/uploads/upload_parts/files） | **原位保留** | 无。同一 `DATABASE_URL` + `DATABASE_AUTH_TOKEN`，Worker 内改用 `@libsql/client/web`（HTTP 传输，官方支持，见 [Turso · Cloudflare Workers docs](https://developers.cloudflare.com/workers/databases/third-party-integrations/turso/)） | **零迁移、零停机、零拷贝** |
| **R2 对象**（`quarantine/*`） | **原位保留** | 无。同一 bucket、同一 API Token；预签名逻辑不变（Cloudflare 官方 aws-sdk-js-v3 示例同款模式，见 [R2 官方示例](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/)） | **零迁移** |
| Redis 里的会话/OTP/频控/秒传挑战 | **不迁移** | 全部为 TTL 临时数据，切换后用户重新登录一次即可 | 零迁移 |
| R2 bucket CORS 配置（`infra/r2-cors.json`） | 更新 | 允许来源从 Render 域名改为新域名（或 `*.workers.dev` 过渡，切换后再收紧为正式域名） | 5 分钟 |
| 邮件发件域名 | 保留 | Resend 已验证域名不变 | 零迁移 |
| **不推荐**迁移到 D1 | — | Turso 与 D1 同为 SQLite，可 `turso db shell ... .dump` 导出后 `wrangler d1` 导入，但没必要：Turso 在 Worker 上官方支持，且可避免数据拷贝与停机窗口 | — |

---

## 5. 技术选型决策

### 5.1 API 框架：Fastify → Hono

Fastify 绑定 Node `http.Server` 语义，无法直接运行在 Workers 的 fetch 模型上。两个选项：

| 选项 | 说明 | 结论 |
|---|---|---|
| **Hono（推荐）** | Workers 事实标准框架，`app.request()` 与现有测试的 `app.inject()` 几乎一一对应，中间件生态齐全 | ✅ 采用 |
| 保留 Fastify + nodejs_compat | 需要社区适配器（无官方支持），Node 兼容层引入额外 CPU 开销与打包不确定性 | ❌ 不采用 |

本项目 `app.ts` 仅 145 行、约 20 个路由，业务逻辑全部在接口之后，Hono 改写风险低。

### 5.2 KV 替换：Cloudflare KV / Durable Object / Turso 表

`KvStore` 接口（`apps/api/src/infrastructure/kv.ts`）只有 6 个方法：`get / set / setIfAbsent / delete / increment / close`，三种实现都只需写一个适配器：

| 方案 | 强一致 | 原子计数 | 免费额度 | 工作量 | 说明 |
|---|---|---|---|---|---|
| **Workers KV** | ❌ 最终一致（最长约 60s 传播） | ❌ 需读改写（有竞态） | 10 万读/天、**1000 写/天**、1000 删/天（[官方 limits](https://developers.cloudflare.com/kv/platform/limits/)） | ~40 行 | 最简；跨地域登录可能短暂掉会话；写入配额低 |
| **Durable Object（推荐）** | ✅ 单写者串行 | ✅ 天然无竞态 | 免费档已开放（2025 年起，具体配额以控制台为准） | ~80 行 | 会话/OTP 需要强一致与原子计数，DO 语义完全匹配 |
| **Turso 表** | ✅ | ✅（串行事务） | 随 Turso 免费额度 | ~60 行 + 清理逻辑 | 零新增依赖，但认证路径多一次 DB 往返（+30~80ms） |

**推荐：Durable Object 实现 KvStore**（`KvDurableObject`，见 §6.2）。若免费档 DO 配额不足或不可用，回退到 Workers KV（接受最终一致性与 1000 写/天配额，本应用量级通常够用）。

> 注意：会话/OTP 是**写多读多**的路径，KV 免费档 1000 写/天 对高频登录场景可能成为瓶颈，这是选 DO 的主要原因。

### 5.3 R2 操作方式：AWS SDK v3（保留） vs R2 Binding

| 方案 | 说明 | 结论 |
|---|---|---|
| **AWS SDK v3 + presigner（推荐先试）** | 与现状代码完全一致，bucket/Token 不变；Cloudflare 官方支持在 Worker 内运行；需要 `nodejs_compat`（Buffer shim）+ bundler 选择 fetch handler；打包体积需控制在免费档 3MB（gzip）内 | ✅ 优先 |
| R2 Binding | 服务端操作（createMultipart/complete/abort/readRange/delete）更轻量，但**无法生成 S3 兼容预签名 URL**（预签名仍要 SDK） | 备选 |

先按 Option A（纯 SDK）改造，若打包体积或兼容性问题突出，再把服务端操作切换到 R2 Binding，仅保留预签名用 SDK。

### 5.4 前端托管：Workers Static Assets

```toml
assets = { directory = "apps/web/dist", binding = "ASSETS", not_found_handling = "single-page-application" }
```

- 与 API 同源部署，前端默认 `VITE_API_BASE_URL=/api`（`apps/web/src/api/client.ts`）无需改动，**CORS 配置可以整个删掉**（同源）；
- SPA 路由回退由 `not_found_handling` 处理，替代 Fastify 的 `setNotFoundHandler`。

---

## 6. 代码改造清单（逐文件）

### 6.1 `apps/api/src/infrastructure/database.ts`（微改）

- `import { createClient } from '@libsql/client'` → `'@libsql/client/web'`（Worker 运行时，HTTP 传输）；
- `randomUUID` 从 `node:crypto` 改为全局 `crypto.randomUUID()`；
- `close()` 保留（无操作即可），其余 SQL 与映射逻辑**零改动**。

### 6.2 `apps/api/src/infrastructure/kv.ts`（新增适配器）

新增 `DurableObjectKvStore`（保留 `MemoryKvStore` 给本地测试）。核心示意：

```ts
// kv-do.ts
export class KvDurableObject extends DurableObject<Env> {
  async get(key: string): Promise<string | null> {
    const e = await this.ctx.storage.get<{ value: string }>(key);
    return e ? e.value : null; // 过期由 storage 的 expirationTtl 自动清理
  }
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.ctx.storage.put(key, { value }, { expirationTtl: ttlSeconds });
  }
  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    if ((await this.get(key)) !== null) return false;
    await this.set(key, value, ttlSeconds);
    return true;
  }
  async delete(key: string): Promise<void> { await this.ctx.storage.delete(key); }
  async increment(key: string, ttlSeconds: number): Promise<number> {
    const next = Number((await this.get(key)) ?? '0') + 1; // 单写者，天然无竞态
    await this.set(key, String(next), ttlSeconds);
    return next;
  }
}
```

客户端侧 `DurableObjectKvStore implements KvStore` 通过 `env.KV_DO.get(id).get(key)` 等 RPC 调用（DO 单实例即可，`id = 'global'`）。`app.ts` 里 `kv` 的装配逻辑从 `RedisKvStore.connect` 换成 `new DurableObjectKvStore(env)`。

### 6.3 `apps/api/src/infrastructure/storage/r2.ts`（微改）

- 保持 AWS SDK v3 + presigner 的 7 个方法不动；
- `readRange` 返回值由 `Buffer` 改为 `Uint8Array`（`types.ts` 同步改，调用点 `app.ts` 中 `toString('utf8')` 改为 `new TextDecoder().decode(...)`）；
- 确认 bundler 采用 fetch 型 HTTP handler（wrangler 打包默认行为，实测验证即可）。

### 6.4 `apps/api/src/infrastructure/mail.ts`（裁剪）

- 保留 `ResendMailer`（纯 fetch，**零改动**，仅把 `FastifyBaseLogger` 类型换成轻量 logger 接口）；
- 删除 `NodemailerMailer` / SMTP 驱动（依赖 `node:dns/net/tls`，Worker 不可用；生产配置本来就是 Resend）。

### 6.5 `apps/api/src/config.ts`（适配 Workers env）

- `process.env` → Workers `env` 绑定（或启用 `nodejs_compat` 后保留 `process.env`，二选一；推荐直接改为 `loadConfig(env)` 入参）；
- 删除 `PORT/HOST/REDIS_DRIVER/REDIS_URL/SMTP_*` 等不再需要的项；
- 保留全部业务参数（`MAX_FILE_SIZE_BYTES` 等）与生产安全校验（`COOKIE_SECRET`/`OTP_PEPPER`/`LOCAL_SIGNING_SECRET` 长度校验）。

### 6.6 `apps/api/src/app.ts`（Fastify → Hono，最大改动项）

| Fastify 原能力 | Hono 替代 |
|---|---|
| 路由（约 20 条，业务 handler 不变） | `app.post('/api/...', handler)`，handler 内部逻辑原样平移 |
| `@fastify/helmet`（CSP） | 手写中间件设置响应头（CSP 内容不变：`script-src 'self' 'wasm-unsafe-eval'`、`connect-src` 加 R2 origin） |
| `@fastify/cookie`（`unsignCookie`/`setCookie`） | 手写 cookie 解析 + HMAC-SHA256 签名/验签（WebCrypto） |
| `@fastify/cors` | **删除**（同源部署后不再需要） |
| `setErrorHandler`（ApiError → JSON 响应） | `app.onError` + `app.notFound` |
| `request.ip`（OTP 频控） | `request.headers.get('CF-Connecting-IP')` |
| `bodyLimit` 1MB | `app.post(..., { bodyLimit })` 或手动校验 |
| 静态托管 `setNotFoundHandler` | `env.ASSETS.fetch(request)` 回退（SPA 由 assets 配置处理） |
| 健康检查 `/health/live`、`/health/ready` | 原样保留（供 uptime 监控用，Cloudflare 不需要健康检查探活） |

业务逻辑（OTP 流程、prepare/presign/ack/complete、秒传、文件预览/下载/删除）全部从 Fastify handler 里**原样搬移**，只改请求/响应对象获取方式。

### 6.7 `apps/api/src/server.ts` → `apps/api/src/worker.ts`（新入口）

```ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCleanup(env)); // 每小时孤儿 multipart 清理
  },
};
```

- `runCleanup` 平移 `apps/api/src/cli/cleanup.ts` 的逻辑：`db.staleUploads(cutoff)` → `storage.abortMultipart` → `db.setUploadStatus('EXPIRED')`；
- 清理 Worker 与 API 同脚本（靠 cron 触发进入 scheduled 分支），省一个部署单元；R2 生命周期规则（`infra/r2-lifecycle.json`，1 天后中止 `quarantine/` 下未完成 multipart）继续作为存储层兜底，cron 负责 DB 状态卫生——**不能省**，因为 `countActiveUploads` 不按 `expires_at` 过滤，过期行不清除会占满 `MAX_ACTIVE_UPLOADS_PER_USER`。

### 6.8 `apps/api/src/infrastructure/telemetry.ts`（微改）

`FastifyBaseLogger` 类型替换为最小 `Logger` 接口（`{ info(...): void; error(...): void; warn(...): void }`），实现里直接 `console.*` 或接 Workers `ctx.waitUntil` 日志上报。

### 6.9 `apps/api/src/infrastructure/storage/local.ts`（保留不动）

本地文件系统实现仅用于本地开发与测试，继续在 Node 下运行，**不进入 Worker bundle**。

### 6.10 `apps/api/test/app.test.ts`（机械适配）

- `built.app.inject({ method, url, payload, headers })` → Hono `built.app.request(url, { method, body, headers })`，断言逻辑不变；
- `Buffer` 相关断言改为 `Uint8Array`/`TextDecoder` 比较；
- 测试仍跑在 Node + `MemoryKvStore` + `LocalStorageProvider` 下，**不依赖任何云资源**，作为迁移后的回归基线。

### 6.11 环境变量映射

| 现有（.env / Render） | Workers 形态 | 说明 |
|---|---|---|
| `NODE_ENV` | 固定 `production` | |
| `PORT` / `HOST` | 删除 | Workers 无端口 |
| `APP_ORIGIN` | 删除 | 同源部署，CORS 取消 |
| `COOKIE_SECRET` / `OTP_PEPPER` / `LOCAL_SIGNING_SECRET` | `wrangler secret put` | 生产安全校验保留；`LOCAL_SIGNING_SECRET` 生产可留空 |
| `DATABASE_URL` / `DATABASE_AUTH_TOKEN` | secret | **原值不变**（Turso 原位） |
| `REDIS_DRIVER` / `REDIS_URL` | 删除 | 由 DO/KV 适配器取代 |
| `MAIL_DRIVER` | 固定 `resend` | SMTP 分支删除 |
| `RESEND_API_KEY` / `MAIL_FROM` | secret | 原值不变 |
| `SMTP_*` 全部 | 删除 | |
| `STORAGE_DRIVER` | 固定 `r2` | |
| `R2_ENDPOINT` / `R2_BUCKET` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | secret | **原值不变**（同桶） |
| 业务参数（`MAX_FILE_SIZE_BYTES` 等） | `[vars]` | 原值不变 |

---

## 7. 部署配置

### 7.1 `wrangler.toml`（新增）

```toml
name = "big-upload"
main = "apps/api/src/worker.ts"
compatibility_date = "2025-06-01"
compatibility_flags = ["nodejs_compat"]   # Buffer / 部分 Node 行为

assets = { directory = "apps/web/dist", binding = "ASSETS", not_found_handling = "single-page-application" }

[triggers]
crons = ["17 * * * *"]                    # 对齐 render.yaml 的每小时清理

[[r2_buckets]]
binding = "UPLOADS"
bucket_name = "big-upload"                # 保留现有桶名

[durable_objects]
bindings = [{ name = "KV_DO", class_name = "KvDurableObject" }]

[[migrations]]
tag = "v1"
new_classes = ["KvDurableObject"]

[vars]
MAX_FILE_SIZE_BYTES = "5368709120"
MAX_ACTIVE_UPLOADS_PER_USER = "5"
UPLOAD_STALE_AFTER_SECONDS = "86400"
PART_URL_TTL_SECONDS = "900"
PREVIEW_URL_TTL_SECONDS = "300"
OTP_TTL_SECONDS = "600"
SESSION_TTL_SECONDS = "604800"
LOG_LEVEL = "info"
```

Secrets（`wrangler secret put`，不入库）：`COOKIE_SECRET`、`OTP_PEPPER`、`DATABASE_URL`、`DATABASE_AUTH_TOKEN`、`RESEND_API_KEY`、`MAIL_FROM`、`R2_ENDPOINT`、`R2_BUCKET`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`。

### 7.2 本地开发与 CI

```bash
# 本地
npm run build                                   # shared + upload-core + web + api（api 产出 worker 入口）
wrangler dev                                    # 本地起 Worker + 静态资源，连真实 Turso/R2（或临时 KV 本地模拟）
wrangler deploy --dry-run                       # 检查 bundle 体积与配置

# CI（GitHub Actions 示例）
# - npm ci && npm run build && npm test && npm run typecheck
# - 云端 secrets 注入后: npx wrangler deploy
```

若仓库后续加 CI，用 OAuth/API token 认证 `wrangler`；当前仓库无 CI（`.github/` 不存在），可先手动 `wrangler deploy`，CI 作为可选项。

### 7.3 R2 CORS 更新

`infra/r2-cors.json` 中 `AllowedOrigins` 改为：
1. 过渡期：`https://big-upload.<subdomain>.workers.dev`（或 Pages 域名）；
2. 上线后：正式自定义域名（可同时保留 workers.dev 便于回滚）。

---

## 8. 实施阶段（Phase 0~6）

| 阶段 | 内容 | 产出物 | 工作量 | 验收 |
|---|---|---|---|---|
| **Phase 0 准备** | Cloudflare 账号与域名托管确认；R2 CORS 预配置；`wrangler` 安装；现有测试跑绿基线 | 环境就绪 | 0.5 人日 | 本地 `npm test` 全绿 |
| **Phase 1 适配层** | database.ts（web client）、kv-do.ts（DO 适配器）、r2.ts（Uint8Array）、mail.ts（裁剪）、config.ts（env 化）、telemetry.ts | 6 个适配文件 | 1 人日 | 各适配器单测通过 |
| **Phase 2 框架迁移** | app.ts 改为 Hono：路由、中间件（CSP/cookie/错误处理）、crypto 移植（WebCrypto） | Hono 版 API | 1.5~2 人日 | `npm test`（Hono.request 版）全绿 |
| **Phase 3 入口与 Cron** | worker.ts fetch + scheduled；清理逻辑平移 | 可部署单元 | 0.5 人日 | `wrangler dev` 本地完整主流程（OTP→上传→合并→预览）跑通 |
| **Phase 4 测试适配** | app.test.ts 迁移到 Hono.request；补充 KV/DO 适配器测试 | 测试基线 | 0.5~1 人日 | 测试全绿；`wrangler deploy --dry-run` 通过 |
| **Phase 5 预发布** | 部署到 workers.dev 过渡域名；连真实 Turso/R2 做冒烟测试；R2 CORS 放行过渡域名 | 过渡环境 | 0.5 人日 | 冒烟清单（§9）全过 |
| **Phase 6 上线切换** | 自定义域名接入（DNS 托管到 Cloudflare → 控制台加自定义域）；CSP/CORS 收紧为正式域名；Render 保留观察后下线 | 正式上线 | 0.5 人日 | 正式域名全流程可用；回滚预案就绪 |
| **合计** | | | **4.5~6 人日** | |

**过渡策略**：Render 保持运行直到正式域名验证通过；切换只动 DNS，代码无需变更即可回滚。

---

## 9. 上线冒烟清单

- [ ] `POST /api/auth/otp/request` → 202 + 收到 Resend 邮件；60s 内重复请求 → 429 `OTP_RESEND_COOLDOWN`
- [ ] `POST /api/auth/otp/verify` → 200 + 设置 cookie；错误码 5 次 → 429
- [ ] `POST /api/uploads/prepare`（>1 个分片的文件）→ 返回分片计划与 `partSize`
- [ ] `POST /api/uploads/:id/part-urls` → 预签名 URL 可 PUT 直传 R2 成功（浏览器网络面板确认请求落在 R2 域名而非 Worker）
- [ ] 断点续传：暂停 → 重新 prepare → 返回 `resumed: true` 且 `uploadId` 不变
- [ ] 秒传：重复上传同一文件 → `dedupe_challenge` 流程或 `kind:'instant'`
- [ ] `complete` 后文件列表出现；图片/视频/PDF/TXT 预览与下载（Range 206）正常
- [ ] 服务端内容检测：改名 `.txt` 的二进制文件 → 415 `FILE_TYPE_REJECTED`
- [ ] 刷新/换浏览器重新选文件可续传；登出后 cookie 失效
- [ ] 触发 cron（或临时手动调用清理路径）→ 过期 upload 标记 `EXPIRED`，R2 中 multipart 被中止
- [ ] 自定义域名 HTTPS 证书自动签发；旧 Render 域名可 301 到新域名（可选）

---

## 10. 成本与工作量汇总

### 资金成本（月度）

| 项 | Render（现状） | Cloudflare（迁移后） |
|---|---|---|
| 应用托管 | 免费（休眠冷启动）或 Starter $7/月起 | Workers 免费 10 万请求/天；超量或 DO 配额不足时 $5/月（[定价](https://developers.cloudflare.com/workers/platform/pricing/)） |
| 自定义域名 | 受限 | 免费 |
| R2 | 已有（免费额度 10GB/100 万 A 类/1000 万 B 类） | 不变，继续免费额度内 |
| Turso | 已有（免费额度） | 不变 |
| Cron | 免费 | 免费 |
| **合计** | $0~7+ | **$0~5**（大概率长期 $0） |

### 人力成本

| 项 | 估算 |
|---|---|
| 适配层 + 框架迁移 + 测试 + 部署 + 切换 | **4.5~6 人日** |
| 其中最大单项 | Fastify → Hono 路由层 1.5~2 人日 |
| 数据迁移 | **0**（Turso + R2 原位保留） |

---

## 11. 风险登记册

| # | 风险 | 影响 | 概率 | 对策 |
|---|---|---|---|---|
| 1 | AWS SDK v3 在 Worker 的打包/兼容问题（Buffer、handler 选择） | 高（R2 链路） | 中 | Cloudflare 官方 aws-sdk-js-v3 示例兜底；备选方案：服务端操作切 R2 Binding，仅预签名留 SDK；免费档 bundle 3MB（gzip）限制，必要时裁剪 SDK 子路径导入 |
| 2 | KV 最终一致性导致跨地域会话掉线 | 中 | 低（小规模） | **已选 DO 方案规避**；KV 回退方案需接受 |
| 3 | KV 免费档 1000 写/天配额 | 中 | 中 | **已选 DO 方案规避**；若用 KV，监控写入量 |
| 4 | DO 免费档配额未知/不足 | 低 | 低 | 以控制台为准；回退 KV 或 Turso 表（§5.2） |
| 5 | WebCrypto 移植引入行为差异（异步化、constant-time 比较） | 中 | 低 | 测试覆盖 OTP/签名路径；cookie 签名格式变化 → 用户重登一次（可接受） |
| 6 | Turso 从 Worker 访问的延迟/副本一致性 | 低 | 低 | HTTP 协议直连，与现状同源；读副本轻微延迟只影响会话类（已由 DO 承担） |
| 7 | 免费档 CPU 10ms/请求限制 | 中 | 低 | 本应用以 I/O 为主（DB/R2 fetch），CPU 占用低；nodejs_compat 有少量启动开销，超限则升 $5 付费档 |
| 8 | 域名切换窗口 | 低 | 低 | DNS 托管到 Cloudflare 免费；与 Render 并行运行，验证后切换，随时回滚 |
| 9 | OTP 频控语义变化（increment 原子性） | 低 | 低 | DO 方案下原子性保持；仅 KV 回退方案有轻微竞态（防刷上限略松，可接受） |

---

## 12. 验收标准（Definition of Done）

1. 正式自定义域名（HTTPS）访问前端与 `/api/*` 全部正常，**无冷启动等待**（多次冷请求 P95 < 500ms）；
2. Turso 数据库**原库原数据**继续服务，无任何数据导出/导入动作；
3. R2 **同桶同对象**，历史文件列表、预览、下载均可用；
4. 浏览器直传 R2 链路不变（分片 PUT 不经过 Worker）；
5. 每小时清理任务生效（过期 upload 标记 `EXPIRED`、孤儿 multipart 中止）；
6. 现有 `npm test` / `npm run typecheck` 全绿（Hono 版）；
7. Render 服务确认无流量后下线，`render.yaml` 保留在仓库作为回滚文档。

---

## 附：参考文档

- [R2 官方 aws-sdk-js-v3 示例（Worker 内预签名）](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/)
- [Turso · Cloudflare Workers 官方集成](https://developers.cloudflare.com/workers/databases/third-party-integrations/turso/)
- [Workers KV 限额](https://developers.cloudflare.com/kv/platform/limits/) / [KV 定价](https://developers.cloudflare.com/kv/platform/pricing/)
- [Workers 定价（免费/付费额度）](https://developers.cloudflare.com/workers/platform/pricing/)
- [Durable Objects 定价与免费档说明](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [R2 multipart 对象文档](https://developers.cloudflare.com/r2/objects/multipart-objects/)
