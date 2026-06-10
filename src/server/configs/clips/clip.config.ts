import path from 'path';
import { Config } from 'bwcx-ljsm';

@Config()
export default class ClipConfig {
  public readonly storageDir: string = process.env.CLIP_STORAGE_DIR || path.join(process.cwd(), 'temp/clips');
  public readonly sqlitePath: string = process.env.CLIP_SQLITE_PATH || path.join(this.storageDir, 'clips.sqlite');
  public readonly maxDurationMs: number = parseInt(process.env.CLIP_MAX_DURATION_MS || '120000', 10);
  public readonly maxUploadBytes: number = parseInt(process.env.CLIP_MAX_UPLOAD_BYTES || '524288000', 10);
  public readonly maxTracksPerTask: number = parseInt(process.env.CLIP_MAX_TRACKS_PER_TASK || '8', 10);
  public readonly maxStorageBytes: number = parseInt(process.env.CLIP_MAX_STORAGE_BYTES || `${20 * 1024 * 1024 * 1024}`, 10);
  public readonly defaultRetentionDays: number = parseInt(process.env.CLIP_DEFAULT_RETENTION_DAYS || '30', 10);
  public readonly uploadTokenTtlMs: number = parseInt(process.env.CLIP_UPLOAD_TOKEN_TTL_MS || '900000', 10);
  public readonly taskMaxAttempts: number = parseInt(process.env.CLIP_TASK_MAX_ATTEMPTS || '3', 10);
  public readonly requestAckTimeoutMs: number = parseInt(process.env.CLIP_REQUEST_ACK_TIMEOUT_MS || '5000', 10);
}
