import fs from 'fs';
import { Contract, Data, Delete, Get, Head, InjectCtx, Param, Patch, Post, RequestContext, UseGuards } from 'bwcx-ljsm';
import { Inject } from 'bwcx-core';
import {
  ClipAutomationIdReqDTO,
  ClipAutomationRespDTO,
  ClipAutomationRunRespDTO,
  ClipIdReqDTO,
  ClipRespDTO,
  CompleteClipUploadReqDTO,
  CompleteClipUploadRespDTO,
  CreateClipAutomationReqDTO,
  CreateClipAutomationRunReqDTO,
  CreateClipUploadReqDTO,
  CreateClipUploadRespDTO,
  CreateClipTaskReqDTO,
  DeleteClipRespDTO,
  EmptyClipRespDTO,
  GetClipTaskReqDTO,
  ListClipAutomationRunsReqDTO,
  ListClipAutomationRunsRespDTO,
  ListClipAutomationsReqDTO,
  ListClipAutomationsRespDTO,
  ListClipsReqDTO,
  ListClipsRespDTO,
  ListClipTasksReqDTO,
  ListClipTasksRespDTO,
  ClipTaskRespDTO,
  ReportClipTaskProgressReqDTO,
  UpdateClipAutomationReqDTO,
  UpdateClipAutomationRunReqDTO,
} from '@common/modules/clips';
import { ErrCode } from '@common/enums/err-code.enum';
import { ApiController } from '@server/decorators';
import AuthGuard from '@server/guards/auth.guard';
import LogicException from '@server/exceptions/logic.exception';
import ClipService from './clip.service';
import { parseRangeHeader } from './range.util';

@ApiController('/clips')
export default class ClipController {
  public constructor(
    @InjectCtx()
    private readonly ctx: RequestContext,

    @Inject()
    private readonly service: ClipService,
  ) {}

  @Post('/automations')
  @UseGuards(AuthGuard)
  @Contract(CreateClipAutomationReqDTO, ClipAutomationRespDTO)
  public async createAutomation(@Data() data: CreateClipAutomationReqDTO) {
    return { automation: await this.service.createAutomation(this.getUca(), data) };
  }

  @Get('/automations')
  @UseGuards(AuthGuard)
  @Contract(ListClipAutomationsReqDTO, ListClipAutomationsRespDTO)
  public async listAutomations(@Data() data: ListClipAutomationsReqDTO) {
    return this.service.listAutomations(data);
  }

  @Get('/automations/:automationId')
  @UseGuards(AuthGuard)
  @Contract(ClipAutomationIdReqDTO, ClipAutomationRespDTO)
  public async getAutomation(@Data() data: ClipAutomationIdReqDTO) {
    return { automation: await this.service.getAutomation(this.getUca(), data.automationId) };
  }

  @Patch('/automations/:automationId')
  @UseGuards(AuthGuard)
  @Contract(UpdateClipAutomationReqDTO, ClipAutomationRespDTO)
  public async updateAutomation(@Data() data: UpdateClipAutomationReqDTO) {
    const { automationId, ...patch } = data;
    return { automation: await this.service.updateAutomation(this.getUca(), automationId, patch) };
  }

  @Delete('/automations/:automationId')
  @UseGuards(AuthGuard)
  @Contract(ClipAutomationIdReqDTO, EmptyClipRespDTO)
  public async deleteAutomation(@Data() data: ClipAutomationIdReqDTO) {
    return this.service.deleteAutomation(this.getUca(), data.automationId);
  }

  @Get('/automations/:automationId/runs')
  @UseGuards(AuthGuard)
  @Contract(ListClipAutomationRunsReqDTO, ListClipAutomationRunsRespDTO)
  public async listAutomationRuns(@Data() data: ListClipAutomationRunsReqDTO) {
    return this.service.listAutomationRuns(this.getUca(), data.automationId, data);
  }

