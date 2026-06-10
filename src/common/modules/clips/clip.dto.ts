import { FromBody, FromParam, FromQuery } from 'bwcx-common';
import { IsArray, IsBoolean, IsIn, IsInt, IsNotEmpty, IsNumber, IsObject, IsOptional, IsString, Min } from 'class-validator';
import type {
  ClipAutomationRun,
  ClipAutomationTask,
  ClipCategory,
  ClipPriority,
  ClipSource,
  ClipStatus,
  ClipTaskStatus,
  ClipUploadStatus,
} from './clip.types';

export class CreateClipAutomationReqDTO {
  @FromBody()
  @IsString()
  @IsNotEmpty()
  public name: string;

  @FromBody()
  @IsOptional()
  @IsBoolean()
  public enabled?: boolean;

  @FromBody()
  @IsObject()
  public trigger: ClipAutomationTask['trigger'];

  @FromBody()
  @IsObject()
  public target: ClipAutomationTask['target'];

  @FromBody()
  @IsObject()
  public clipWindow: ClipAutomationTask['clipWindow'];

  @FromBody()
  @IsObject()
  public defaults: ClipAutomationTask['defaults'];
}

export class ListClipAutomationsReqDTO {
  @FromQuery()
  @IsString()
  @IsNotEmpty()
  public uca: string;

  @FromQuery()
  @IsOptional()
  @IsBoolean()
  public enabled?: boolean;

  @FromQuery()
  @IsOptional()
  @IsIn(['manualOnly', 'firstBlood', 'accepted'])
  public triggerKind?: ClipAutomationTask['trigger']['kind'];

  @FromQuery()
  @IsOptional()
  @IsInt()
  @Min(1)
  public page?: number;

  @FromQuery()
  @IsOptional()
  @IsInt()
  @Min(1)
  public pageSize?: number;
}

export class ClipAutomationIdReqDTO {
  @FromParam()
  @IsString()
  @IsNotEmpty()
  public automationId: string;
}

export class UpdateClipAutomationReqDTO extends ClipAutomationIdReqDTO {
  @FromBody()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  public name?: string;

  @FromBody()
  @IsOptional()
  @IsBoolean()
  public enabled?: boolean;

  @FromBody()
  @IsOptional()
  @IsObject()
  public trigger?: ClipAutomationTask['trigger'];

  @FromBody()
  @IsOptional()
  @IsObject()
  public target?: ClipAutomationTask['target'];

  @FromBody()
  @IsOptional()
  @IsObject()
  public clipWindow?: ClipAutomationTask['clipWindow'];

  @FromBody()
  @IsOptional()
  @IsObject()
  public defaults?: ClipAutomationTask['defaults'];
}

export class ListClipAutomationRunsReqDTO extends ClipAutomationIdReqDTO {
  @FromQuery()
  @IsOptional()
  @IsIn(['matched', 'created_task', 'skipped', 'failed'])
  public status?: ClipAutomationRun['status'];

  @FromQuery()
  @IsOptional()
  @IsInt()
  @Min(1)
  public page?: number;

  @FromQuery()
  @IsOptional()
  @IsInt()
  @Min(1)
  public pageSize?: number;
}

export class CreateClipAutomationRunReqDTO extends ClipAutomationIdReqDTO {
  @FromBody()
  @IsIn(['manualOnly', 'firstBlood', 'accepted'])
  public triggerKind: ClipAutomationTask['trigger']['kind'];

  @FromBody()
  @IsString()
  @IsNotEmpty()
  public triggerKey: string;

  @FromBody()
  @IsNumber()
  public eventServerMs: number;

  @FromBody()
  @IsObject()
  public payload: Record<string, any>;

  @FromBody()
  @IsOptional()
  @IsIn(['matched', 'skipped', 'failed'])
  public status?: 'matched' | 'skipped' | 'failed';

  @FromBody()
  @IsOptional()
  @IsString()
  public errorCode?: string;

  @FromBody()
  @IsOptional()
  @IsString()
  public errorMessage?: string;
}

export class UpdateClipAutomationRunReqDTO {
  @FromParam()
  @IsString()
  @IsNotEmpty()
  public runId: string;

  @FromBody()
  @IsIn(['matched', 'created_task', 'skipped', 'failed'])
  public status: ClipAutomationRun['status'];

  @FromBody()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  public createdTaskIds?: string[];

  @FromBody()
  @IsOptional()
  @IsString()
  public errorCode?: string;

  @FromBody()
  @IsOptional()
  @IsString()
  public errorMessage?: string;
}

export class CreateClipTaskReqDTO {
  @FromBody()
  @IsIn(['manual', 'automation'])
  public source: ClipSource;

  @FromBody()
  @IsOptional()
  @IsString()
  public automationId?: string;

  @FromBody()
  @IsOptional()
  @IsString()
  public automationRunId?: string;

  @FromBody()
  @IsString()
  @IsNotEmpty()
  public userId: string;

  @FromBody()
  @IsArray()
  @IsString({ each: true })
  public trackIds: string[];

  @FromBody()
  @IsNumber()
  public startServerMs: number;

  @FromBody()
  @IsNumber()
  public endServerMs: number;

  @FromBody()
  @IsString()
  @IsNotEmpty()
  public title: string;

  @FromBody()
  @IsIn(['firstBlood', 'accepted', 'manual', 'other'])
  public category: ClipCategory;

  @FromBody()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  public tags?: string[];

