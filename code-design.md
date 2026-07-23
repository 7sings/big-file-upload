# 大文件上传核心实现说明

本文依据当前代码实现整理，重点说明上传分片、失败恢复、哈希、Cloudflare R2 分工与鉴权边界。

## 1. 总体链路

```text
浏览器                    Node/Fastify                         Cloudflare R2
  |  登录/prepare/presign     |                                      |
  |-------------------------> | 校验 Session、归属、状态；创建 multipart |
  |                           |------------------------------>       |
  | <--- uploadId、分片计划、预签名 PUT URL --- |                       |
  |                                                                     |
  |--------- PUT 某个 Blob（带预签名） ------------------------------> |
  | <---------------------------- ETag -------------------------------|
  |  ack(partNumber, ETag, size)  |                                   |
  |-----------------------------> | 写入 upload_parts                 |
  |  complete                    | CompleteMultipartUpload           |
  |-----------------------------> |------------------------------>    |
  |                           | 抽样检测实际文件类型，落 files 表       |
```

生产环境的文件字节**不经过 Node**。浏览器通过 R2 的 S3 兼容预签名 URL 直接上传，Node 负责控制面（认证、授权、状态与合并）。本地 `LocalStorageProvider` 为了模拟同一协议，才会由 API 进程流式接收分片。

相关实现：

- 浏览器调度：[apps/web/src/features/upload-manager.ts](apps/web/src/features/upload-manager.ts)
- API 状态机与控制接口：[apps/api/src/app.ts](apps/api/src/app.ts)
- R2 适配器：[apps/api/src/infrastructure/storage/r2.ts](apps/api/src/infrastructure/storage/r2.ts)

## 2. 分片大小如何确定

服务端在 `POST /api/uploads/prepare` 创建 multipart 会话时固定分片计划；后续恢复上传仍使用数据库已保存的 `partSize/totalParts`，不会中途改边界。

### 固定大小策略

所有**新建** multipart 会话统一使用 8 MiB 分片，不再根据网络速度改变分片边界。8 MiB 高于 R2 非尾 part 至少 5 MiB 的限制，也可避免大分片在弱网下重传成本过高。

网络自适应改由并发控制完成：初始并发 2；连续快速完成（每片 <1 秒）时升到 4、6；连续出现可重试错误或拥塞时降到 1。已创建会话恢复时始终使用数据库中保存的 `partSize/totalParts`，不能改为新计划。

核心分片代码（[packages/upload-core/src/chunk-planner.ts](packages/upload-core/src/chunk-planner.ts)）：

```ts
const MIB = 1024 * 1024;
export const FIXED_PART_SIZE = 8 * MIB;
const MAX_MULTIPART_PARTS = 10_000;

export function planChunks(fileSize: number): ChunkPlan {
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) throw new Error('文件大小无效');
  const totalParts = Math.ceil(fileSize / FIXED_PART_SIZE);
  if (totalParts > MAX_MULTIPART_PARTS) throw new Error('文件超过固定 8 MiB 分片的 10,000 片上限');
  return { partSize: FIXED_PART_SIZE, totalParts };
}

export function deriveChunkPlan(fileSize: number, profile?: NetworkProfile): ChunkPlan {
  void profile;
  return planChunks(fileSize);
}
```

### 兜底与边界

- 新会话分片固定为 **8 MiB**；最后一片可以小于 8 MiB。
- 8 MiB × 10,000 的理论固定计划上限约为 78.125 GiB；超过时直接拒绝，而不是私自改变分片大小。
- 单文件大小仍受服务端 `MAX_FILE_SIZE_BYTES` 限制，默认 **5 GiB**，故默认部署最多 640 个分片。
- 已存在会话不受本策略变更影响，续传继续使用会话创建时保存的分片边界。
- 实际切片范围由 `getPartRange(partNumber, partSize, fileSize)` 计算；最后一片自然小于或等于 `partSize`。

## 3. 某个切片请求失败时怎么办

客户端对每个 part 独立处理，失败不会让已经确认的 part 重传。

1. 每次上传前请求 `/uploads/:id/presign` 取得该片的短期 URL；
2. PUT 成功后读取 R2 返回的 `ETag`，调用 `/uploads/:id/ack` 持久化 `{partNumber, etag, size}`；
3. 若 PUT、签名接口或网络失败，最多重试 **5 次**（首次请求 + 5 次重试，至多 6 次尝试）；每次都会重新签名，避免 URL 过期；
4. 只对网络错误、408、429、500、502、503、504 重试；其它 4xx 被视为不可恢复；
5. 重试等待使用 full jitter 指数退避，单次上限 30 秒；出现拥塞时并发数减半；
6. 某个 part 最终失败后，中止同一文件其他正在飞行的 XHR，此文件转为 `FAILED_RETRYABLE` 或 `FAILED_FINAL`；用户可点击恢复。其他文件任务不受影响。

