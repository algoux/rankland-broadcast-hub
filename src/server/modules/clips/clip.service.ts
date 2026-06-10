import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { EventEmitter, once } from 'events';
import { Readable } from 'stream';
import { Inject, Provide } from 'bwcx-core';
import { ErrCode } from '@common/enums/err-code.enum';
import type {
  Clip,
  ClipAutomationRun,
  ClipAutomationTask,
  ClipStatus,
  ClipTask,
  ClipTaskItem,
  ClipTaskItemStatus,
  ClipTaskStatus,
  CompleteClipUploadReq,
  CreateClipAutomationReq,
  CreateClipAutomationRunReq,
  CreateClipTaskReq,
  CreateClipUploadReq,
  ReportClipTaskProgressReq,
  RequestCreateClipPayload,
  UpdateClipAutomationReq,
  UpdateClipAutomationRunReq,
} from '@common/modules/clips';
import ClipConfig from '@server/configs/clips/clip.config';
import LogicException from '@server/exceptions/logic.exception';
import LiveContestService from '@server/modules/live-contest/live-contest.service';
import ClipRepository, { ClipUpload, StoredClip } from './clip.repository';

type ClipServiceEvent = 'clipTaskQueued' | 'clipTaskUpdated' | 'clipCreated' | 'clipDeleted';

@Provide()
export default class ClipService extends EventEmitter {
  private readonly uploadLocks: Map<string, Promise<void>> = new Map();

  public constructor(
    @Inject(ClipRepository) private readonly repository: ClipRepository,
    @Inject(ClipConfig) private readonly config: ClipConfig,
    @Inject(LiveContestService) private readonly liveContestService: LiveContestService,
  ) {
    super();
  }

