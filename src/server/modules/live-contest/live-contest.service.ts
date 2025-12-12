import { Provide, Inject } from 'bwcx-core';
import type { User } from '@algoux/standard-ranklist';
import type * as srk from '@algoux/standard-ranklist';
import axios, { type AxiosInstance, type AxiosResponse } from 'axios';
import http from 'http';
import https from 'https';
import LogicException from '@server/exceptions/logic.exception';
import { ErrCode } from '@common/enums/err-code.enum';

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

@Provide()
export default class LiveContestService {
  private readonly apiClient: AxiosInstance;
  private readonly baseUrl: string;

  public constructor() {
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
}