  @FromBody()
  @IsOptional()
  @IsIn(['low', 'normal', 'high'])
  public priority?: ClipPriority;

  @FromBody()
  @IsOptional()
  @IsInt()
  @Min(1)
  public maxAttempts?: number;

  @FromBody()
  @IsOptional()
  @IsString()
  public idempotencyKey?: string;
}

export class ListClipTasksReqDTO {
  @FromQuery()
  @IsString()
  @IsNotEmpty()
  public uca: string;

  @FromQuery()
  @IsOptional()
  @IsIn(['manual', 'automation'])
  public source?: ClipSource;

  @FromQuery()
  @IsOptional()
  @IsString()
  public userId?: string;

  @FromQuery()
  @IsOptional()
  @IsString()
  public status?: ClipTaskStatus;

  @FromQuery()
  @IsOptional()
  @IsIn(['firstBlood', 'accepted', 'manual', 'other'])
  public category?: ClipCategory;

  @FromQuery()
  @IsOptional()
  @IsInt()
  @Min(1)
  public page?: number;

  @FromQuery()
  @IsOptional()
  @IsInt()
  @Min(1)
  public pageSize?: number;
}

export class ClipTaskIdReqDTO {
  @FromParam()
  @IsString()
  @IsNotEmpty()
  public taskId: string;
}

export class GetClipTaskReqDTO extends ClipTaskIdReqDTO {}

export class ReportClipTaskProgressReqDTO extends ClipTaskIdReqDTO {
  @FromBody()
  @IsOptional()
  @IsString()
  public itemId?: string;

  @FromBody()
  @IsOptional()
  @IsIn([
    'queued',
    'requested',
    'client_processing',
    'uploading',
    'verifying',
    'ready',
    'partial_ready',
    'failed',
    'cancelled',
    'expired',
  ])
  public status?: ClipTaskStatus;

  @FromBody()
  @IsNumber()
  public progress: number;

  @FromBody()
  @IsOptional()
  @IsString()
  public message?: string;

  @FromBody()
  @IsOptional()
  @IsString()
  public errorCode?: string;

  @FromBody()
  @IsOptional()
  @IsString()
  public errorMessage?: string;
}

export class CreateClipUploadReqDTO extends ClipTaskIdReqDTO {
  @FromBody()
  @IsString()
  @IsNotEmpty()
  public itemId: string;

  @FromBody()
  @IsString()
  @IsNotEmpty()
  public trackId: string;

  @FromBody()
  @IsIn(['media', 'thumbnail'])
  public role: 'media' | 'thumbnail';

  @FromBody()
  @IsString()
  @IsNotEmpty()
  public fileName: string;

  @FromBody()
  @IsIn(['video/mp4', 'video/webm', 'image/webp', 'image/jpeg', 'image/png'])
  public mimeType: 'video/mp4' | 'video/webm' | 'image/webp' | 'image/jpeg' | 'image/png';

  @FromBody()
  @IsInt()
  @Min(1)
  public uploadLength: number;

  @FromBody()
  @IsString()
  @IsNotEmpty()
  public checksumSha256: string;
}

export class CompleteClipUploadReqDTO {
  @FromParam()
  @IsString()
  @IsNotEmpty()
  public uploadId: string;

  @FromBody()
  @IsObject()
  public metadata: {
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

  @FromBody()
  @IsOptional()
  @IsObject()
  public thumbnail?: {
    mimeType: 'image/webp' | 'image/jpeg' | 'image/png';
    byteSize: number;
    checksumSha256: string;
    uploadId: string;
  };
}

export class ListClipsReqDTO {
  @FromQuery()
  @IsString()
  @IsNotEmpty()
  public uca: string;

  @FromQuery()
  @IsOptional()
  @IsString()
  public userId?: string;

  @FromQuery()
  @IsOptional()
  @IsString()
  public trackId?: string;

  @FromQuery()
  @IsOptional()
  @IsIn(['manual', 'automation'])
  public source?: ClipSource;

  @FromQuery()
  @IsOptional()
  @IsIn(['firstBlood', 'accepted', 'manual', 'other'])
  public category?: ClipCategory;

  @FromQuery()
  @IsOptional()
  @IsIn(['ready', 'deleted', 'expired'])
  public status?: ClipStatus;

  @FromQuery()
  @IsOptional()
  @IsString()
  public tag?: string;

  @FromQuery()
  @IsOptional()
  @IsNumber()
  public createdAfter?: number;

  @FromQuery()
  @IsOptional()
  @IsNumber()
  public createdBefore?: number;

  @FromQuery()
  @IsOptional()
  @IsInt()
  @Min(1)
  public page?: number;

  @FromQuery()
  @IsOptional()
  @IsInt()
  @Min(1)
  public pageSize?: number;
}

export class ClipIdReqDTO {
  @FromParam()
  @IsString()
  @IsNotEmpty()
  public clipId: string;
}

export class EmptyClipRespDTO {}
export class ClipAutomationRespDTO {}
export class ListClipAutomationsRespDTO {}
export class ClipAutomationRunRespDTO {}
export class ListClipAutomationRunsRespDTO {}
export class ClipTaskRespDTO {}
export class ListClipTasksRespDTO {}
export class CreateClipUploadRespDTO {}
export class CompleteClipUploadRespDTO {}
export class ListClipsRespDTO {}
export class ClipRespDTO {}
export class DeleteClipRespDTO {}
