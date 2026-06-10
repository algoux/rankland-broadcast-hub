import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ErrCode } from '@common/enums/err-code.enum';
import ClipRepository from '@server/modules/clips/clip.repository';
import ClipService from '@server/modules/clips/clip.service';
import LogicException from '@server/exceptions/logic.exception';
import type ClipConfig from '@server/configs/clips/clip.config';

describe('ClipService', () => {
  let tempDir: string;
  let repository: ClipRepository;
  let service: ClipService;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rankland-clips-'));
    const config = createConfig(tempDir);
    repository = new ClipRepository(config);
    service = new ClipService(repository, config, {
      async getBroadcasterStoreTracks(uca: string, userId: string) {
        if (uca !== 'contest-a' || userId !== 'alice') {
          return null;
        }
        return [
          { trackId: 'screen', type: 'screen' },
          { trackId: 'camera', type: 'camera' },
        ];
      },
    } as any);
  });

  afterEach(() => {
    repository.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates, updates, lists, and soft-deletes automation tasks', async () => {
    const automation = await service.createAutomation('contest-a', {
      name: 'First blood clips',
      enabled: true,
      trigger: { kind: 'firstBlood', problemAliases: ['A'], includeUnofficial: false },
      target: { userSelector: 'eventUser', trackIds: ['screen'] },
      clipWindow: { preRollMs: 20000, postRollMs: 10000, minDurationMs: 1000, maxDurationMs: 60000 },
      defaults: { category: 'firstBlood', titleTemplate: 'FB {userId}', tags: ['fb'], priority: 'high' },
    });

    expect(automation.automationId).toMatch(/^clip_auto_/);
    expect(automation.enabled).toBe(true);

    const updated = await service.updateAutomation('contest-a', automation.automationId, {
      enabled: false,
      name: 'Disabled first blood clips',
    });

    expect(updated.enabled).toBe(false);
    expect(updated.name).toBe('Disabled first blood clips');
    expect((await service.listAutomations({ uca: 'contest-a' })).total).toBe(1);

    await service.deleteAutomation('contest-a', automation.automationId);

    expect((await service.listAutomations({ uca: 'contest-a' })).total).toBe(0);
  });

  it('creates automation runs idempotently by trigger key', async () => {
    const automation = await service.createAutomation('contest-a', {
      name: 'Accepted clips',
      trigger: { kind: 'accepted' },
      target: { userSelector: 'eventUser', trackIds: ['screen'] },
      clipWindow: { preRollMs: 10000, postRollMs: 5000, minDurationMs: 1000, maxDurationMs: 60000 },
      defaults: { category: 'accepted', titleTemplate: 'AC {userId}', tags: ['ac'], priority: 'normal' },
    });

    const first = await service.createAutomationRun('contest-a', automation.automationId, {
      triggerKind: 'accepted',
      triggerKey: 'accepted:A:alice:1000',
      eventServerMs: 1000,
      payload: { userId: 'alice', problemAlias: 'A' },
      status: 'matched',
    });
    const second = await service.createAutomationRun('contest-a', automation.automationId, {
      triggerKind: 'accepted',
      triggerKey: 'accepted:A:alice:1000',
      eventServerMs: 1000,
      payload: { duplicate: true },
      status: 'failed',
      errorCode: 'duplicate',
    });

    expect(second.runId).toBe(first.runId);
    expect(second.status).toBe('matched');
    expect((await service.listAutomationRuns('contest-a', automation.automationId, {})).total).toBe(1);
  });

  it('validates tracks and creates tasks idempotently', async () => {
    const task = await service.createTask('contest-a', {
      source: 'manual',
      userId: 'alice',
      trackIds: ['screen'],
      startServerMs: 1000,
      endServerMs: 9000,
      title: 'Manual clip',
      category: 'manual',
      tags: ['manual'],
      priority: 'normal',
      idempotencyKey: 'manual-1',
    });
    const repeated = await service.createTask('contest-a', {
      source: 'manual',
      userId: 'alice',
      trackIds: ['screen'],
      startServerMs: 1000,
      endServerMs: 9000,
      title: 'Manual clip again',
      category: 'manual',
      idempotencyKey: 'manual-1',
    });

    expect(task.taskId).toBe(repeated.taskId);
    expect(task.items).toHaveLength(1);
    expect(task.items[0].trackId).toBe('screen');

    await expect(
      service.createTask('contest-a', {
        source: 'manual',
        userId: 'alice',
        trackIds: ['missing'],
        startServerMs: 1000,
        endServerMs: 9000,
        title: 'Bad clip',
        category: 'manual',
      }),
    ).rejects.toMatchObject<Partial<LogicException>>({ code: ErrCode.ClipTaskTrackNotFound });
  });

  it('resumes uploads, rejects checksum mismatches, and creates ready clips', async () => {
    const task = await service.createTask('contest-a', {
      source: 'manual',
      userId: 'alice',
      trackIds: ['screen'],
      startServerMs: 1000,
      endServerMs: 9000,
      title: 'Manual clip',
      category: 'manual',
    });
    const dispatch = await service.beginTaskDispatch(task.taskId);
    const uploadToken = dispatch.items[0].uploadToken;
    const media = createMp4Fixture();
    const checksumSha256 = sha256(media);
    const upload = await service.createUpload('contest-a', task.taskId, uploadToken, {
      itemId: task.items[0].itemId,
      trackId: 'screen',
      role: 'media',
      fileName: 'clip.mp4',
      mimeType: 'video/mp4',
      uploadLength: media.length,
      checksumSha256,
    });

    expect((await service.getUploadHead('contest-a', uploadToken, upload.uploadId)).offset).toBe(0);
    await service.appendUploadStream('contest-a', uploadToken, upload.uploadId, 0, Readable.from([media.subarray(0, 8)]));
    expect((await service.getUploadHead('contest-a', uploadToken, upload.uploadId)).offset).toBe(8);
    await expect(
      service.appendUploadStream('contest-a', uploadToken, upload.uploadId, 0, Readable.from([media.subarray(8)])),
    ).rejects.toMatchObject<Partial<LogicException>>({ code: ErrCode.ClipUploadOffsetMismatch });

    await service.appendUploadStream('contest-a', uploadToken, upload.uploadId, 8, Readable.from([media.subarray(8)]));
    await expect(
      service.completeUpload('contest-a', uploadToken, upload.uploadId, {
        metadata: {
          actualStartServerMs: 1000,
          actualEndServerMs: 9000,
          durationMs: 8000,
          container: 'mp4',
        },
      }),
    ).resolves.toHaveProperty('clip.clipId');

    const clips = await service.listClips({ uca: 'contest-a' });
    expect(clips.total).toBe(1);
    expect(clips.clips[0].status).toBe('ready');
    expect(fs.existsSync(path.join(tempDir, 'contest-a', 'clips', clips.clips[0].clipId, 'media.mp4'))).toBe(true);
  });

  it('returns the existing clip when media completion is retried', async () => {
    const { task, uploadToken, upload } = await createUploadedMedia(service);
    const first = await service.completeUpload('contest-a', uploadToken, upload.uploadId, {
      metadata: {
        actualStartServerMs: 1000,
        actualEndServerMs: 9000,
        durationMs: 8000,
        container: 'mp4',
      },
    });
    const second = await service.completeUpload('contest-a', uploadToken, upload.uploadId, {
      metadata: {
        actualStartServerMs: 1000,
        actualEndServerMs: 9000,
        durationMs: 8000,
        container: 'mp4',
      },
    });

    expect(second.clip?.clipId).toBe(first.clip?.clipId);
    expect((await service.listClips({ uca: 'contest-a' })).total).toBe(1);
    expect((await service.getTask(task.taskId)).items[0].clipId).toBe(first.clip?.clipId);
    expect(fs.existsSync(path.join(tempDir, 'contest-a', 'clips', first.clip!.clipId, 'media.mp4'))).toBe(true);
  });

  it('returns the existing clip when media completion is retried concurrently', async () => {
    const { uploadToken, upload } = await createUploadedMedia(service);
    const req = {
      metadata: {
        actualStartServerMs: 1000,
        actualEndServerMs: 9000,
        durationMs: 8000,
        container: 'mp4' as const,
      },
    };

    const [first, second] = await Promise.all([
      service.completeUpload('contest-a', uploadToken, upload.uploadId, req),
      service.completeUpload('contest-a', uploadToken, upload.uploadId, req),
    ]);

    expect(second.clip?.clipId).toBe(first.clip?.clipId);
    expect((await service.listClips({ uca: 'contest-a' })).total).toBe(1);
  });

  it('truncates stale upload tails before resuming at the stored offset', async () => {
    const task = await service.createTask('contest-a', {
      source: 'manual',
      userId: 'alice',
      trackIds: ['screen'],
      startServerMs: 1000,
      endServerMs: 9000,
      title: 'Manual clip',
      category: 'manual',
    });
    const dispatch = await service.beginTaskDispatch(task.taskId);
    const uploadToken = dispatch.items[0].uploadToken;
    const media = createMp4Fixture();
    const upload = await service.createUpload('contest-a', task.taskId, uploadToken, {
      itemId: task.items[0].itemId,
      trackId: 'screen',
      role: 'media',
      fileName: 'clip.mp4',
      mimeType: 'video/mp4',
      uploadLength: media.length,
      checksumSha256: sha256(media),
    });
    await service.appendUploadStream('contest-a', uploadToken, upload.uploadId, 0, Readable.from([media.subarray(0, 8)]));
    const storedUpload = repository.getUpload(upload.uploadId)!;
    fs.appendFileSync(path.join(tempDir, storedUpload.storagePath), Buffer.from('stale-tail'));

    await service.appendUploadStream('contest-a', uploadToken, upload.uploadId, 8, Readable.from([media.subarray(8)]));

    expect(fs.readFileSync(path.join(tempDir, storedUpload.storagePath))).toEqual(media);
  });

  it('does not create a clip when the uploaded media checksum mismatches', async () => {
    const task = await service.createTask('contest-a', {
      source: 'manual',
      userId: 'alice',
      trackIds: ['screen'],
      startServerMs: 1000,
      endServerMs: 9000,
      title: 'Manual clip',
      category: 'manual',
    });
    const dispatch = await service.beginTaskDispatch(task.taskId);
    const uploadToken = dispatch.items[0].uploadToken;
    const media = createMp4Fixture();
    const upload = await service.createUpload('contest-a', task.taskId, uploadToken, {
      itemId: task.items[0].itemId,
      trackId: 'screen',
      role: 'media',
      fileName: 'clip.mp4',
      mimeType: 'video/mp4',
      uploadLength: media.length,
      checksumSha256: sha256(Buffer.from('different')),
    });

    await service.appendUploadStream('contest-a', uploadToken, upload.uploadId, 0, Readable.from([media]));
    await expect(
      service.completeUpload('contest-a', uploadToken, upload.uploadId, {
        metadata: {
          actualStartServerMs: 1000,
          actualEndServerMs: 9000,
          durationMs: 8000,
          container: 'mp4',
        },
      }),
    ).rejects.toMatchObject<Partial<LogicException>>({ code: ErrCode.ClipUploadChecksumMismatch });
    expect((await service.listClips({ uca: 'contest-a' })).total).toBe(0);
  });

  it('verifies thumbnail bytes before marking thumbnail uploads complete', async () => {
    const task = await service.createTask('contest-a', {
      source: 'manual',
      userId: 'alice',
      trackIds: ['screen'],
      startServerMs: 1000,
      endServerMs: 9000,
      title: 'Manual clip',
      category: 'manual',
    });
    const dispatch = await service.beginTaskDispatch(task.taskId);
    const uploadToken = dispatch.items[0].uploadToken;
    const thumbnail = Buffer.from('not-the-declared-thumbnail');
    const upload = await service.createUpload('contest-a', task.taskId, uploadToken, {
      itemId: task.items[0].itemId,
      trackId: 'screen',
      role: 'thumbnail',
      fileName: 'thumb.webp',
      mimeType: 'image/webp',
      uploadLength: thumbnail.length,
      checksumSha256: sha256(Buffer.from('different-thumbnail')),
    });
    await service.appendUploadStream('contest-a', uploadToken, upload.uploadId, 0, Readable.from([thumbnail]));

    await expect(
      service.completeUpload('contest-a', uploadToken, upload.uploadId, {
        metadata: {
          actualStartServerMs: 1000,
          actualEndServerMs: 9000,
          durationMs: 8000,
          container: 'mp4',
        },
      }),
    ).rejects.toMatchObject<Partial<LogicException>>({ code: ErrCode.ClipUploadChecksumMismatch });
  });

  it('does not overwrite the media upload id when creating thumbnail uploads', async () => {
    const task = await service.createTask('contest-a', {
      source: 'manual',
      userId: 'alice',
      trackIds: ['screen'],
      startServerMs: 1000,
      endServerMs: 9000,
      title: 'Manual clip',
      category: 'manual',
    });
    const dispatch = await service.beginTaskDispatch(task.taskId);
    const uploadToken = dispatch.items[0].uploadToken;
    const media = createMp4Fixture();
    const mediaUpload = await service.createUpload('contest-a', task.taskId, uploadToken, {
      itemId: task.items[0].itemId,
      trackId: 'screen',
      role: 'media',
      fileName: 'clip.mp4',
      mimeType: 'video/mp4',
      uploadLength: media.length,
      checksumSha256: sha256(media),
    });
    const thumbnail = Buffer.from('thumbnail');
    await service.createUpload('contest-a', task.taskId, uploadToken, {
      itemId: task.items[0].itemId,
      trackId: 'screen',
      role: 'thumbnail',
      fileName: 'thumb.webp',
      mimeType: 'image/webp',
      uploadLength: thumbnail.length,
      checksumSha256: sha256(thumbnail),
    });

    expect(repository.getTaskItem(task.items[0].itemId)?.uploadId).toBe(mediaUpload.uploadId);
  });

  it('rejects progress updates that attempt to mark tasks ready without uploaded clips', async () => {
    const task = await service.createTask('contest-a', {
      source: 'manual',
      userId: 'alice',
      trackIds: ['screen'],
      startServerMs: 1000,
      endServerMs: 9000,
      title: 'Manual clip',
      category: 'manual',
    });

    await expect(
      service.reportProgress('contest-a', task.taskId, {
        status: 'ready',
        progress: 100,
      }),
    ).rejects.toMatchObject<Partial<LogicException>>({ code: ErrCode.IllegalParameters });

    expect((await service.getTask(task.taskId)).status).toBe('queued');
  });

  it('keeps cancelled items cancelled when a dispatch retry fails', async () => {
    const task = await service.createTask('contest-a', {
      source: 'manual',
      userId: 'alice',
      trackIds: ['screen', 'camera'],
      startServerMs: 1000,
      endServerMs: 9000,
      title: 'Manual clip',
      category: 'manual',
    });
    repository.updateTaskItem(task.items[0].itemId, { status: 'cancelled', updatedAt: Date.now() });

    await service.markTaskDispatchFailed(task.taskId, 'target_offline', 'offline', true);

    expect(repository.getTaskItem(task.items[0].itemId)?.status).toBe('cancelled');
  });

  it('requires uca when reading clips', async () => {
    const clip = await createReadyClip(service);

    await expect(service.getClip(undefined as any, clip.clipId)).rejects.toMatchObject<Partial<LogicException>>({
      code: ErrCode.IllegalParameters,
    });
  });

  it('limits track count per task', async () => {
    (service as any).config.maxTracksPerTask = 1;

    await expect(
      service.createTask('contest-a', {
        source: 'manual',
        userId: 'alice',
        trackIds: ['screen', 'camera'],
        startServerMs: 1000,
        endServerMs: 9000,
        title: 'Manual clip',
        category: 'manual',
      }),
    ).rejects.toMatchObject<Partial<LogicException>>({ code: ErrCode.IllegalParameters });
  });

  it('does not count sqlite metadata files against media storage quota', async () => {
    const task = await service.createTask('contest-a', {
      source: 'manual',
      userId: 'alice',
      trackIds: ['screen'],
      startServerMs: 1000,
      endServerMs: 9000,
      title: 'Manual clip',
      category: 'manual',
    });
    const dispatch = await service.beginTaskDispatch(task.taskId);
    const uploadToken = dispatch.items[0].uploadToken;
    const media = createMp4Fixture();
    (service as any).config.maxStorageBytes = media.length;

    await expect(
      service.createUpload('contest-a', task.taskId, uploadToken, {
        itemId: task.items[0].itemId,
        trackId: 'screen',
        role: 'media',
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
        uploadLength: media.length,
        checksumSha256: sha256(media),
      }),
    ).resolves.toHaveProperty('uploadId');
  });

  it('soft-deletes clips and hides deleted clips from default lists', async () => {
    const clip = await createReadyClip(service);

    await service.deleteClip('contest-a', clip.clipId);

    expect((await service.listClips({ uca: 'contest-a' })).total).toBe(0);
    const deleted = await service.listClips({ uca: 'contest-a', status: 'deleted' });
    expect(deleted.total).toBe(1);
    expect(deleted.clips[0].clipId).toBe(clip.clipId);
  });
});

