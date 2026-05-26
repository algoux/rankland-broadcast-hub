# 精彩回放接口协议

本文定义精彩回放相关 HTTP API、Socket.io 事件、DTO、状态枚举和上传协议。接口默认使用现有 `Resp` 响应结构：

```ts
type Resp<T> =
  | { success: true; code: 0; data: T }
  | { success: false; code?: number; msg?: string; data?: any };
```

所有 HTTP 管理接口默认位于 `/api` 前缀下。除特别说明外，请求头需要包含：

- `X-UCA`：比赛 alias。
- `X-Token`：Hub 管理/导播鉴权 token。

## 枚举

```ts
type ClipSource = 'manual' | 'automation';
type ClipCategory = 'firstBlood' | 'accepted' | 'manual' | 'other';
type ClipPriority = 'low' | 'normal' | 'high';

type ClipAutomationTriggerKind = 'manualOnly' | 'firstBlood' | 'accepted';

type ClipTaskStatus =
  | 'queued'
  | 'requested'
  | 'client_processing'
  | 'uploading'
  | 'verifying'
  | 'ready'
  | 'partial_ready'
  | 'failed'
  | 'cancelled'
  | 'expired';

type ClipTaskItemStatus =
  | 'queued'
  | 'requested'
  | 'client_processing'
  | 'uploading'
  | 'verifying'
  | 'ready'
  | 'failed'
  | 'cancelled';

type ClipUploadStatus = 'created' | 'uploading' | 'completed' | 'failed' | 'expired';
type ClipStatus = 'ready' | 'deleted' | 'expired';
```

## 数据结构

### ClipAutomationTask

```ts
interface ClipAutomationTask {
  automationId: string;
  uca: string;
  name: string;
  enabled: boolean;
  trigger: {
    kind: ClipAutomationTriggerKind;
    problemAliases?: string[];
    includeUnofficial?: boolean;
  };
  target: {
    userSelector: 'eventUser';
    trackIds: string[];
  };
  clipWindow: {
    preRollMs: number;
    postRollMs: number;
    minDurationMs: number;
    maxDurationMs: number;
  };
  defaults: {
    category: ClipCategory;
    titleTemplate: string;
    tags: string[];
    priority: ClipPriority;
  };
  createdAt: number;
  updatedAt: number;
}
```

`titleTemplate` 支持以下变量：

- `{userId}`
- `{userName}`
- `{problemAlias}`
- `{triggerKind}`
- `{eventTime}`

首版 Hub 只需要保存模板，不要求渲染模板；未来 agent 创建 `ClipTask` 时负责写入最终标题。

### ClipAutomationRun

```ts
interface ClipAutomationRun {
  runId: string;
  automationId: string;
  uca: string;
  triggerKind: ClipAutomationTriggerKind;
  triggerKey: string;
  eventServerMs: number;
  payload: Record<string, any>;
  createdTaskIds: string[];
  status: 'matched' | 'created_task' | 'skipped' | 'failed';
  errorCode?: string;
  errorMessage?: string;
  createdAt: number;
}
```

`triggerKey` 由未来 agent 生成，用于避免同一事件重复创建任务。建议格式为 `{triggerKind}:{problemAlias}:{userId}:{eventServerMs}`。

### ClipTask

```ts
interface ClipTask {
  taskId: string;
  uca: string;
  source: ClipSource;
  automationId?: string;
  automationRunId?: string;
  title: string;
  category: ClipCategory;
  tags: string[];
  priority: ClipPriority;
  userId: string;
  status: ClipTaskStatus;
  startServerMs: number;
  endServerMs: number;
  attempts: number;
  maxAttempts: number;
  progress: number;
  errorCode?: string;
  errorMessage?: string;
  items: ClipTaskItem[];
  createdClipIds: string[];
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}
```

### ClipTaskItem

```ts
interface ClipTaskItem {
  itemId: string;
  taskId: string;
  uca: string;
  userId: string;
  trackId: string;
  status: ClipTaskItemStatus;
  uploadId?: string;
  clipId?: string;
  progress: number;
  errorCode?: string;
  errorMessage?: string;
  actualStartServerMs?: number;
  actualEndServerMs?: number;
  createdAt: number;
  updatedAt: number;
}
```

### Clip

```ts
interface Clip {
  clipId: string;
  uca: string;
  taskId: string;
  itemId: string;
  userId: string;
  trackId: string;
  source: ClipSource;
  category: ClipCategory;
  title: string;
  tags: string[];
  mimeType: string;
  byteSize: number;
  durationMs: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
  checksumSha256: string;
  actualStartServerMs: number;
  actualEndServerMs: number;
  thumbnailUrl?: string;
  mediaUrl: string;
  status: ClipStatus;
  createdAt: number;
  expiresAt: number;
}
```