  @Post('/automations/:automationId/runs')
  @UseGuards(AuthGuard)
  @Contract(CreateClipAutomationRunReqDTO, ClipAutomationRunRespDTO)
  public async createAutomationRun(@Data() data: CreateClipAutomationRunReqDTO) {
    const { automationId, ...req } = data;
    return { run: await this.service.createAutomationRun(this.getUca(), automationId, req) };
  }

  @Patch('/automation-runs/:runId')
  @UseGuards(AuthGuard)
  @Contract(UpdateClipAutomationRunReqDTO, ClipAutomationRunRespDTO)
  public async updateAutomationRun(@Data() data: UpdateClipAutomationRunReqDTO) {
    const { runId, ...req } = data;
    return { run: await this.service.updateAutomationRun(this.getUca(), runId, req) };
  }

  @Post('/tasks')
  @UseGuards(AuthGuard)
  @Contract(CreateClipTaskReqDTO, ClipTaskRespDTO)
  public async createTask(@Data() data: CreateClipTaskReqDTO) {
    return { task: await this.service.createTask(this.getUca(), data) };
  }

  @Get('/tasks')
  @UseGuards(AuthGuard)
  @Contract(ListClipTasksReqDTO, ListClipTasksRespDTO)
  public async listTasks(@Data() data: ListClipTasksReqDTO) {
    return this.service.listTasks(data);
  }

  @Get('/tasks/:taskId')
  @UseGuards(AuthGuard)
  @Contract(GetClipTaskReqDTO, ClipTaskRespDTO)
  public async getTask(@Data() data: GetClipTaskReqDTO) {
    return { task: await this.service.getTask(data.taskId) };
  }

  @Post('/tasks/:taskId/progress')
  @UseGuards(AuthGuard)
  @Contract(ReportClipTaskProgressReqDTO, ClipTaskRespDTO)
  public async reportTaskProgress(@Data() data: ReportClipTaskProgressReqDTO) {
    const { taskId, ...req } = data;
    return { task: await this.service.reportProgress(this.getUca(), taskId, req) };
  }

  @Post('/tasks/:taskId/uploads')
  @Contract(CreateClipUploadReqDTO, CreateClipUploadRespDTO)
  public async createUpload(@Data() data: CreateClipUploadReqDTO) {
    const { taskId, ...req } = data;
    return this.service.createUpload(this.getUca(), taskId, this.getUploadToken(), req);
  }

  @Head('/uploads/:uploadId')
  public async headUpload(@Param('uploadId') uploadId: string) {
    const head = await this.service.getUploadHead(this.getUca(), this.getUploadToken(), uploadId);
    this.ctx.status = 204;
    this.setUploadHeaders(head);
  }

  @Patch('/uploads/:uploadId')
  public async patchUpload(@Param('uploadId') uploadId: string) {
    const uploadOffset = parseIntegerHeader(this.ctx.headers['upload-offset']);
    const head = await this.service.getUploadHead(this.getUca(), this.getUploadToken(), uploadId);
    if (uploadOffset !== head.offset) {
      this.ctx.status = 409;
      this.setUploadHeaders(head);
      return;
    }
    let result: { offset: number };
    try {
      result = await this.service.appendUploadStream(
        this.getUca(),
        this.getUploadToken(),
        uploadId,
        uploadOffset,
        this.ctx.req,
      );
    } catch (error) {
      if (error instanceof LogicException && error.code === ErrCode.ClipUploadOffsetMismatch) {
        const latestHead = await this.service.getUploadHead(this.getUca(), this.getUploadToken(), uploadId);
        this.ctx.status = 409;
        this.setUploadHeaders(latestHead);
        return;
      }
      throw error;
    }
    this.ctx.status = 204;
    this.ctx.set('Upload-Offset', result.offset.toString());
  }

  @Post('/uploads/:uploadId/complete')
  @Contract(CompleteClipUploadReqDTO, CompleteClipUploadRespDTO)
  public async completeUpload(@Data() data: CompleteClipUploadReqDTO) {
    const { uploadId, ...req } = data;
    return this.service.completeUpload(this.getUca(), this.getUploadToken(), uploadId, req);
  }

