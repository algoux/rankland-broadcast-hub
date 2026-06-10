import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { Inject, Provide } from 'bwcx-core';
import type {
  Clip,
  ClipAutomationRun,
  ClipAutomationTask,
  ClipStatus,
  ClipTask,
  ClipTaskItem,
  ClipTaskItemStatus,
  ClipTaskStatus,
  ClipUploadStatus,
} from '@common/modules/clips';
import ClipConfig from '@server/configs/clips/clip.config';

export interface ClipUpload {
  uploadId: string;
  uca: string;
  taskId: string;
  itemId: string;
  trackId: string;
  role: 'media' | 'thumbnail';
  fileName: string;
  mimeType: string;
  uploadLength: number;
  offset: number;
  checksumSha256: string;
  tokenHash: string;
  storagePath: string;
  status: ClipUploadStatus;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export type StoredClip = Clip & {
  mediaPath: string;
  thumbnailPath?: string;
};

export type ListResult<T> = {
  total: number;
  page: number;
  pageSize: number;
  items: T[];
};

@Provide()
export default class ClipRepository {
  private readonly db: Database.Database;

  public constructor(@Inject(ClipConfig) private readonly config: ClipConfig) {
    fs.mkdirSync(path.dirname(this.config.sqlitePath), { recursive: true });
    this.db = new Database(this.config.sqlitePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  public close(): void {
    this.db.close();
  }

  public createAutomation(automation: ClipAutomationTask): ClipAutomationTask {
    this.db
      .prepare(
        `
        INSERT INTO clip_automation_tasks (
          automation_id, uca, name, enabled, trigger_json, target_json, clip_window_json,
          defaults_json, created_at, updated_at
        ) VALUES (
          @automationId, @uca, @name, @enabled, @triggerJson, @targetJson, @clipWindowJson,
          @defaultsJson, @createdAt, @updatedAt
        )
      `,
      )
      .run({
        automationId: automation.automationId,
        uca: automation.uca,
        name: automation.name,
        enabled: automation.enabled ? 1 : 0,
        triggerJson: JSON.stringify(automation.trigger),
        targetJson: JSON.stringify(automation.target),
        clipWindowJson: JSON.stringify(automation.clipWindow),
        defaultsJson: JSON.stringify(automation.defaults),
        createdAt: automation.createdAt,
        updatedAt: automation.updatedAt,
      });
    return automation;
  }

  public getAutomation(uca: string, automationId: string, includeDeleted = false): ClipAutomationTask | null {
    const row = this.db
      .prepare(
        `
        SELECT * FROM clip_automation_tasks
        WHERE uca = @uca AND automation_id = @automationId ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
      `,
      )
      .get({ uca, automationId });
    return row ? this.mapAutomation(row) : null;
  }

  public listAutomations(query: {
    uca: string;
    enabled?: boolean;
    triggerKind?: string;
    page?: number;
    pageSize?: number;
  }): ListResult<ClipAutomationTask> {
    const { page, pageSize, offset } = normalizePagination(query.page, query.pageSize);
    const where = ['uca = @uca', 'deleted_at IS NULL'];
    const params: any = { uca: query.uca, limit: pageSize, offset };
    if (query.enabled !== undefined) {
      where.push('enabled = @enabled');
      params.enabled = query.enabled ? 1 : 0;
    }
    if (query.triggerKind) {
      where.push("json_extract(trigger_json, '$.kind') = @triggerKind");
      params.triggerKind = query.triggerKind;
    }
    const whereSql = where.join(' AND ');
    const total = (this.db.prepare(`SELECT COUNT(*) AS count FROM clip_automation_tasks WHERE ${whereSql}`).get(params) as any)
      .count as number;
    const rows = this.db
      .prepare(
        `
        SELECT * FROM clip_automation_tasks
        WHERE ${whereSql}
        ORDER BY created_at DESC
        LIMIT @limit OFFSET @offset
      `,
      )
      .all(params);
    return { total, page, pageSize, items: rows.map((row) => this.mapAutomation(row)) };
  }

  public updateAutomation(
    uca: string,
    automationId: string,
    patch: Partial<ClipAutomationTask>,
  ): ClipAutomationTask | null {
    const sets: string[] = ['updated_at = @updatedAt'];
    const params: any = { uca, automationId, updatedAt: patch.updatedAt || Date.now() };
    if (patch.name !== undefined) {
      sets.push('name = @name');
      params.name = patch.name;
    }
    if (patch.enabled !== undefined) {
      sets.push('enabled = @enabled');
      params.enabled = patch.enabled ? 1 : 0;
    }
    if (patch.trigger !== undefined) {
      sets.push('trigger_json = @triggerJson');
      params.triggerJson = JSON.stringify(patch.trigger);
    }
    if (patch.target !== undefined) {
      sets.push('target_json = @targetJson');
      params.targetJson = JSON.stringify(patch.target);
    }
    if (patch.clipWindow !== undefined) {
      sets.push('clip_window_json = @clipWindowJson');
      params.clipWindowJson = JSON.stringify(patch.clipWindow);
    }
    if (patch.defaults !== undefined) {
      sets.push('defaults_json = @defaultsJson');
      params.defaultsJson = JSON.stringify(patch.defaults);
    }
    this.db
      .prepare(
        `
        UPDATE clip_automation_tasks
        SET ${sets.join(', ')}
        WHERE uca = @uca AND automation_id = @automationId AND deleted_at IS NULL
      `,
      )
      .run(params);
    return this.getAutomation(uca, automationId);
  }

  public softDeleteAutomation(uca: string, automationId: string, now: number): boolean {
    const result = this.db
      .prepare(
        `
        UPDATE clip_automation_tasks
        SET deleted_at = @now, updated_at = @now, enabled = 0
        WHERE uca = @uca AND automation_id = @automationId AND deleted_at IS NULL
      `,
      )
      .run({ uca, automationId, now });
    return result.changes > 0;
  }

  public findAutomationRunByTriggerKey(
    uca: string,
    automationId: string,
    triggerKey: string,
  ): ClipAutomationRun | null {
    const row = this.db
      .prepare(
        `
        SELECT * FROM clip_automation_runs
        WHERE uca = @uca AND automation_id = @automationId AND trigger_key = @triggerKey
      `,
      )
      .get({ uca, automationId, triggerKey });
    return row ? this.mapAutomationRun(row) : null;
  }

  public createAutomationRun(run: ClipAutomationRun): ClipAutomationRun {
    this.db
      .prepare(
        `
        INSERT INTO clip_automation_runs (
          run_id, automation_id, uca, trigger_kind, trigger_key, event_server_ms, payload_json,
          created_task_ids_json, status, error_code, error_message, created_at
        ) VALUES (
          @runId, @automationId, @uca, @triggerKind, @triggerKey, @eventServerMs, @payloadJson,
          @createdTaskIdsJson, @status, @errorCode, @errorMessage, @createdAt
        )
      `,
      )
      .run({
        runId: run.runId,
        automationId: run.automationId,
        uca: run.uca,
        triggerKind: run.triggerKind,
        triggerKey: run.triggerKey,
        eventServerMs: run.eventServerMs,
        payloadJson: JSON.stringify(run.payload || {}),
        createdTaskIdsJson: JSON.stringify(run.createdTaskIds || []),
        status: run.status,
        errorCode: run.errorCode || null,
        errorMessage: run.errorMessage || null,
        createdAt: run.createdAt,
      });
    return run;
  }

  public getAutomationRun(uca: string, runId: string): ClipAutomationRun | null {
    const row = this.db
      .prepare('SELECT * FROM clip_automation_runs WHERE uca = @uca AND run_id = @runId')
      .get({ uca, runId });
    return row ? this.mapAutomationRun(row) : null;
  }

  public updateAutomationRun(
    uca: string,
    runId: string,
    patch: Partial<ClipAutomationRun>,
  ): ClipAutomationRun | null {
    const sets: string[] = [];
    const params: any = { uca, runId };
    if (patch.status !== undefined) {
      sets.push('status = @status');
      params.status = patch.status;
    }
    if (patch.createdTaskIds !== undefined) {
      sets.push('created_task_ids_json = @createdTaskIdsJson');
      params.createdTaskIdsJson = JSON.stringify(patch.createdTaskIds);
    }
    if (patch.errorCode !== undefined) {
      sets.push('error_code = @errorCode');
      params.errorCode = patch.errorCode || null;
    }
    if (patch.errorMessage !== undefined) {
      sets.push('error_message = @errorMessage');
      params.errorMessage = patch.errorMessage || null;
    }
    if (sets.length === 0) {
      return this.getAutomationRun(uca, runId);
    }
    this.db
      .prepare(`UPDATE clip_automation_runs SET ${sets.join(', ')} WHERE uca = @uca AND run_id = @runId`)
      .run(params);
    return this.getAutomationRun(uca, runId);
  }

  public listAutomationRuns(
    uca: string,
    automationId: string,
    query: { status?: string; page?: number; pageSize?: number },
  ): ListResult<ClipAutomationRun> {
    const { page, pageSize, offset } = normalizePagination(query.page, query.pageSize);
    const where = ['uca = @uca', 'automation_id = @automationId'];
    const params: any = { uca, automationId, limit: pageSize, offset };
    if (query.status) {
      where.push('status = @status');
      params.status = query.status;
    }
    const whereSql = where.join(' AND ');
    const total = (this.db.prepare(`SELECT COUNT(*) AS count FROM clip_automation_runs WHERE ${whereSql}`).get(params) as any)
      .count as number;
    const rows = this.db
      .prepare(
        `
        SELECT * FROM clip_automation_runs
        WHERE ${whereSql}
        ORDER BY created_at DESC
        LIMIT @limit OFFSET @offset
      `,
      )
      .all(params);
    return { total, page, pageSize, items: rows.map((row) => this.mapAutomationRun(row)) };
  }

  public findTaskByIdempotencyKey(uca: string, idempotencyKey: string): ClipTask | null {
    const row = this.db
      .prepare('SELECT * FROM clip_tasks WHERE uca = @uca AND idempotency_key = @idempotencyKey')
      .get({ uca, idempotencyKey });
    return row ? this.mapTaskWithItems(row) : null;
  }

  public createTask(task: ClipTask, idempotencyKey: string | undefined): ClipTask {
    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `
          INSERT INTO clip_tasks (
            task_id, uca, source, automation_id, automation_run_id, idempotency_key, title,
            category, tags_json, priority, user_id, status, start_server_ms, end_server_ms,
            attempts, max_attempts, progress, error_code, error_message, created_clip_ids_json,
            created_at, updated_at, expires_at
          ) VALUES (
            @taskId, @uca, @source, @automationId, @automationRunId, @idempotencyKey, @title,
            @category, @tagsJson, @priority, @userId, @status, @startServerMs, @endServerMs,
            @attempts, @maxAttempts, @progress, @errorCode, @errorMessage, @createdClipIdsJson,
            @createdAt, @updatedAt, @expiresAt
          )
        `,
        )
        .run({
          taskId: task.taskId,
          uca: task.uca,
          source: task.source,
          automationId: task.automationId || null,
          automationRunId: task.automationRunId || null,
          idempotencyKey: idempotencyKey || null,
          title: task.title,
          category: task.category,
          tagsJson: JSON.stringify(task.tags || []),
          priority: task.priority,
          userId: task.userId,
          status: task.status,
          startServerMs: task.startServerMs,
          endServerMs: task.endServerMs,
          attempts: task.attempts,
          maxAttempts: task.maxAttempts,
          progress: task.progress,
          errorCode: task.errorCode || null,
          errorMessage: task.errorMessage || null,
          createdClipIdsJson: JSON.stringify(task.createdClipIds || []),
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          expiresAt: task.expiresAt,
        });
      task.items.forEach((item) => this.insertTaskItem(item));
    });
    insert();
    return task;
  }