## 自动化任务管理 API

### POST /api/clips/automations

创建自动化任务配置。

请求：

```ts
interface CreateClipAutomationReq {
  name: string;
  enabled?: boolean;
  trigger: ClipAutomationTask['trigger'];
  target: ClipAutomationTask['target'];
  clipWindow: ClipAutomationTask['clipWindow'];
  defaults: ClipAutomationTask['defaults'];
}
```

响应：

```ts
interface CreateClipAutomationResp {
  automation: ClipAutomationTask;
}
```

### GET /api/clips/automations

列表查询自动化任务。

query：

```ts
interface ListClipAutomationsReq {
  uca: string;
  enabled?: boolean;
  triggerKind?: ClipAutomationTriggerKind;
  page?: number;
  pageSize?: number;
}
```

响应：

```ts
interface ListClipAutomationsResp {
  automations: ClipAutomationTask[];
  total: number;
  page: number;
  pageSize: number;
}
```

### GET /api/clips/automations/:automationId

查看自动化任务详情。

响应：

```ts
interface GetClipAutomationResp {
  automation: ClipAutomationTask;
}
```

### PATCH /api/clips/automations/:automationId

更新自动化任务。未传字段保持不变。

请求：

```ts
interface UpdateClipAutomationReq {
  name?: string;
  enabled?: boolean;
  trigger?: ClipAutomationTask['trigger'];
  target?: ClipAutomationTask['target'];
  clipWindow?: ClipAutomationTask['clipWindow'];
  defaults?: ClipAutomationTask['defaults'];
}
```

响应：

```ts
interface UpdateClipAutomationResp {
  automation: ClipAutomationTask;
}
```

### DELETE /api/clips/automations/:automationId

删除自动化任务。首版建议软删除或禁用，不删除历史 run。

响应：

```ts
interface DeleteClipAutomationResp {
  automationId: string;
  deleted: true;
}
```

### GET /api/clips/automations/:automationId/runs

查询自动化任务运行记录。

query：

```ts
interface ListClipAutomationRunsReq {
  page?: number;
  pageSize?: number;
  status?: ClipAutomationRun['status'];
}
```

响应：

```ts
interface ListClipAutomationRunsResp {
  runs: ClipAutomationRun[];
  total: number;
  page: number;
  pageSize: number;
}
```

## 自动化 agent 边界 API

以下接口只面向未来归属于 Hub 服务端的自动化 agent 或子脚本，不面向 KtO，也不代表 Hub 首版需要实现 trigger 检查逻辑。agent 可以用这些接口记录命中结果，并复用 `POST /api/clips/tasks` 创建具体切片任务。

建议使用独立的 `X-Agent-Token` 或本机 IPC 鉴权；如果首版只实现 HTTP，可临时复用 `X-Token`，但文档语义上仍视为内部接口。

### POST /api/clips/automations/:automationId/runs

agent 命中某个自动化任务后创建运行记录。

请求：

```ts
interface CreateClipAutomationRunReq {
  triggerKind: ClipAutomationTriggerKind;
  triggerKey: string;
  eventServerMs: number;
  payload: Record<string, any>;
  status?: 'matched' | 'skipped' | 'failed';
  errorCode?: string;
  errorMessage?: string;
}
```

响应：

```ts
interface CreateClipAutomationRunResp {
  run: ClipAutomationRun;
}
```

同一 `uca`、`automationId`、`triggerKey` 必须幂等。重复创建时返回已有 `run`。

### PATCH /api/clips/automation-runs/:runId

agent 在创建 `ClipTask` 后回写运行结果。

请求：

```ts
interface UpdateClipAutomationRunReq {
  status: ClipAutomationRun['status'];
  createdTaskIds?: string[];
  errorCode?: string;
  errorMessage?: string;
}
```

响应：

```ts
interface UpdateClipAutomationRunResp {
  run: ClipAutomationRun;
}
```

## 切片任务 API

### POST /api/clips/tasks

创建具体切片任务。该接口供导播手动触发，也供未来 Hub 自动化 agent 命中条件后调用。

请求：

```ts
interface CreateClipTaskReq {
  source: ClipSource;
  automationId?: string;
  automationRunId?: string;
  userId: string;
  trackIds: string[];
  startServerMs: number;
  endServerMs: number;
  title: string;
  category: ClipCategory;
  tags?: string[];
  priority?: ClipPriority;
  maxAttempts?: number;
  idempotencyKey?: string;
}
```

约束：