  public override on(event: 'clipTaskQueued' | 'clipTaskUpdated', listener: (task: ClipTask) => void): this;
  public override on(event: 'clipCreated', listener: (clip: Clip) => void): this;
  public override on(event: 'clipDeleted', listener: (event: { clipId: string; status: 'deleted' | 'expired'; uca: string }) => void): this;
  public override on(event: ClipServiceEvent, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  public async createAutomation(uca: string, req: CreateClipAutomationReq): Promise<ClipAutomationTask> {
    this.validateAutomation(req);
    const now = Date.now();
    const automation: ClipAutomationTask = {
      automationId: createId('clip_auto'),
      uca,
      name: req.name.trim(),
      enabled: req.enabled !== false,
      trigger: req.trigger,
      target: req.target,
      clipWindow: req.clipWindow,
      defaults: {
        ...req.defaults,
        tags: req.defaults.tags || [],
      },
      createdAt: now,
      updatedAt: now,
    };
    return this.repository.createAutomation(automation);
  }

  public async listAutomations(query: {
    uca: string;
    enabled?: boolean;
    triggerKind?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{ automations: ClipAutomationTask[]; total: number; page: number; pageSize: number }> {
    const result = this.repository.listAutomations(query);
    return { automations: result.items, total: result.total, page: result.page, pageSize: result.pageSize };
  }

  public async getAutomation(uca: string, automationId: string): Promise<ClipAutomationTask> {
    const automation = this.repository.getAutomation(uca, automationId);
    if (!automation) {
      throw new LogicException(ErrCode.ClipAutomationNotFound);
    }
    return automation;
  }

  public async updateAutomation(
    uca: string,
    automationId: string,
    req: UpdateClipAutomationReq,
  ): Promise<ClipAutomationTask> {
    const existing = await this.getAutomation(uca, automationId);
    this.validateAutomation({
      name: req.name || existing.name,
      enabled: req.enabled === undefined ? existing.enabled : req.enabled,
      trigger: req.trigger || existing.trigger,
      target: req.target || existing.target,
      clipWindow: req.clipWindow || existing.clipWindow,
      defaults: req.defaults || existing.defaults,
    });
    const updated = this.repository.updateAutomation(uca, automationId, {
      ...req,
      updatedAt: Date.now(),
    });
    if (!updated) {
      throw new LogicException(ErrCode.ClipAutomationNotFound);
    }
    return updated;
  }

  public async deleteAutomation(uca: string, automationId: string): Promise<{ automationId: string; deleted: true }> {
    const deleted = this.repository.softDeleteAutomation(uca, automationId, Date.now());
    if (!deleted) {
      throw new LogicException(ErrCode.ClipAutomationNotFound);
    }
    return { automationId, deleted: true };
  }

  public async createAutomationRun(
    uca: string,
    automationId: string,
    req: CreateClipAutomationRunReq,
  ): Promise<ClipAutomationRun> {
    await this.getAutomation(uca, automationId);
    const existing = this.repository.findAutomationRunByTriggerKey(uca, automationId, req.triggerKey);
    if (existing) {
      return existing;
    }
    const now = Date.now();
    return this.repository.createAutomationRun({
      runId: createId('clip_run'),
      automationId,
      uca,
      triggerKind: req.triggerKind,
      triggerKey: req.triggerKey,
      eventServerMs: req.eventServerMs,
      payload: req.payload || {},
      createdTaskIds: [],
      status: req.status || 'matched',
      errorCode: req.errorCode,
      errorMessage: req.errorMessage,
      createdAt: now,
    });
  }

  public async listAutomationRuns(
    uca: string,
    automationId: string,
    query: { status?: ClipAutomationRun['status']; page?: number; pageSize?: number },
  ): Promise<{ runs: ClipAutomationRun[]; total: number; page: number; pageSize: number }> {
    await this.getAutomation(uca, automationId);
    const result = this.repository.listAutomationRuns(uca, automationId, query);
    return { runs: result.items, total: result.total, page: result.page, pageSize: result.pageSize };
  }

  public async updateAutomationRun(
    uca: string,
    runId: string,
    req: UpdateClipAutomationRunReq,
  ): Promise<ClipAutomationRun> {
    const updated = this.repository.updateAutomationRun(uca, runId, req);
    if (!updated) {
      throw new LogicException(ErrCode.ClipAutomationNotFound);
    }
    return updated;
  }

  public async createTask(uca: string, req: CreateClipTaskReq): Promise<ClipTask> {
    if (req.idempotencyKey) {
      const existing = this.repository.findTaskByIdempotencyKey(uca, req.idempotencyKey);
      if (existing) {
        return existing;
      }
    }
    await this.validateTaskRequest(uca, req);
    const now = Date.now();
    const taskId = createId('clip_task');
    const expiresAt = now + this.config.defaultRetentionDays * 24 * 60 * 60 * 1000;
    const items: ClipTaskItem[] = req.trackIds.map((trackId) => ({
      itemId: createId('clip_item'),
      taskId,
      uca,
      userId: req.userId,
      trackId,
      status: 'queued',
      progress: 0,
      createdAt: now,
      updatedAt: now,
    }));
    const task: ClipTask = {
      taskId,
      uca,
      source: req.source,
      automationId: req.automationId,
      automationRunId: req.automationRunId,
      title: req.title.trim(),
      category: req.category,
      tags: req.tags || [],
      priority: req.priority || 'normal',
      userId: req.userId,
      status: 'queued',
      startServerMs: req.startServerMs,
      endServerMs: req.endServerMs,
      attempts: 0,
      maxAttempts: req.maxAttempts || this.config.taskMaxAttempts,
      progress: 0,
      items,
      createdClipIds: [],
      createdAt: now,
      updatedAt: now,
      expiresAt,
    };
    const created = this.repository.createTask(task, req.idempotencyKey);
    this.emit('clipTaskUpdated', created);
    this.emit('clipTaskQueued', created);
    return created;
  }

  public async listTasks(query: {
    uca: string;
    source?: string;
    userId?: string;
    status?: string;
    category?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{ tasks: ClipTask[]; total: number; page: number; pageSize: number }> {
    const result = this.repository.listTasks(query);
    return { tasks: result.items, total: result.total, page: result.page, pageSize: result.pageSize };
  }

  public async getTask(taskId: string): Promise<ClipTask> {
    const task = this.repository.getTask(taskId);
    if (!task) {
      throw new LogicException(ErrCode.ClipTaskNotFound);
    }
    return task;
  }

  public async reportProgress(uca: string, taskId: string, req: ReportClipTaskProgressReq): Promise<ClipTask> {
    const task = await this.getTask(taskId);
    if (task.uca !== uca) {
      throw new LogicException(ErrCode.ClipTaskNotFound);
    }
    const now = Date.now();
    this.validateProgressStatus(req.status, Boolean(req.itemId));
    if (req.itemId) {
      const item = task.items.find((candidate) => candidate.itemId === req.itemId);
      if (!item) {
        throw new LogicException(ErrCode.ClipTaskNotFound);
      }
      this.repository.updateTaskItem(req.itemId, {
        status: req.status as ClipTaskItemStatus,
        progress: clampProgress(req.progress),
        errorCode: req.errorCode,
        errorMessage: req.errorMessage || req.message,
        updatedAt: now,
      });
      await this.recalculateTask(taskId);
    } else {
      this.repository.updateTask(taskId, {
        status: req.status as ClipTaskStatus,
        progress: clampProgress(req.progress),
        errorCode: req.errorCode,
        errorMessage: req.errorMessage || req.message,
        updatedAt: now,
      });
    }
    const updated = await this.getTask(taskId);
    this.emit('clipTaskUpdated', updated);
    return updated;
  }

  public async beginTaskDispatch(taskId: string): Promise<RequestCreateClipPayload> {
    const task = await this.getTask(taskId);
    const now = Date.now();
    const uploadTokenExpiresAt = now + this.config.uploadTokenTtlMs;
    const payloadItems: RequestCreateClipPayload['items'] = [];
    task.items
      .filter((item) => item.status !== 'ready' && item.status !== 'cancelled')
      .forEach((item) => {
        const uploadToken = createToken();
        payloadItems.push({
          itemId: item.itemId,
          trackId: item.trackId,
          uploadToken,
          uploadTokenExpiresAt,
        });
        this.repository.updateTaskItem(item.itemId, {
          status: 'requested',
          progress: 0,
          errorCode: '',
          errorMessage: '',
          uploadTokenHash: hashSecret(uploadToken),
          uploadTokenExpiresAt,
          updatedAt: now,
        });
      });
    const updated = this.repository.updateTask(taskId, {
      status: 'requested',
      attempts: task.attempts + 1,
      errorCode: '',
      errorMessage: '',
      updatedAt: now,
    });
    if (updated) {
      this.emit('clipTaskUpdated', updated);
    }
    return {
      taskId: task.taskId,
      uca: task.uca,
      userId: task.userId,
      startServerMs: task.startServerMs,
      endServerMs: task.endServerMs,
      items: payloadItems,
      preferred: {
        containers: ['mp4', 'webm'],
        maxUploadBytes: this.config.maxUploadBytes,
      },
    };
  }

  public async markTaskDispatchFailed(
    taskId: string,
    errorCode: string,
    errorMessage: string | undefined,
    retryable: boolean,
  ): Promise<ClipTask> {
    const task = await this.getTask(taskId);
    const shouldFail = !retryable || task.attempts >= task.maxAttempts;
    const nextStatus: ClipTaskStatus = shouldFail ? 'failed' : 'queued';
    task.items
      .filter((item) => item.status !== 'ready' && item.status !== 'cancelled')
      .forEach((item) => {
        this.repository.updateTaskItem(item.itemId, {
          status: shouldFail ? 'failed' : 'queued',
          errorCode,
          errorMessage,
          updatedAt: Date.now(),
        });
      });
    const updated = this.repository.updateTask(taskId, {
      status: nextStatus,
      errorCode,
      errorMessage,
      updatedAt: Date.now(),
    })!;
    this.emit('clipTaskUpdated', updated);
    if (!shouldFail) {
      this.emit('clipTaskQueued', updated);
    }
    return updated;
  }

  public async createUpload(
    uca: string,
    taskId: string,
    uploadToken: string,
    req: CreateClipUploadReq,
  ): Promise<{ uploadId: string; uploadUrl: string; offset: 0; expiresAt: number }> {
    const task = await this.getTask(taskId);
    if (task.uca !== uca) {
      throw new LogicException(ErrCode.ClipTaskNotFound);
    }
    const item = this.repository.getTaskItem(req.itemId);
    if (!item || item.taskId !== taskId || item.trackId !== req.trackId) {
      throw new LogicException(ErrCode.ClipTaskNotFound);
    }
    this.verifyItemToken(item, uploadToken);
    this.validateUploadRequest(req);
    this.assertStorageQuota(req.uploadLength);

    const now = Date.now();
    const uploadId = createId('clip_upload');
    const storagePath = path.join(uca, 'uploads', `${uploadId}.part`);
    fs.mkdirSync(path.dirname(this.getAbsolutePath(storagePath)), { recursive: true });
    fs.closeSync(fs.openSync(this.getAbsolutePath(storagePath), 'a'));
    this.repository.createUpload({
      uploadId,
      uca,
      taskId,
      itemId: req.itemId,
      trackId: req.trackId,
      role: req.role,
      fileName: req.fileName,
      mimeType: req.mimeType,
      uploadLength: req.uploadLength,
      offset: 0,
      checksumSha256: req.checksumSha256,
      tokenHash: hashSecret(uploadToken),
      storagePath,
      status: 'created',
      expiresAt: now + this.config.uploadTokenTtlMs,
      createdAt: now,
      updatedAt: now,
    });
    if (req.role === 'media') {
      this.repository.updateTaskItem(req.itemId, {
        uploadId,
        status: 'uploading',
        progress: 0,
        updatedAt: now,
      });
      const updated = await this.recalculateTask(taskId);
      this.emit('clipTaskUpdated', updated);
    }
    return {
      uploadId,
      uploadUrl: `/api/clips/uploads/${uploadId}`,
      offset: 0,
      expiresAt: now + this.config.uploadTokenTtlMs,
    };
  }

  public async getUploadHead(
    uca: string,
    uploadToken: string,
    uploadId: string,
  ): Promise<{ offset: number; uploadLength: number; expiresAt: number }> {
    const upload = this.getAuthorizedUpload(uca, uploadToken, uploadId);
    return {
      offset: upload.offset,
      uploadLength: upload.uploadLength,
      expiresAt: upload.expiresAt,
    };
  }

  public async appendUploadStream(
    uca: string,
    uploadToken: string,
    uploadId: string,
    uploadOffset: number,
    stream: Readable,
  ): Promise<{ offset: number }> {
    return this.withUploadLock(uploadId, async () => {
      const upload = this.getAuthorizedUpload(uca, uploadToken, uploadId);
      if (uploadOffset !== upload.offset) {
        throw new LogicException(ErrCode.ClipUploadOffsetMismatch);
      }
      if (upload.status === 'completed') {
        return { offset: upload.offset };
      }
      const absPath = this.getAbsolutePath(upload.storagePath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.closeSync(fs.openSync(absPath, 'a'));
      fs.truncateSync(absPath, upload.offset);
      const output = fs.createWriteStream(absPath, { flags: 'r+', start: upload.offset });
      let received = 0;
      try {
        for await (const chunk of stream) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (upload.offset + received + buffer.length > upload.uploadLength) {
            throw new LogicException(ErrCode.IllegalParameters);
          }
          if (!output.write(buffer)) {
            await once(output, 'drain');
          }
          received += buffer.length;
        }
        output.end();
        await once(output, 'finish');
      } catch (error) {
        output.destroy();
        fs.truncateSync(absPath, upload.offset);
        throw error;
      }
      const nextOffset = upload.offset + received;
      const updated = this.repository.updateUpload(uploadId, {
        offset: nextOffset,
        status: nextOffset > 0 ? 'uploading' : upload.status,
        updatedAt: Date.now(),
      })!;
      return { offset: updated.offset };
    });
  }

  public async completeUpload(
    uca: string,
    uploadToken: string,
    uploadId: string,
    req: CompleteClipUploadReq,
  ): Promise<{ task: ClipTask; clip?: Clip }> {
    return this.withUploadLock(uploadId, async () => {
      const upload = this.getAuthorizedUpload(uca, uploadToken, uploadId);
      if (upload.offset !== upload.uploadLength) {
        throw new LogicException(ErrCode.ClipMediaValidationFailed);
      }
      if (upload.status === 'completed') {
        return this.getCompletedUploadResult(upload);
      }
      if (upload.role === 'thumbnail') {
        await this.verifyUploadChecksum(upload);
        this.repository.updateUpload(upload.uploadId, { status: 'completed', updatedAt: Date.now() });
        const task = await this.getTask(upload.taskId);
        return { task };
      }

      const checksum = await this.verifyUploadChecksum(upload);
      await this.validateMedia(upload, req.metadata);
      const absPath = this.getAbsolutePath(upload.storagePath);

      const task = await this.getTask(upload.taskId);
      const item = task.items.find((candidate) => candidate.itemId === upload.itemId);
      if (!item) {
        throw new LogicException(ErrCode.ClipTaskNotFound);
      }
      const now = Date.now();
      const clipId = createId('clip');
      const clipDir = path.join(uca, 'clips', clipId);
      fs.mkdirSync(this.getAbsolutePath(clipDir), { recursive: true });
      const mediaPath = path.join(clipDir, `media.${req.metadata.container}`);
      fs.renameSync(absPath, this.getAbsolutePath(mediaPath));

      const thumbnailPath = req.thumbnail ? this.consumeThumbnailUpload(uca, uploadToken, clipDir, req.thumbnail) : undefined;
      const clip: StoredClip = {
        clipId,
        uca,
        taskId: task.taskId,
        itemId: item.itemId,
        userId: task.userId,
        trackId: item.trackId,
        source: task.source,
        category: task.category,
        title: task.title,
        tags: task.tags,
        mediaPath,
        thumbnailPath,
        mimeType: upload.mimeType,
        byteSize: upload.uploadLength,
        durationMs: req.metadata.durationMs,
        width: req.metadata.width,
        height: req.metadata.height,
        videoCodec: req.metadata.videoCodec,
        audioCodec: req.metadata.audioCodec,
        checksumSha256: checksum,
        actualStartServerMs: req.metadata.actualStartServerMs,
        actualEndServerMs: req.metadata.actualEndServerMs,
        mediaUrl: `/api/clips/${clipId}/media`,
        thumbnailUrl: thumbnailPath ? `/api/clips/${clipId}/thumbnail` : undefined,
        status: 'ready',
        createdAt: now,
        expiresAt: task.expiresAt,
      };
      this.repository.createClip(clip);
      this.repository.updateUpload(uploadId, { status: 'completed', storagePath: mediaPath, updatedAt: now });
      this.repository.updateTaskItem(item.itemId, {
        status: 'ready',
        progress: 100,
        clipId,
        actualStartServerMs: req.metadata.actualStartServerMs,
        actualEndServerMs: req.metadata.actualEndServerMs,
        updatedAt: now,
      });
      const updatedTask = await this.recalculateTask(task.taskId, clipId);
      const publicClip = this.toPublicClip(clip);
      this.emit('clipCreated', publicClip);
      this.emit('clipTaskUpdated', updatedTask);
      return { task: updatedTask, clip: publicClip };
    });
  }

  public async listClips(query: {
    uca: string;
    userId?: string;
    trackId?: string;
    source?: string;
    category?: string;
    status?: ClipStatus;
    tag?: string;
    createdAfter?: number;
    createdBefore?: number;
    page?: number;
    pageSize?: number;
  }): Promise<{ clips: Clip[]; total: number; page: number; pageSize: number }> {
    const result = this.repository.listClips(query);
    return {
      clips: result.items.map((clip) => this.toPublicClip(clip)),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    };
  }

  public async getClip(uca: string, clipId: string): Promise<Clip> {
    return this.toPublicClip(await this.getStoredClip(uca, clipId));
  }

  public async getClipMedia(uca: string, clipId: string): Promise<{ clip: Clip; path: string; size: number }> {
    const stored = await this.getStoredClip(uca, clipId);
    if (stored.status !== 'ready') {
      throw new LogicException(ErrCode.ClipNotFound);
    }
    const absPath = this.getAbsolutePath(stored.mediaPath);
    return {
      clip: this.toPublicClip(stored),
      path: absPath,
      size: fs.statSync(absPath).size,
    };
  }

  public async getClipThumbnail(uca: string, clipId: string): Promise<{ clip: Clip; path: string; size: number }> {
    const stored = await this.getStoredClip(uca, clipId);
    if (stored.status !== 'ready' || !stored.thumbnailPath) {
      throw new LogicException(ErrCode.ClipNotFound);
    }
    const absPath = this.getAbsolutePath(stored.thumbnailPath);
    return {
      clip: this.toPublicClip(stored),
      path: absPath,
      size: fs.statSync(absPath).size,
    };
  }

  public async deleteClip(uca: string, clipId: string): Promise<{ clipId: string; status: 'deleted' }> {
    const clip = this.repository.updateClipStatus(uca, clipId, 'deleted');
    if (!clip) {
      throw new LogicException(ErrCode.ClipNotFound);
    }
    this.emit('clipDeleted', { uca, clipId, status: 'deleted' });
    return { clipId, status: 'deleted' };
  }

  public async findDispatchableTasks(uca: string, userId: string): Promise<ClipTask[]> {
    const queued = this.repository.listTasks({ uca, userId, status: 'queued', pageSize: 100 }).items;
    return queued.filter((task) => task.attempts < task.maxAttempts);
  }

  private async validateTaskRequest(uca: string, req: CreateClipTaskReq): Promise<void> {
    if (!req.userId || !Array.isArray(req.trackIds) || req.trackIds.length === 0) {
      throw new LogicException(ErrCode.IllegalParameters);
    }
    if (req.trackIds.length > this.config.maxTracksPerTask) {
      throw new LogicException(ErrCode.IllegalParameters);
    }
    if (!Number.isFinite(req.startServerMs) || !Number.isFinite(req.endServerMs) || req.endServerMs <= req.startServerMs) {
      throw new LogicException(ErrCode.ClipTaskInvalidTimeWindow);
    }
    if (req.endServerMs - req.startServerMs > this.config.maxDurationMs) {
      throw new LogicException(ErrCode.ClipTaskInvalidTimeWindow);
    }
    const tracks = await this.liveContestService.getBroadcasterStoreTracks(uca, req.userId);
    if (!tracks) {
      throw new LogicException(ErrCode.ClipTaskTargetOffline);
    }
    const trackSet = new Set(tracks.map((track) => track.trackId));
    const allTracksFound = req.trackIds.every((trackId) => trackSet.has(trackId));
    if (!allTracksFound) {
      throw new LogicException(ErrCode.ClipTaskTrackNotFound);
    }
  }

  private validateAutomation(req: CreateClipAutomationReq): void {
    if (!req.name || !req.trigger || !['manualOnly', 'firstBlood', 'accepted'].includes(req.trigger.kind)) {
      throw new LogicException(ErrCode.ClipAutomationInvalidTrigger);
    }
    if (!req.target || req.target.userSelector !== 'eventUser' || !Array.isArray(req.target.trackIds)) {
      throw new LogicException(ErrCode.IllegalParameters);
    }
    if (
      !req.clipWindow ||
      req.clipWindow.minDurationMs < 0 ||
      req.clipWindow.maxDurationMs <= 0 ||
      req.clipWindow.maxDurationMs > this.config.maxDurationMs ||
      req.clipWindow.minDurationMs > req.clipWindow.maxDurationMs
    ) {
      throw new LogicException(ErrCode.ClipTaskInvalidTimeWindow);
    }
    if (!req.defaults || !['firstBlood', 'accepted', 'manual', 'other'].includes(req.defaults.category)) {
      throw new LogicException(ErrCode.IllegalParameters);
    }
  }

  private validateUploadRequest(req: CreateClipUploadReq): void {
    if (!['media', 'thumbnail'].includes(req.role) || req.uploadLength <= 0 || req.uploadLength > this.config.maxUploadBytes) {
      throw new LogicException(ErrCode.IllegalParameters);
    }
    const mediaTypes = ['video/mp4', 'video/webm'];
    const imageTypes = ['image/webp', 'image/jpeg', 'image/png'];
    if (req.role === 'media' && !mediaTypes.includes(req.mimeType)) {
      throw new LogicException(ErrCode.IllegalParameters);
    }
    if (req.role === 'thumbnail' && !imageTypes.includes(req.mimeType)) {
      throw new LogicException(ErrCode.IllegalParameters);
    }
    if (!/^[a-f0-9]{64}$/i.test(req.checksumSha256)) {
      throw new LogicException(ErrCode.IllegalParameters);
    }
  }

  private validateProgressStatus(status: ClipTaskStatus | ClipTaskItemStatus | undefined, isItemProgress: boolean): void {
    if (!status) {
      return;
    }
    const allowed = isItemProgress
      ? ['client_processing', 'uploading', 'failed', 'cancelled']
      : ['requested', 'client_processing', 'uploading', 'failed', 'cancelled'];
    if (!allowed.includes(status)) {
      throw new LogicException(ErrCode.IllegalParameters);
    }
  }

  private verifyItemToken(
    item: ClipTaskItem & { uploadTokenHash?: string; uploadTokenExpiresAt?: number },
    uploadToken: string,
  ): void {
    if (!item.uploadTokenHash || item.uploadTokenHash !== hashSecret(uploadToken)) {
      throw new LogicException(ErrCode.InvalidAuthInfo);
    }
    if (!item.uploadTokenExpiresAt || item.uploadTokenExpiresAt <= Date.now()) {
      throw new LogicException(ErrCode.ClipUploadExpired);
    }
  }

  private getAuthorizedUpload(uca: string, uploadToken: string, uploadId: string): ClipUpload {
    const upload = this.repository.getUpload(uploadId);
    if (!upload || upload.uca !== uca) {
      throw new LogicException(ErrCode.ClipUploadNotFound);
    }
    if (upload.tokenHash !== hashSecret(uploadToken)) {
      throw new LogicException(ErrCode.InvalidAuthInfo);
    }
    if (upload.expiresAt <= Date.now() || upload.status === 'expired') {
      throw new LogicException(ErrCode.ClipUploadExpired);
    }
    return upload;
  }

  private async verifyUploadChecksum(upload: ClipUpload): Promise<string> {
    const absPath = this.getAbsolutePath(upload.storagePath);
    const stat = fs.statSync(absPath);
    if (stat.size !== upload.uploadLength) {
      this.repository.updateUpload(upload.uploadId, { status: 'failed', updatedAt: Date.now() });
      throw new LogicException(ErrCode.ClipMediaValidationFailed);
    }
    const checksum = await sha256File(absPath);
    if (checksum !== upload.checksumSha256) {
      this.repository.updateUpload(upload.uploadId, { status: 'failed', updatedAt: Date.now() });
      throw new LogicException(ErrCode.ClipUploadChecksumMismatch);
    }
    return checksum;
  }

  private async getCompletedUploadResult(upload: ClipUpload): Promise<{ task: ClipTask; clip?: Clip }> {
    const task = await this.getTask(upload.taskId);
    if (upload.role !== 'media') {
      return { task };
    }
    const item = this.repository.getTaskItem(upload.itemId);
    if (!item?.clipId) {
      return { task };
    }
    const clip = this.repository.getClip(upload.uca, item.clipId);
    return {
      task,
      clip: clip ? this.toPublicClip(clip) : undefined,
    };
  }

  private async validateMedia(upload: ClipUpload, metadata: CompleteClipUploadReq['metadata']): Promise<void> {
    if (!metadata || metadata.actualEndServerMs <= metadata.actualStartServerMs || metadata.durationMs <= 0) {
      throw new LogicException(ErrCode.ClipMediaValidationFailed);
    }
    if (metadata.durationMs > this.config.maxDurationMs) {
      throw new LogicException(ErrCode.ClipMediaValidationFailed);
    }
    if ((upload.mimeType === 'video/mp4' && metadata.container !== 'mp4') || (upload.mimeType === 'video/webm' && metadata.container !== 'webm')) {
      throw new LogicException(ErrCode.ClipMediaValidationFailed);
    }
    const fd = fs.openSync(this.getAbsolutePath(upload.storagePath), 'r');
    try {
      const header = Buffer.alloc(16);
      fs.readSync(fd, header, 0, header.length, 0);
      if (metadata.container === 'mp4' && header.subarray(4, 8).toString('ascii') !== 'ftyp') {
        throw new LogicException(ErrCode.ClipMediaValidationFailed);
      }
      if (metadata.container === 'webm' && !header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
        throw new LogicException(ErrCode.ClipMediaValidationFailed);
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  private consumeThumbnailUpload(
    uca: string,
    uploadToken: string,
    clipDir: string,
    thumbnail: NonNullable<CompleteClipUploadReq['thumbnail']>,
  ): string {
    const upload = this.getAuthorizedUpload(uca, uploadToken, thumbnail.uploadId);
    if (upload.role !== 'thumbnail' || upload.status !== 'completed') {
      throw new LogicException(ErrCode.ClipMediaValidationFailed);
    }
    if (
      upload.mimeType !== thumbnail.mimeType ||
      upload.uploadLength !== thumbnail.byteSize ||
      upload.checksumSha256 !== thumbnail.checksumSha256
    ) {
      throw new LogicException(ErrCode.ClipMediaValidationFailed);
    }
    const extension = thumbnail.mimeType === 'image/png' ? 'png' : thumbnail.mimeType === 'image/jpeg' ? 'jpg' : 'webp';
    const thumbnailPath = path.join(clipDir, `thumbnail.${extension}`);
    fs.renameSync(this.getAbsolutePath(upload.storagePath), this.getAbsolutePath(thumbnailPath));
    this.repository.updateUpload(upload.uploadId, { storagePath: thumbnailPath, updatedAt: Date.now() });
    return thumbnailPath;
  }

  private async recalculateTask(taskId: string, newClipId?: string): Promise<ClipTask> {
    const task = await this.getTask(taskId);
    const items = task.items;
    const readyCount = items.filter((item) => item.status === 'ready').length;
    const failedCount = items.filter((item) => item.status === 'failed' || item.status === 'cancelled').length;
    let status: ClipTaskStatus = task.status;
    if (readyCount === items.length) {
      status = 'ready';
    } else if (readyCount > 0 && readyCount + failedCount === items.length) {
      status = 'partial_ready';
    } else if (failedCount === items.length) {
      status = 'failed';
    } else if (items.some((item) => item.status === 'uploading')) {
      status = 'uploading';
    } else if (items.some((item) => item.status === 'client_processing')) {
      status = 'client_processing';
    } else if (items.some((item) => item.status === 'requested')) {
      status = 'requested';
    } else {
      status = 'queued';
    }
    const averageProgress = Math.round(items.reduce((sum, item) => sum + item.progress, 0) / Math.max(items.length, 1));
    const createdClipIds = newClipId && !task.createdClipIds.includes(newClipId) ? [...task.createdClipIds, newClipId] : task.createdClipIds;
    return this.repository.updateTask(taskId, {
      status,
      progress: status === 'ready' ? 100 : averageProgress,
      createdClipIds,
      updatedAt: Date.now(),
    })!;
  }

  private async getStoredClip(uca: string | undefined, clipId: string): Promise<StoredClip> {
    if (!uca) {
      throw new LogicException(ErrCode.IllegalParameters);
    }
    const clip = this.repository.getClip(uca, clipId);
    if (!clip) {
      throw new LogicException(ErrCode.ClipNotFound);
    }
    return clip;
  }

  private toPublicClip(clip: StoredClip): Clip {
    const { mediaPath, thumbnailPath, ...publicClip } = clip;
    return publicClip;
  }

  private getAbsolutePath(relativePath: string): string {
    const root = path.resolve(this.config.storageDir);
    const absPath = path.resolve(root, relativePath);
    if (absPath !== root && !absPath.startsWith(`${root}${path.sep}`)) {
      throw new LogicException(ErrCode.IllegalParameters);
    }
    return absPath;
  }

  private assertStorageQuota(nextBytes: number): void {
    if (this.config.maxStorageBytes <= 0) {
      return;
    }
    if (getDirectorySize(this.config.storageDir, this.getQuotaExcludedPaths()) + nextBytes > this.config.maxStorageBytes) {
      throw new LogicException(ErrCode.IllegalParameters);
    }
  }

  private getQuotaExcludedPaths(): Set<string> {
    const sqlitePath = path.resolve(this.config.sqlitePath);
    return new Set([sqlitePath, `${sqlitePath}-wal`, `${sqlitePath}-shm`]);
  }

  private async withUploadLock<T>(uploadId: string, callback: () => Promise<T>): Promise<T> {
    const previous = this.uploadLocks.get(uploadId) || Promise.resolve();
    let release: () => void = () => undefined;
    const current = previous.catch(() => undefined).then(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    this.uploadLocks.set(uploadId, current);
    await previous.catch(() => undefined);
    try {
      return await callback();
    } finally {
      release();
      if (this.uploadLocks.get(uploadId) === current) {
        this.uploadLocks.delete(uploadId);
      }
    }
  }
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function createToken(): string {
  return `clip_upload_token_${crypto.randomBytes(24).toString('hex')}`;
}

function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(progress)));
}

function getDirectorySize(dirPath: string, excludedPaths = new Set<string>()): number {
  if (excludedPaths.has(path.resolve(dirPath))) {
    return 0;
  }
  if (!fs.existsSync(dirPath)) {
    return 0;
  }
  const stat = fs.statSync(dirPath);
  if (stat.isFile()) {
    return stat.size;
  }
  return fs.readdirSync(dirPath).reduce((sum, entry) => {
    return sum + getDirectorySize(path.join(dirPath, entry), excludedPaths);
  }, 0);
}