  public getTask(taskId: string): ClipTask | null {
    const row = this.db.prepare('SELECT * FROM clip_tasks WHERE task_id = @taskId').get({ taskId });
    return row ? this.mapTaskWithItems(row) : null;
  }

  public listTasks(query: {
    uca: string;
    source?: string;
    userId?: string;
    status?: string;
    category?: string;
    page?: number;
    pageSize?: number;
  }): ListResult<ClipTask> {
    const { page, pageSize, offset } = normalizePagination(query.page, query.pageSize);
    const where = ['uca = @uca'];
    const params: any = { uca: query.uca, limit: pageSize, offset };
    ['source', 'userId', 'status', 'category'].forEach((key) => {
      const value = (query as any)[key];
      if (value !== undefined) {
        where.push(`${snakeCase(key)} = @${key}`);
        params[key] = value;
      }
    });
    const whereSql = where.join(' AND ');
    const total = (this.db.prepare(`SELECT COUNT(*) AS count FROM clip_tasks WHERE ${whereSql}`).get(params) as any)
      .count as number;
    const rows = this.db
      .prepare(
        `
        SELECT * FROM clip_tasks
        WHERE ${whereSql}
        ORDER BY created_at DESC
        LIMIT @limit OFFSET @offset
      `,
      )
      .all(params);
    return { total, page, pageSize, items: rows.map((row) => this.mapTaskWithItems(row)) };
  }