核心代码（[apps/web/src/features/upload-manager.ts](apps/web/src/features/upload-manager.ts) 与 [packages/upload-core/src/retry.ts](packages/upload-core/src/retry.ts)）：

```ts
const MAX_RETRIES = 5;

private async uploadWithRetry(/* ... */): Promise<UploadedPart> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const signed = await api.presign(runtime.view.uploadId!, [partNumber]);
      const target = signed.parts.find((part) => part.partNumber === partNumber);
      if (!target) throw new Error(`分片 ${partNumber} 未获得上传地址`);
      return await this.uploadPart(runtime, target, generation);
    } catch (error) {
      lastError = error;
      const retryable = !(error instanceof ApiError)
        || error.status === 0 || isRetryableStatus(error.status);
      if (!retryable || attempt === MAX_RETRIES) throw error;
      runtime.control.onCongestion();
      await sleep(retryDelay(attempt));
    }
  }
  throw lastError;
}

export function retryDelay(attempt: number, random = Math.random): number {
  const cap = Math.min(30_000, 500 * 2 ** Math.max(0, attempt));
  return Math.floor(random() * cap);
}
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || [500, 502, 503, 504].includes(status);
}
```

恢复依据是服务端 `upload_parts` 表，而非仅浏览器内存：刷新或切换浏览器后，用户重新选择同一文件，前端向服务端查询已 ACK 的 part，只补传剩余 part。暂停/断网会 abort 当前 XHR，状态变为 `PAUSED`/`WAITING_NETWORK`，网络恢复后重新排队。

并发数采用 AIMD：初始 3，连续成功 3 片加 1，最高 6；遇到重试则减半，最低 1（[packages/upload-core/src/adaptive-concurrency.ts](packages/upload-core/src/adaptive-concurrency.ts)）。

## 4. Hash 如何计算

这里没有计算完整文件哈希。设计使用“抽样 MD5 + 抽样 SHA-256”的轻量指纹，目的在于恢复上传和秒传候选匹配，避免读取整个大文件，也避免阻塞 UI。

### 首次指纹（Worker 内）

- 在 Web Worker 执行，主线程不被哈希计算卡住；
- 小文件（≤ 6 MiB）取整个文件；大文件取最多 7 个、每个最多 2 MiB 的位置：头部、尾部、中部和均匀分布的中间位置；
- 将这些样本按顺序喂给 `hash-wasm` 的 MD5，形成 `sample-md5:<md5>:<文件大小>`；
- 同时为每段样本计算 SHA-256，保留 offset、length、sha256，用于恢复时确认用户重新选择的文件确实相同。

核心代码（[apps/web/src/workers/hash.worker.ts](apps/web/src/workers/hash.worker.ts)）：

```ts
const SAMPLE_SIZE = 2 * 1024 * 1024;
const MAX_RANGES = 7;

function sampleRanges(size: number): Range[] {
  if (size <= SAMPLE_SIZE * 3) return [{ offset: 0, length: size }];
  const length = Math.min(SAMPLE_SIZE, size);
  const offsets = new Set<number>([0, size - length, Math.floor((size - length) / 2)]);
  for (let i = 1; i <= MAX_RANGES - 3; i += 1) {
    offsets.add(Math.floor(((size - length) * i) / (MAX_RANGES - 2)));
  }
  return [...offsets].sort((a, b) => a - b)
    .map((offset) => ({ offset, length: Math.min(length, size - offset) }));
}

const md5 = await createMD5();
for (const range of ranges) {
  const bytes = await file.slice(range.offset, range.offset + range.length).arrayBuffer();
  md5.update(new Uint8Array(bytes));
  results.push({ ...range, sha256: hex(await crypto.subtle.digest('SHA-256', bytes)) });
}
self.postMessage({
  type: 'done',
  result: { quickFingerprint: `sample-md5:${md5.digest('hex')}:${message.file.size}`, ranges: results }
});
```

### 秒传二次挑战

同一用户有相同 `quickFingerprint + size` 的 READY 文件时，服务端随机挑选最多 5 段、每段 64 KiB，请浏览器计算 SHA-256；服务端再对 R2 中已有对象的同一范围计算 SHA-256 比对。全部一致才秒传，否则创建新 multipart 上传。

这降低了抽样 MD5 碰撞/伪造风险，但仍不是完整性证明。若需要密码学级的文件身份或跨用户去重，应改为客户端/服务端完整 SHA-256（并评估读取成本）。

## 5. R2 与服务端如何分工

| 阶段 | 浏览器 | Node/Fastify | R2 |
| --- | --- | --- | --- |
| 建立会话 | 上报元数据、网络画像 | 鉴权、限额、生成固定分片计划、`CreateMultipartUpload`、保存 upload 记录 | 创建 multipart，返回 `UploadId` |
| 上传分片 | `File.slice()` 得到 Blob，用 XHR `PUT` 预签名 URL，读取 ETag | 校验会话所有权和状态后仅签发指定 part 的 URL；接收 ACK | 接收并保存 part，返回 ETag |
| 完成 | 请求 complete | 校验每片均 ACK、调用 `CompleteMultipartUpload`、检测内容类型、写入 files | 按 partNumber + ETag 合并为对象 |
| 预览/下载 | 使用短期 URL 或跟随重定向 | 先校验文件归属，再签名下载 URL | 返回对象内容 |