  @Get('/')
  @UseGuards(AuthGuard)
  @Contract(ListClipsReqDTO, ListClipsRespDTO)
  public async listClips(@Data() data: ListClipsReqDTO) {
    return this.service.listClips(data);
  }

  @Get('/:clipId')
  @UseGuards(AuthGuard)
  @Contract(ClipIdReqDTO, ClipRespDTO)
  public async getClip(@Data() data: ClipIdReqDTO) {
    return { clip: await this.service.getClip(this.getUca(), data.clipId) };
  }

  @Get('/:clipId/thumbnail')
  @UseGuards(AuthGuard)
  public async getThumbnail(@Param('clipId') clipId: string) {
    const { clip, path, size } = await this.service.getClipThumbnail(this.getUca(), clipId);
    this.ctx.status = 200;
    this.ctx.set('Content-Type', getThumbnailMime(path));
    this.ctx.set('Content-Length', size.toString());
    this.ctx.set('ETag', `"${clip.checksumSha256}"`);
    this.ctx.body = fs.createReadStream(path);
  }

  @Head('/:clipId/media')
  @UseGuards(AuthGuard)
  public async headMedia(@Param('clipId') clipId: string) {
    const { clip, size } = await this.service.getClipMedia(this.getUca(), clipId);
    this.ctx.status = 200;
    this.ctx.set('Content-Type', clip.mimeType);
    this.ctx.set('Content-Length', size.toString());
    this.ctx.set('Accept-Ranges', 'bytes');
    this.ctx.set('ETag', `"${clip.checksumSha256}"`);
  }

  @Get('/:clipId/media')
  @UseGuards(AuthGuard)
  public async getMedia(@Param('clipId') clipId: string) {
    const { clip, path, size } = await this.service.getClipMedia(this.getUca(), clipId);
    const range = parseRangeHeader(this.ctx.headers.range?.toString(), size);
    this.ctx.set('Accept-Ranges', 'bytes');
    this.ctx.set('Content-Type', clip.mimeType);
    this.ctx.set('ETag', `"${clip.checksumSha256}"`);
    if (range.kind === 'unsatisfiable') {
      this.ctx.status = 416;
      this.ctx.set('Content-Range', `bytes */${range.size}`);
      return;
    }
    this.ctx.status = range.kind === 'partial' ? 206 : 200;
    this.ctx.set('Content-Length', range.contentLength.toString());
    if (range.kind === 'partial') {
      this.ctx.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    }
    this.ctx.body = fs.createReadStream(path, { start: range.start, end: range.end });
  }

  @Delete('/:clipId')
  @UseGuards(AuthGuard)
  @Contract(ClipIdReqDTO, DeleteClipRespDTO)
  public async deleteClip(@Data() data: ClipIdReqDTO) {
    return this.service.deleteClip(this.getUca(), data.clipId);
  }

  private getUca(fallback?: string): string {
    const uca = this.ctx.headers['x-uca']?.toString() || fallback || firstQueryValue(this.ctx.query.uca);
    if (!uca) {
      throw new LogicException(ErrCode.IllegalParameters);
    }
    return uca;
  }

  private getUploadToken(): string {
    const token = this.ctx.headers['x-upload-token']?.toString();
    if (!token) {
      throw new LogicException(ErrCode.InvalidAuthInfo);
    }
    return token;
  }

  private setUploadHeaders(head: { offset: number; uploadLength: number; expiresAt: number }) {
    this.ctx.set('Upload-Offset', head.offset.toString());
    this.ctx.set('Upload-Length', head.uploadLength.toString());
    this.ctx.set('Upload-Expires', new Date(head.expiresAt).toUTCString());
  }
}

function firstQueryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return value[0]?.toString();
  }
  return value?.toString();
}

function parseIntegerHeader(value: unknown): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = parseInt(raw?.toString() || '', 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new LogicException(ErrCode.IllegalParameters);
  }
  return parsed;
}

function getThumbnailMime(filePath: string): string {
  if (filePath.endsWith('.png')) {
    return 'image/png';
  }
  if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  return 'image/webp';
}