  public updateTask(taskId: string, patch: Partial<ClipTask>): ClipTask | null {
    const sets: string[] = ['updated_at = @updatedAt'];
    const params: any = { taskId, updatedAt: patch.updatedAt || Date.now() };
    const scalarMap: Record<string, string> = {
      status: 'status',
      attempts: 'attempts',
      progress: 'progress',
      errorCode: 'error_code',
      errorMessage: 'error_message',
    };
    Object.keys(scalarMap).forEach((key) => {
      const value = (patch as any)[key];
      if (value !== undefined) {
        sets.push(`${scalarMap[key]} = @${key}`);
        params[key] = value === '' ? null : value;
      }
    });
    if (patch.createdClipIds !== undefined) {
      sets.push('created_clip_ids_json = @createdClipIdsJson');
      params.createdClipIdsJson = JSON.stringify(patch.createdClipIds);
    }
    this.db.prepare(`UPDATE clip_tasks SET ${sets.join(', ')} WHERE task_id = @taskId`).run(params);
    return this.getTask(taskId);
  }

  public getTaskItems(taskId: string): ClipTaskItem[] {
    return this.db
      .prepare('SELECT * FROM clip_task_items WHERE task_id = @taskId ORDER BY created_at ASC')
      .all({ taskId })
      .map((row) => this.mapTaskItem(row));
  }

