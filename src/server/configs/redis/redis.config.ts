import { Config } from 'bwcx-ljsm';

@Config()
export default class RedisConfig {
  public readonly host: string = '127.0.0.1';
  public readonly port: number = 6379;
  public readonly password?: string;
  public readonly db: number = 0;
  public readonly keyPrefix = 'rl_broadcast_hub:';
  public readonly retryStrategy?: (times: number) => number | null;
  public readonly maxRetriesPerRequest?: number;
  public readonly enableReadyCheck: boolean = true;
  public readonly lazyConnect: boolean = false;
}