R2 适配器签名上传的代码如下：

```ts
async signPartUpload(objectKey: string, uploadId: string, partNumber: number, expiresInSeconds: number) {
  const url = await getSignedUrl(this.client,
    new UploadPartCommand({ Bucket: this.bucket, Key: objectKey, UploadId: uploadId, PartNumber: partNumber }),
    { expiresIn: expiresInSeconds });
  return { url, expiresAt: Date.now() + expiresInSeconds * 1000 };
}
```

该 URL 绑定 bucket、对象 key、R2 `UploadId`、partNumber 和有效期，属于短期 bearer capability：拿到 URL 的一方可在有效期内上传**那个** part。因此不能把 URL 写日志、持久化到 IndexedDB 或暴露给第三方；当前实现每次重试重新请求签名。默认有效期为 900 秒。

## 6. 服务鉴权与授权

鉴权分为 API 会话鉴权和 R2 预签名 URL 授权两个层次。

### API 会话鉴权

1. 用户通过邮箱 OTP 登录。验证码在 KV 中只保存带 `OTP_PEPPER` 的 SHA-256，不保存明文；有 10 分钟 TTL、60 秒重发冷却、邮箱/IP 频控和最多 5 次尝试。
2. 验证成功后服务端生成随机 token，把 `{ user, expiresAt }` 放入 KV，浏览器只持有签名的 `big_upload_session` Cookie。
3. Cookie 属性是 `httpOnly`、`sameSite=lax`、生产环境 `secure=true`，并由 `@fastify/cookie` 使用 `COOKIE_SECRET` 签名。
4. 前端控制 API 使用 `fetch(..., { credentials: 'include' })`，故 Cookie 随同源 API 请求自动携带。

所有受保护接口首先调用：

```ts
async function requireUser(request: FastifyRequest): Promise<CurrentUser> {
  const current = await session(request);
  if (!current || current.expiresAt <= Date.now()) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required');
  }
  return current.user;
}
```

涉及特定资源时，不只检查“已登录”，还检查资源归属：

```ts
async function ownedUpload(request: FastifyRequest, id: string): Promise<UploadRow> {
  const user = await requireUser(request);
  const value = await db.getUpload(id);
  if (!value || value.userId !== user.id) {
    throw new ApiError(404, 'UPLOAD_NOT_FOUND', 'Upload not found');
  }
  return value;
}
```

因此 `/prepare`、查询活跃会话、`presign`、`ack`、暂停、恢复、完成、取消、文件列表、预览、下载、删除都会先确认登录；带 `:id` 的上传/文件接口再确认 `user_id` 相等。无权资源统一返回 404，避免泄露资源是否存在。数据库的 `uploads.user_id`、`files.user_id` 也保存此归属关系。

### 分片 PUT 的授权

浏览器直传 R2 时并不携带站点 Cookie，R2 也不知道应用用户。它通过上一步 API 签发的 SigV4 预签名 URL 授权。服务端只有在以下条件都成立时才签名：

- Cookie session 有效；
- 请求中的 uploadId 属于该用户；
- 上传状态属于 `INITIATED` / `UPLOADING` / `PAUSED`；
- partNumber 在固定上传计划范围内，且尚未被 ACK。

随后 `/ack` 还会再次验证同一会话的归属、part 编号与根据固定 `partSize` 推导出的精确字节数。最终 `/complete` 要求数据库中 ACK 的 part 数量、编号连续性和每片大小全部正确，才调用 R2 合并。

## 7. 其他值得关注的实现细节

- 服务端不信任文件扩展名或浏览器的 `declaredMime`。R2 合并后会读取前 64 KiB，基于内容签名检测类型；不在白名单的对象被删除并置为 `REJECTED`。
- 未完成会话有 `expiresAt`（默认 24 小时），并配有清理任务终止孤儿 multipart；客户端本地也在 IndexedDB 保存会话元数据与最近速度，以便重新选择原文件后恢复。
- R2 CORS 必须允许页面来源的 `PUT`，并暴露 `ETag`，否则浏览器虽可能上传成功却无法 ACK；后端 CORS 也显式暴露 `etag`。
- API 主体限制为 1 MiB 不影响大文件上传，因为文件字节不发送给 `/api`；只接收小型控制 JSON。此限制也避免有人把大文件误投给控制面。
- 预签名 URL 无法在 R2 端撤销。暂停/取消阻止后续 API 签名，并中止/终止 multipart；已经签发但未过期的 URL 在有效期内仍是潜在窗口。若业务风险更高，应缩短 `PART_URL_TTL_SECONDS`，并结合更严格的网络/审计策略。