async function createReadyClip(service: ClipService) {
  const task = await service.createTask('contest-a', {
    source: 'manual',
    userId: 'alice',
    trackIds: ['screen'],
    startServerMs: 1000,
    endServerMs: 9000,
    title: 'Manual clip',
    category: 'manual',
  });
  const dispatch = await service.beginTaskDispatch(task.taskId);
  const uploadToken = dispatch.items[0].uploadToken;
  const media = createMp4Fixture();
  const upload = await service.createUpload('contest-a', task.taskId, uploadToken, {
    itemId: task.items[0].itemId,
    trackId: 'screen',
    role: 'media',
    fileName: 'clip.mp4',
    mimeType: 'video/mp4',
    uploadLength: media.length,
    checksumSha256: sha256(media),
  });
  await service.appendUploadStream('contest-a', uploadToken, upload.uploadId, 0, Readable.from([media]));
  const completed = await service.completeUpload('contest-a', uploadToken, upload.uploadId, {
    metadata: {
      actualStartServerMs: 1000,
      actualEndServerMs: 9000,
      durationMs: 8000,
      container: 'mp4',
    },
  });
  return completed.clip!;
}

async function createUploadedMedia(service: ClipService) {
  const task = await service.createTask('contest-a', {
    source: 'manual',
    userId: 'alice',
    trackIds: ['screen'],
    startServerMs: 1000,
    endServerMs: 9000,
    title: 'Manual clip',
    category: 'manual',
  });
  const dispatch = await service.beginTaskDispatch(task.taskId);
  const uploadToken = dispatch.items[0].uploadToken;
  const media = createMp4Fixture();
  const upload = await service.createUpload('contest-a', task.taskId, uploadToken, {
    itemId: task.items[0].itemId,
    trackId: 'screen',
    role: 'media',
    fileName: 'clip.mp4',
    mimeType: 'video/mp4',
    uploadLength: media.length,
    checksumSha256: sha256(media),
  });
  await service.appendUploadStream('contest-a', uploadToken, upload.uploadId, 0, Readable.from([media]));
  return { task, uploadToken, upload };
}

function createConfig(storageDir: string): ClipConfig {
  return {
    storageDir,
    sqlitePath: path.join(storageDir, 'clips.sqlite'),
    maxDurationMs: 120000,
    maxUploadBytes: 524288000,
    defaultRetentionDays: 30,
    uploadTokenTtlMs: 900000,
    taskMaxAttempts: 3,
    maxTracksPerTask: 8,
    maxStorageBytes: 1024 * 1024 * 1024,
    requestAckTimeoutMs: 5000,
  } as ClipConfig;
}

function createMp4Fixture(): Buffer {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypisom'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('highlight replay fixture'),
  ]);
}

function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