  public getTaskItem(itemId: string): (ClipTaskItem & { uploadTokenHash?: string; uploadTokenExpiresAt?: number }) | null {
    const row = this.db.prepare('SELECT * FROM clip_task_items WHERE item_id = @itemId').get({ itemId });
    return row ? this.mapTaskItem(row) : null;
  }

  public updateTaskItem(
    itemId: string,
    patch: Partial<ClipTaskItem> & { uploadTokenHash?: string; uploadTokenExpiresAt?: number },
  ): ClipTaskItem | null {
    const sets: string[] = ['updated_at = @updatedAt'];
    const params: any = { itemId, updatedAt: patch.updatedAt || Date.now() };
    const scalarMap: Record<string, string> = {
      status: 'status',
      uploadId: 'upload_id',
      clipId: 'clip_id',
      progress: 'progress',
      errorCode: 'error_code',
      errorMessage: 'error_message',
      actualStartServerMs: 'actual_start_server_ms',
      actualEndServerMs: 'actual_end_server_ms',
      uploadTokenHash: 'upload_token_hash',
      uploadTokenExpiresAt: 'upload_token_expires_at',
    };
    Object.keys(scalarMap).forEach((key) => {
      const value = (patch as any)[key];
      if (value !== undefined) {
        sets.push(`${scalarMap[key]} = @${key}`);
        params[key] = value === '' ? null : value;
      }
    });
    this.db.prepare(`UPDATE clip_task_items SET ${sets.join(', ')} WHERE item_id = @itemId`).run(params);
    return this.getTaskItem(itemId);
  }

