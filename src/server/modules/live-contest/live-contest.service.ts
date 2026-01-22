import { Provide, Inject } from 'bwcx-core';
import type { User } from '@algoux/standard-ranklist';
import type * as srk from '@algoux/standard-ranklist';
import axios, { type AxiosInstance, type AxiosResponse } from 'axios';
import http from 'http';
import https from 'https';
import LogicException from '@server/exceptions/logic.exception';
import { ErrCode } from '@common/enums/err-code.enum';
import Redis from 'ioredis';
import RedisClient from '@server/lib/redis-client';

export interface LiveContest {
  alias: string;
  name: string;
  contest: srk.Contest;
  problems: srk.Problem[];
  markers: srk.Marker[];
  series: srk.RankSeries[];
  sorter: srk.Sorter;
  contributors: srk.Contributor[];
}

export type LiveContestMember = User & {
  banned: boolean;
  broadcasterToken?: string;
};

export interface BroadcasterStoreTrackItem {
  trackId: string;
  type: 'screen' | 'camera' | 'microphone';
  // other fields...
}

export type BroadcasterStoreTracks = BroadcasterStoreTrackItem[];

export interface BroadcasterStoreInfo {
  status: 'ready' | 'broadcasting';
  tracks: Pick<BroadcasterStoreTrackItem, 'trackId' | 'type'>[];
  broadcastingTrackIds: string[];
}

export interface ShotStoreTrackItem {
  trackId: string;
  name: string;
  type: 'video' | 'audio';
  // other fields...
}

export type ShotStoreTracks = ShotStoreTrackItem[];

export interface ShotStoreInfo {
  shotName: string;
  status: 'ready' | 'broadcasting';
  tracks: ShotStoreTrackItem[];
  broadcastingTrackIds: string[];
}

@Provide()
export default class LiveContestService {
  private readonly redis: Redis;
  private readonly apiClient: AxiosInstance;
  private readonly baseUrl: string;
  private shotStoreMap: Map</** uca */ string, Map</** shotId */ string, ShotStoreInfo>> = new Map();

