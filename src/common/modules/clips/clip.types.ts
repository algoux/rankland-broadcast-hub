export type ClipSource = 'manual' | 'automation';
export type ClipCategory = 'firstBlood' | 'accepted' | 'manual' | 'other';
export type ClipPriority = 'low' | 'normal' | 'high';

export type ClipAutomationTriggerKind = 'manualOnly' | 'firstBlood' | 'accepted';

export type ClipTaskStatus =
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

export type ClipTaskItemStatus =
  | 'queued'
  | 'requested'
  | 'client_processing'
  | 'uploading'
  | 'verifying'
  | 'ready'
  | 'failed'
  | 'cancelled';

export type ClipUploadStatus = 'created' | 'uploading' | 'completed' | 'failed' | 'expired';
export type ClipStatus = 'ready' | 'deleted' | 'expired';

export interface ClipAutomationTask {
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

export interface ClipAutomationRun {
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

export interface ClipTaskItem {
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

export interface ClipTask {
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

export interface Clip {
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

export interface CreateClipAutomationReq {
  name: string;
  enabled?: boolean;
  trigger: ClipAutomationTask['trigger'];
  target: ClipAutomationTask['target'];
  clipWindow: ClipAutomationTask['clipWindow'];
  defaults: ClipAutomationTask['defaults'];
}

export interface UpdateClipAutomationReq {
  name?: string;
  enabled?: boolean;
  trigger?: ClipAutomationTask['trigger'];
  target?: ClipAutomationTask['target'];
  clipWindow?: ClipAutomationTask['clipWindow'];
  defaults?: ClipAutomationTask['defaults'];
}

export interface CreateClipAutomationRunReq {
  triggerKind: ClipAutomationTriggerKind;
  triggerKey: string;
  eventServerMs: number;
  payload: Record<string, any>;
  status?: ClipAutomationRun['status'];
  errorCode?: string;
  errorMessage?: string;
}

export interface UpdateClipAutomationRunReq {
  status: ClipAutomationRun['status'];
  createdTaskIds?: string[];
  errorCode?: string;
  errorMessage?: string;
}

export interface CreateClipTaskReq {
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

export interface ReportClipTaskProgressReq {
  itemId?: string;
  status?: ClipTaskStatus | ClipTaskItemStatus;
  progress: number;
  message?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface CreateClipUploadReq {
  itemId: string;
  trackId: string;
  role: 'media' | 'thumbnail';
  fileName: string;
  mimeType: 'video/mp4' | 'video/webm' | 'image/webp' | 'image/jpeg' | 'image/png';
  uploadLength: number;
  checksumSha256: string;
}

export interface CompleteClipUploadReq {
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

export interface RequestCreateClipPayload {
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

export interface RequestCreateClipAck {
  accepted: boolean;
  errorCode?: string;
  errorMessage?: string;
}