  public createUpload(upload: ClipUpload): ClipUpload {
    this.db
      .prepare(
        `
        INSERT INTO clip_uploads (
          upload_id, uca, task_id, item_id, track_id, role, file_name, mime_type,
          upload_length, offset, checksum_sha256, token_hash, storage_path, status,
          expires_at, created_at, updated_at
        ) VALUES (
          @uploadId, @uca, @taskId, @itemId, @trackId, @role, @fileName, @mimeType,
          @uploadLength, @offset, @checksumSha256, @tokenHash, @storagePath, @status,
          @expiresAt, @createdAt, @updatedAt
        )
      `,
      )
      .run(upload);
    return upload;
  }

  public getUpload(uploadId: string): ClipUpload | null {
    const row = this.db.prepare('SELECT * FROM clip_uploads WHERE upload_id = @uploadId').get({ uploadId });
    return row ? this.mapUpload(row) : null;
  }

  public updateUpload(uploadId: string, patch: Partial<ClipUpload>): ClipUpload | null {
    const sets: string[] = ['updated_at = @updatedAt'];
    const params: any = { uploadId, updatedAt: patch.updatedAt || Date.now() };
    const scalarMap: Record<string, string> = {
      offset: 'offset',
      status: 'status',
      storagePath: 'storage_path',
    };
    Object.keys(scalarMap).forEach((key) => {
      const value = (patch as any)[key];
      if (value !== undefined) {
        sets.push(`${scalarMap[key]} = @${key}`);
        params[key] = value === '' ? null : value;
      }
    });
    this.db.prepare(`UPDATE clip_uploads SET ${sets.join(', ')} WHERE upload_id = @uploadId`).run(params);
    return this.getUpload(uploadId);
  }

  public createClip(clip: StoredClip): StoredClip {
    this.db
      .prepare(
        `
        INSERT INTO clips (
          clip_id, uca, task_id, item_id, user_id, track_id, source, category, title, tags_json,
          media_path, thumbnail_path, mime_type, byte_size, duration_ms, width, height,
          video_codec, audio_codec, checksum_sha256, actual_start_server_ms, actual_end_server_ms,
          status, created_at, expires_at
        ) VALUES (
          @clipId, @uca, @taskId, @itemId, @userId, @trackId, @source, @category, @title, @tagsJson,
          @mediaPath, @thumbnailPath, @mimeType, @byteSize, @durationMs, @width, @height,
          @videoCodec, @audioCodec, @checksumSha256, @actualStartServerMs, @actualEndServerMs,
          @status, @createdAt, @expiresAt
        )
      `,
      )
      .run({
        ...clip,
        tagsJson: JSON.stringify(clip.tags || []),
        thumbnailPath: clip.thumbnailPath || null,
        width: clip.width || null,
        height: clip.height || null,
        videoCodec: clip.videoCodec || null,
        audioCodec: clip.audioCodec || null,
      });
    return clip;
  }