- `endServerMs` 必须大于 `startServerMs`。
- `trackIds` 至少包含一个 track。
- `source = 'automation'` 时，建议携带 `automationId` 和 `automationRunId`。
- `idempotencyKey` 在同一 `uca` 内幂等；重复请求返回已创建任务。

响应：

```ts
interface CreateClipTaskResp {
  task: ClipTask;
}
```

### GET /api/clips/tasks

查询切片任务列表。

query：

```ts
interface ListClipTasksReq {
  uca: string;
  source?: ClipSource;
  userId?: string;
  status?: ClipTaskStatus;
  category?: ClipCategory;
  page?: number;
  pageSize?: number;
}
```

响应：

```ts
interface ListClipTasksResp {
  tasks: ClipTask[];
  total: number;
  page: number;
  pageSize: number;
}
```

### GET /api/clips/tasks/:taskId

查询单个切片任务详情。

响应：

```ts
interface GetClipTaskResp {
  task: ClipTask;
}
```

### POST /api/clips/tasks/:taskId/progress

KtB 报告任务或任务项进度。

请求：

```ts
interface ReportClipTaskProgressReq {
  itemId?: string;
  status?: ClipTaskStatus | ClipTaskItemStatus;
  progress: number;
  message?: string;
  errorCode?: string;
  errorMessage?: string;
}
```

响应：

```ts
interface ReportClipTaskProgressResp {
  task: ClipTask;
}
```

## 上传 API

上传 API 使用短期 upload token。token 由 Hub 在 `requestCreateClip` 事件中下发，或由创建上传会话接口返回。token 必须和 `taskId`、`itemId`、`uploadId`、`uca` 绑定。

### POST /api/clips/tasks/:taskId/uploads

创建上传会话。

请求头：

- `X-UCA`
- `X-Upload-Token`

请求：

```ts
interface CreateClipUploadReq {
  itemId: string;
  trackId: string;
  role: 'media' | 'thumbnail';
  fileName: string;
  mimeType: 'video/mp4' | 'video/webm' | 'image/webp' | 'image/jpeg' | 'image/png';
  uploadLength: number;
  checksumSha256: string;
}
```

响应：

```ts
interface CreateClipUploadResp {
  uploadId: string;
  uploadUrl: string;
  offset: 0;
  expiresAt: number;
}
```

### HEAD /api/clips/uploads/:uploadId

查询当前上传偏移。该接口不使用 `Resp` JSON 包装。

请求头：

- `X-UCA`
- `X-Upload-Token`

成功响应：

```http
HTTP/1.1 204 No Content
Upload-Offset: 1048576
Upload-Length: 5242880
Upload-Expires: Tue, 26 May 2026 12:00:00 GMT
```

### PATCH /api/clips/uploads/:uploadId

追加上传媒体分块。该接口不使用 `Resp` JSON 包装。

请求头：

```http
Content-Type: application/offset+octet-stream
X-UCA: contest-alias
X-Upload-Token: token
Upload-Offset: 1048576
```

请求体为二进制分块。

成功响应：

```http
HTTP/1.1 204 No Content
Upload-Offset: 2097152
```

如果客户端提交的 `Upload-Offset` 与服务端已保存偏移不一致，返回：

```http
HTTP/1.1 409 Conflict
Upload-Offset: 2097152
```

### POST /api/clips/uploads/:uploadId/complete

完成上传并提交媒体元数据。

请求头：

- `X-UCA`
- `X-Upload-Token`

请求：

```ts
interface CompleteClipUploadReq {
  metadata: {
    actualStartServerMs: number;
    actualEndServerMs: number;
    durationMs: number;
    width?: number;
    height?: number;
    videoCodec?: string;
    audioCodec?: string;
    container: 'mp4' | 'webm';
    bitrate?: number;
    frameRate?: number;
  };
  thumbnail?: {
    mimeType: 'image/webp' | 'image/jpeg' | 'image/png';
    byteSize: number;
    checksumSha256: string;
    uploadId: string;
  };
}
```

响应：

```ts
interface CompleteClipUploadResp {
  task: ClipTask;
  clip?: Clip;
}
```

Hub 完成校验后才返回 `clip`。如果校验进入异步队列，可先返回更新后的 `task`，随后通过 Socket.io 推送 `clipTaskUpdated` 和 `clipCreated`。

## 切片消费 API

### GET /api/clips

查询可播放切片列表。

query：

```ts
interface ListClipsReq {
  uca: string;
  userId?: string;
  trackId?: string;
  source?: ClipSource;
  category?: ClipCategory;
  status?: ClipStatus;
  tag?: string;
  createdAfter?: number;
  createdBefore?: number;
  page?: number;
  pageSize?: number;
}
```

