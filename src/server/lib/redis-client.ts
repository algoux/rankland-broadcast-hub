import { Inject, Provide } from 'bwcx-core';
import Redis, { RedisOptions } from 'ioredis';
import RedisConfig from '@server/configs/redis/redis.config';

@Provide()
export default class RedisClient {
  private client: Redis | null = null;

  public constructor(
    @Inject()
    private readonly redisConfig: RedisConfig,
  ) {}

  async init() {
    const options: RedisOptions = {
      host: this.redisConfig.host,
      port: this.redisConfig.port,
      password: this.redisConfig.password,
      db: this.redisConfig.db,
      keyPrefix: this.redisConfig.keyPrefix,
      retryStrategy: this.redisConfig.retryStrategy,
      maxRetriesPerRequest: this.redisConfig.maxRetriesPerRequest,
      enableReadyCheck: this.redisConfig.enableReadyCheck,
      lazyConnect: this.redisConfig.lazyConnect,
    };

    this.client = new Redis(options);

    this.client.on('connect', () => {
    });

    this.client.on('ready', () => {
      console.log('Redis connected');
    });

    this.client.on('error', (err) => {
      console.error('Redis error:', err);
    });

    this.client.on('close', () => {
      console.log('Redis connection closed');
    });

    // 如果 lazyConnect 为 true，需要手动连接
    if (this.redisConfig.lazyConnect) {
      this.client.connect();
    }

    // 等待连接就绪
    if (this.redisConfig.enableReadyCheck) {
      await new Promise<void>((resolve, reject) => {
        // 如果已经就绪，直接 resolve
        if (this.client!.status === 'ready') {
          resolve();
          return;
        }

        const readyHandler = () => {
          cleanup();
          resolve();
        };

        const errorHandler = (err: Error) => {
          cleanup();
          reject(err);
        };

        const cleanup = () => {
          this.client!.off('ready', readyHandler);
          this.client!.off('error', errorHandler);
        };

        this.client!.once('ready', readyHandler);
        this.client!.once('error', errorHandler);
      });
    }

    return this.client;
  }

  getClient(): Redis {
    if (!this.client) {
      throw new Error('Redis client not initialized. Call init() first.');
    }
    return this.client;
  }

  async close() {
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
  }
}