  public getClip(uca: string | undefined, clipId: string): StoredClip | null {
    const row = this.db
      .prepare(`SELECT * FROM clips WHERE clip_id = @clipId ${uca ? 'AND uca = @uca' : ''}`)
      .get({ uca, clipId });
    return row ? this.mapClip(row) : null;
  }

  public listClips(query: {
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
  }): ListResult<StoredClip> {
    const { page, pageSize, offset } = normalizePagination(query.page, query.pageSize);
    const where = ['uca = @uca'];
    const params: any = { uca: query.uca, limit: pageSize, offset };
    if (query.status) {
      where.push('status = @status');
      params.status = query.status;
    } else {
      where.push("status = 'ready'");
    }
    ['userId', 'trackId', 'source', 'category'].forEach((key) => {
      const value = (query as any)[key];
      if (value !== undefined) {
        where.push(`${snakeCase(key)} = @${key}`);
        params[key] = value;
      }
    });
    if (query.createdAfter !== undefined) {
      where.push('created_at >= @createdAfter');
      params.createdAfter = query.createdAfter;
    }
    if (query.createdBefore !== undefined) {
      where.push('created_at <= @createdBefore');
      params.createdBefore = query.createdBefore;
    }
    if (query.tag) {
      where.push('tags_json LIKE @tagPattern');
      params.tagPattern = `%"${query.tag}"%`;
    }
    const whereSql = where.join(' AND ');
    const total = (this.db.prepare(`SELECT COUNT(*) AS count FROM clips WHERE ${whereSql}`).get(params) as any).count as number;
    const rows = this.db
      .prepare(
        `
        SELECT * FROM clips
        WHERE ${whereSql}
        ORDER BY created_at DESC
        LIMIT @limit OFFSET @offset
      `,
      )
      .all(params);
    return { total, page, pageSize, items: rows.map((row) => this.mapClip(row)) };
  }

  public updateClipStatus(uca: string, clipId: string, status: ClipStatus): StoredClip | null {
    this.db.prepare('UPDATE clips SET status = @status WHERE uca = @uca AND clip_id = @clipId').run({
      uca,
      clipId,
      status,
    });
    return this.getClip(uca, clipId);
  }

  private insertTaskItem(item: ClipTaskItem): void {
    this.db
      .prepare(
        `
        INSERT INTO clip_task_items (
          item_id, task_id, uca, user_id, track_id, status, upload_id, clip_id, progress,
          error_code, error_message, actual_start_server_ms, actual_end_server_ms,
          created_at, updated_at
        ) VALUES (
          @itemId, @taskId, @uca, @userId, @trackId, @status, @uploadId, @clipId, @progress,
          @errorCode, @errorMessage, @actualStartServerMs, @actualEndServerMs,
          @createdAt, @updatedAt
        )
      `,
      )
      .run({
        itemId: item.itemId,
        taskId: item.taskId,
        uca: item.uca,
        userId: item.userId,
        trackId: item.trackId,
        status: item.status,
        uploadId: item.uploadId || null,
        clipId: item.clipId || null,
        progress: item.progress,
        errorCode: item.errorCode || null,
        errorMessage: item.errorMessage || null,
        actualStartServerMs: item.actualStartServerMs ?? null,
        actualEndServerMs: item.actualEndServerMs ?? null,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      });
  }

  private mapTaskWithItems(row: any): ClipTask {
    const task = this.mapTask(row);
    task.items = this.getTaskItems(task.taskId);
    return task;
  }