  public constructor(@Inject() private readonly redisClient: RedisClient) {
    this.redis = this.redisClient.getClient();
    this.baseUrl = (process.env.RL_API_URL || 'https://rl-api-v2.algoux.cn/api').trim();

    const httpAgent = new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 1000,
      maxSockets: 50,
      maxFreeSockets: 10,
    });

    const httpsAgent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 1000,
      maxSockets: 50,
      maxFreeSockets: 10,
    });

    this.apiClient = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      httpAgent,
      httpsAgent,
      headers: {
        'x-token': process.env.RL_API_TOKEN || '',
      },
      validateStatus: (status) => status < 500,
    });

    this.apiClient.interceptors.response.use(
      (response: AxiosResponse) => {
        const responseData = response.data;
        if (responseData && typeof responseData === 'object') {
          if (responseData.success === false) {
            const errorCode = responseData.code !== undefined ? (responseData.code as ErrCode) : ErrCode.SystemError;
            throw new LogicException(errorCode);
          } else if (responseData.success === true) {
            response.data = responseData.data;
            return response;
          }
        }
        console.error('Invalid response data:', responseData);
        throw new Error('Invalid response data');
      },
      (error) => {
        return Promise.reject(error);
      },
    );
  }

  public async findContestByAlias(alias: string): Promise<LiveContest | null> {
    try {
      const res = await this.apiClient.get<LiveContest>('/getLiveContest', {
        params: { alias },
      });
      return res.data;
    } catch (error) {
      if (error instanceof LogicException) {
        if (error.code === ErrCode.LiveContestNotFound) {
          return null;
        }
        throw error;
      }
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  public filterMemberForPublic(member: LiveContestMember | any): User {
    const memberObj = member && typeof member.toObject === 'function' ? member.toObject() : member;
    const { _id, contestId, banned, broadcasterToken, index, createdAt, updatedAt, ...publicMember } = memberObj as any;
    return publicMember as User;
  }

  public async findContestMemberById(alias: string, userId: string): Promise<LiveContestMember | null> {
    try {
      const res = await this.apiClient.get<LiveContestMember>('/getContestMember', {
        params: { alias, userId },
      });
      return res.data;
    } catch (error) {
      if (error instanceof LogicException) {
        if (error.code === ErrCode.LiveContestNotFound || error.code === ErrCode.LiveContestMemberNotFound) {
          return null;
        }
        throw error;
      }
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  public async getBroadcasterStoreInfo(alias: string, userId: string): Promise<BroadcasterStoreInfo | null> {
    return this.getRedisJsonResp<BroadcasterStoreInfo>(
      await this.redis.hget(this.getBroadcasterStoreInfoHashKey(alias), userId),
    );
  }

  public async getAllBroadcasterStoreInfo(alias: string): Promise<Record<string, BroadcasterStoreInfo>> {
    const res = await this.redis.hgetall(this.getBroadcasterStoreInfoHashKey(alias));
    const obj: Record<string, BroadcasterStoreInfo> = {};
    Object.keys(res).forEach((userId) => {
      obj[userId] = this.getRedisJsonResp<BroadcasterStoreInfo>(res[userId]);
    });
    return obj;
  }

  public async setBroadcasterStoreInfo(alias: string, userId: string, info: BroadcasterStoreInfo): Promise<void> {
    await this.redis.hset(this.getBroadcasterStoreInfoHashKey(alias), userId, JSON.stringify(info));
    // TODO temp hardcode expire time
    await this.redis.expire(this.getBroadcasterStoreInfoHashKey(alias), 60 * 60 * 24);
  }

  public async delBroadcasterStoreInfo(alias: string, userId: string): Promise<void> {
    await this.redis.hdel(this.getBroadcasterStoreInfoHashKey(alias), userId);
  }

  public async getBroadcasterStoreTracks(alias: string, userId: string): Promise<BroadcasterStoreTracks | null> {
    return this.getRedisJsonResp<BroadcasterStoreTracks>(
      await this.redis.hget(this.getBroadcasterStoreTracksHashKey(alias), userId),
    );
  }

  public async getAllBroadcasterStoreTracks(alias: string): Promise<Record<string, BroadcasterStoreTracks>> {
    const res = await this.redis.hgetall(this.getBroadcasterStoreTracksHashKey(alias));
    const obj: Record<string, BroadcasterStoreTracks> = {};
    Object.keys(res).forEach((userId) => {
      obj[userId] = this.getRedisJsonResp<BroadcasterStoreTracks>(res[userId]);
    });
    return obj;
  }

  public async setBroadcasterStoreTracks(
    alias: string,
    userId: string,
    tracks: BroadcasterStoreTracks,
  ): Promise<void> {
    await this.redis.hset(this.getBroadcasterStoreTracksHashKey(alias), userId, JSON.stringify(tracks));
    // TODO temp hardcode expire time
    await this.redis.expire(this.getBroadcasterStoreTracksHashKey(alias), 60 * 60 * 24);
  }

  public async delBroadcasterStoreTracks(alias: string, userId: string): Promise<void> {
    await this.redis.hdel(this.getBroadcasterStoreTracksHashKey(alias), userId);
  }

  public getBroadcasterStoreInfoHashKey(alias: string) {
    return `broadcaster:${alias}:info`;
  }

  public getBroadcasterStoreTracksHashKey(alias: string) {
    return `broadcaster:${alias}:tracks`;
  }

  private getRedisJsonResp<T>(redisResp: string | null): T | null {
    if (!redisResp) {
      return null;
    }
    try {
      return JSON.parse(redisResp);
    } catch (e) {
      return null;
    }
  }

  public getShotStore(uca: string): Map</** shotId */ string, ShotStoreInfo> | undefined {
    if (!this.shotStoreMap.has(uca)) {
      return undefined;
    }
    return this.shotStoreMap.get(uca)!;
  }

  public setShotStore(uca: string, shotId: string, info: ShotStoreInfo): void {
    if (!this.shotStoreMap.has(uca)) {
      this.shotStoreMap.set(uca, new Map());
    }
    this.shotStoreMap.get(uca)!.set(shotId, info);
  }

  public delShotStore(uca: string, shotId: string): void {
    if (!this.shotStoreMap.has(uca)) {
      return;
    }
    this.shotStoreMap.get(uca)!.delete(shotId);
  }
}