响应：

```ts
interface ListClipsResp {
  clips: Clip[];
  total: number;
  page: number;
  pageSize: number;
}
```

### GET /api/clips/:clipId/thumbnail

读取缩略图。该接口返回图片二进制，不使用 `Resp` JSON 包装。没有缩略图时返回 `404`。

### HEAD /api/clips/:clipId/media

查询媒体文件元数据。该接口不使用 `Resp` JSON 包装。

成功响应：

```http
HTTP/1.1 200 OK
Content-Type: video/mp4
Content-Length: 5242880
Accept-Ranges: bytes
ETag: "clip-checksum-sha256"
```

### GET /api/clips/:clipId/media

读取媒体文件。必须支持完整读取和单段 Range。

完整读取响应：

```http
HTTP/1.1 200 OK
Content-Type: video/mp4
Content-Length: 5242880
Accept-Ranges: bytes
```

Range 请求：

```http
Range: bytes=1048576-2097151
```

Range 响应：

```http
HTTP/1.1 206 Partial Content
Content-Type: video/mp4
Content-Range: bytes 1048576-2097151/5242880
Content-Length: 1048576
Accept-Ranges: bytes
```

越界 Range 返回 `416 Range Not Satisfiable`。

### DELETE /api/clips/:clipId

删除或标记过期切片。首版建议软删除，实际文件由清理任务异步删除。

响应：

```ts
interface DeleteClipResp {
  clipId: string;
  status: 'deleted';
}
```

## Socket.io

### /broadcaster 被动事件：requestCreateClip

Hub 向指定 KtB 下发切片请求。

请求参数：

```ts
interface RequestCreateClipPayload {
  taskId: string;
  uca: string;
  userId: string;
  startServerMs: number;
  endServerMs: number;
  items: {
    itemId: string;
    trackId: string;
    uploadToken: string;
    uploadTokenExpiresAt: number;
  }[];
  preferred: {
    containers: ('mp4' | 'webm')[];
    maxUploadBytes: number;
  };
}
```

KtB ack：

```ts
interface RequestCreateClipAck {
  accepted: boolean;
  errorCode?: string;
  errorMessage?: string;
}
```

如果 KtB 返回 `accepted: false`，Hub 应将任务置为可重试或失败，具体取决于 `errorCode`。

### /clips 命名空间

KtO 可连接 `/clips` 订阅精彩回放事件。

鉴权：

基础字段：

- `uca: string`

auth 字段：

- `directorToken: string`

#### 主动事件：subscribeClips

请求参数：

```ts
interface SubscribeClipsReq {
  categories?: ClipCategory[];
  userIds?: string[];
}
```

响应数据：

```ts
interface SubscribeClipsResp {
  subscribed: true;
  serverTimestamp: number;
}
```

#### 被动事件：clipTaskUpdated

```ts
interface ClipTaskUpdatedEvent {
  task: ClipTask;
}
```

#### 被动事件：clipCreated

```ts
interface ClipCreatedEvent {
  clip: Clip;
}
```

#### 被动事件：clipDeleted

```ts
interface ClipDeletedEvent {
  clipId: string;
  status: 'deleted' | 'expired';
}
```

## 错误码建议

建议为精彩回放预留 `300000` 段错误码：

```ts
enum ClipErrCode {
  ClipAutomationNotFound = 300000,
  ClipAutomationInvalidTrigger = 300001,
  ClipTaskNotFound = 300010,
  ClipTaskInvalidTimeWindow = 300011,
  ClipTaskTargetOffline = 300012,
  ClipTaskTrackNotFound = 300013,
  ClipTaskRecordingRangeMissing = 300014,
  ClipUploadNotFound = 300020,
  ClipUploadOffsetMismatch = 300021,
  ClipUploadChecksumMismatch = 300022,
  ClipUploadExpired = 300023,
  ClipMediaValidationFailed = 300030,
  ClipNotFound = 300040,
  ClipMediaRangeNotSatisfiable = 300041,
}
```

## 参考标准

- [TUS resumable upload protocol](https://tus.io/protocols/resumable-upload)：用于参考 `Upload-Offset`、`HEAD`、`PATCH` 的断点续传语义。
- [RFC 9110 HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110)：用于参考 `Range`、`206 Partial Content`、`416 Range Not Satisfiable` 行为。
- [FFmpeg formats documentation](https://ffmpeg.org/ffmpeg-formats.html)：用于参考 segment muxer 与 concat demuxer，约束 KtB 本地分段录制、关键帧间隔和同编码分段拼接。
