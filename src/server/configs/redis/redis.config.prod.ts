import { Config } from 'bwcx-ljsm';
import RedisConfig from './redis.config';

@Config(RedisConfig, { when: 'production', override: true })
export default class RedisProdConfig extends RedisConfig {
  public readonly host: string = process.env.REDIS_HOST || '127.0.0.1';
  public readonly port: number = parseInt(process.env.REDIS_PORT || '6379', 10);
  public readonly password: string | undefined = process.env.REDIS_PASS;
  public readonly db: number = parseInt(process.env.REDIS_DB || '0', 10);
  public readonly maxRetriesPerRequest: number = 3;
}