  private mapAutomation(row: any): ClipAutomationTask {
    return {
      automationId: row.automation_id,
      uca: row.uca,
      name: row.name,
      enabled: row.enabled === 1,
      trigger: parseJson<ClipAutomationTask['trigger']>(row.trigger_json, { kind: 'manualOnly' }),
      target: parseJson<ClipAutomationTask['target']>(row.target_json, { userSelector: 'eventUser', trackIds: [] }),
      clipWindow: parseJson<ClipAutomationTask['clipWindow']>(row.clip_window_json, {
        preRollMs: 0,
        postRollMs: 0,
        minDurationMs: 0,
        maxDurationMs: 0,
      }),
      defaults: parseJson<ClipAutomationTask['defaults']>(row.defaults_json, {
        category: 'other',
        titleTemplate: '',
        tags: [],
        priority: 'normal',
      }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapAutomationRun(row: any): ClipAutomationRun {
    return {
      runId: row.run_id,
      automationId: row.automation_id,
      uca: row.uca,
      triggerKind: row.trigger_kind,
      triggerKey: row.trigger_key,
      eventServerMs: row.event_server_ms,
      payload: parseJson(row.payload_json, {}),
      createdTaskIds: parseJson(row.created_task_ids_json, []),
      status: row.status,
      errorCode: row.error_code || undefined,
      errorMessage: row.error_message || undefined,
      createdAt: row.created_at,
    };
  }

  private mapTask(row: any): ClipTask {
    return {
      taskId: row.task_id,
      uca: row.uca,
      source: row.source,
      automationId: row.automation_id || undefined,
      automationRunId: row.automation_run_id || undefined,
      title: row.title,
      category: row.category,
      tags: parseJson(row.tags_json, []),
      priority: row.priority,
      userId: row.user_id,
      status: row.status,
      startServerMs: row.start_server_ms,
      endServerMs: row.end_server_ms,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      progress: row.progress,
      errorCode: row.error_code || undefined,
      errorMessage: row.error_message || undefined,
      items: [],
      createdClipIds: parseJson(row.created_clip_ids_json, []),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
    };
  }

  private mapTaskItem(row: any): ClipTaskItem & { uploadTokenHash?: string; uploadTokenExpiresAt?: number } {
    return {
      itemId: row.item_id,
      taskId: row.task_id,
      uca: row.uca,
      userId: row.user_id,
      trackId: row.track_id,
      status: row.status,
      uploadId: row.upload_id || undefined,
      clipId: row.clip_id || undefined,
      progress: row.progress,
      errorCode: row.error_code || undefined,
      errorMessage: row.error_message || undefined,
      actualStartServerMs: row.actual_start_server_ms || undefined,
      actualEndServerMs: row.actual_end_server_ms || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      uploadTokenHash: row.upload_token_hash || undefined,
      uploadTokenExpiresAt: row.upload_token_expires_at || undefined,
    };
  }

  private mapUpload(row: any): ClipUpload {
    return {
      uploadId: row.upload_id,
      uca: row.uca,
      taskId: row.task_id,
      itemId: row.item_id,
      trackId: row.track_id,
      role: row.role,
      fileName: row.file_name,
      mimeType: row.mime_type,
      uploadLength: row.upload_length,
      offset: row.offset,
      checksumSha256: row.checksum_sha256,
      tokenHash: row.token_hash,
      storagePath: row.storage_path,
      status: row.status,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapClip(row: any): StoredClip {
    return {
      clipId: row.clip_id,
      uca: row.uca,
      taskId: row.task_id,
      itemId: row.item_id,
      userId: row.user_id,
      trackId: row.track_id,
      source: row.source,
      category: row.category,
      title: row.title,
      tags: parseJson(row.tags_json, []),
      mediaPath: row.media_path,
      thumbnailPath: row.thumbnail_path || undefined,
      mimeType: row.mime_type,
      byteSize: row.byte_size,
      durationMs: row.duration_ms,
      width: row.width || undefined,
      height: row.height || undefined,
      videoCodec: row.video_codec || undefined,
      audioCodec: row.audio_codec || undefined,
      checksumSha256: row.checksum_sha256,
      actualStartServerMs: row.actual_start_server_ms,
      actualEndServerMs: row.actual_end_server_ms,
      mediaUrl: `/api/clips/${row.clip_id}/media`,
      thumbnailUrl: row.thumbnail_path ? `/api/clips/${row.clip_id}/thumbnail` : undefined,
      status: row.status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS clip_automation_tasks (
        automation_id TEXT PRIMARY KEY,
        uca TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        trigger_json TEXT NOT NULL,
        target_json TEXT NOT NULL,
        clip_window_json TEXT NOT NULL,
        defaults_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_clip_automation_tasks_uca
        ON clip_automation_tasks (uca, deleted_at, created_at);

      CREATE TABLE IF NOT EXISTS clip_automation_runs (
        run_id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        uca TEXT NOT NULL,
        trigger_kind TEXT NOT NULL,
        trigger_key TEXT NOT NULL,
        event_server_ms INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_task_ids_json TEXT NOT NULL,
        status TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE (uca, automation_id, trigger_key)
      );

      CREATE INDEX IF NOT EXISTS idx_clip_automation_runs_automation
        ON clip_automation_runs (uca, automation_id, created_at);

      CREATE TABLE IF NOT EXISTS clip_tasks (
        task_id TEXT PRIMARY KEY,
        uca TEXT NOT NULL,
        source TEXT NOT NULL,
        automation_id TEXT,
        automation_run_id TEXT,
        idempotency_key TEXT,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        priority TEXT NOT NULL,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        start_server_ms INTEGER NOT NULL,
        end_server_ms INTEGER NOT NULL,
        attempts INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        progress INTEGER NOT NULL,
        error_code TEXT,
        error_message TEXT,
        created_clip_ids_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_clip_tasks_idempotency
        ON clip_tasks (uca, idempotency_key)
        WHERE idempotency_key IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_clip_tasks_list
        ON clip_tasks (uca, status, created_at);

      CREATE TABLE IF NOT EXISTS clip_task_items (
        item_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        uca TEXT NOT NULL,
        user_id TEXT NOT NULL,
        track_id TEXT NOT NULL,
        status TEXT NOT NULL,
        upload_id TEXT,
        clip_id TEXT,
        progress INTEGER NOT NULL,
        error_code TEXT,
        error_message TEXT,
        actual_start_server_ms INTEGER,
        actual_end_server_ms INTEGER,
        upload_token_hash TEXT,
        upload_token_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_clip_task_items_task
        ON clip_task_items (task_id, created_at);

      CREATE TABLE IF NOT EXISTS clip_uploads (
        upload_id TEXT PRIMARY KEY,
        uca TEXT NOT NULL,
        task_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        track_id TEXT NOT NULL,
        role TEXT NOT NULL,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        upload_length INTEGER NOT NULL,
        offset INTEGER NOT NULL,
        checksum_sha256 TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_clip_uploads_task
        ON clip_uploads (uca, task_id, item_id);

      CREATE TABLE IF NOT EXISTS clips (
        clip_id TEXT PRIMARY KEY,
        uca TEXT NOT NULL,
        task_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        track_id TEXT NOT NULL,
        source TEXT NOT NULL,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        media_path TEXT NOT NULL,
        thumbnail_path TEXT,
        mime_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        width INTEGER,
        height INTEGER,
        video_codec TEXT,
        audio_codec TEXT,
        checksum_sha256 TEXT NOT NULL,
        actual_start_server_ms INTEGER NOT NULL,
        actual_end_server_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_clips_list
        ON clips (uca, status, created_at);
    `);
  }
}

function normalizePagination(page = 1, pageSize = 50) {
  const normalizedPage = Math.max(1, Math.floor(Number(page) || 1));
  const normalizedPageSize = Math.min(100, Math.max(1, Math.floor(Number(pageSize) || 50)));
  return {
    page: normalizedPage,
    pageSize: normalizedPageSize,
    offset: (normalizedPage - 1) * normalizedPageSize,
  };
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch (e) {
    return fallback;
  }
}

function snakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}
