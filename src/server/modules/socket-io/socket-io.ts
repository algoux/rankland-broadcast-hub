import { Inject, Provide } from 'bwcx-core';
import { Namespace, Server, Socket } from 'socket.io';
import type http from 'http';
import Redis from 'ioredis';
import type { DefaultEventsMap } from 'socket.io/dist/typed-events';
import LiveContestService from '../live-contest/live-contest.service';
import LogicException from '@server/exceptions/logic.exception';
import { errCodeConfigs } from '@server/err-code-configs';
import { ErrCode } from '@common/enums/err-code.enum';
import RedisClient from '@server/lib/redis-client';
import MediasoupWorker from '@server/lib/mediasoup-worker';
import type {
  AppData,
  ConsumerLayers,
  DtlsParameters,
  MediaKind,
  Producer,
  Router,
  RtpCapabilities,
  RtpParameters,
  WebRtcTransport,
} from 'mediasoup/node/lib/types';

interface MediaRoom {
  peers: Map<string, MediaRoomPeer>;
  broadcaster: MediaRoomPeer | null; // 指向 peer 中的 broadcaster
  viewers: Map<string, MediaRoomPeer>;
}

interface MediaRoomPeer {
  transport: WebRtcTransport;
  trackProducers?: Map</** trackId */ string, Producer>;
}

interface BroadcasterStoreInfo {
  status: 'ready' | 'broadcasting';
  broadcastingTrackIds: string[];
}

interface BroadcasterStoreTracks {
  trackIds: string[];
  type: 'screen' | 'camera' | 'microphone';
}

@Provide()
export default class SocketIOServer {
  private redis: Redis;
  private mediasoupRouter: Router<AppData>;
  private mediaRooms: Map<string, MediaRoom> = new Map();

  public constructor(
    @Inject() private readonly liveContestService: LiveContestService,
    @Inject() private readonly redisClient: RedisClient,
    @Inject() private readonly mediasoupWorker: MediasoupWorker,
  ) {
    this.redis = this.redisClient.getClient();
    this.mediasoupRouter = this.mediasoupWorker.routerMap.get('default');
  }

  public io: Server;
  public rootNsp: Namespace<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, any>;
  public broadcasterNsp: Namespace<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, any>;
  public viewerNsp: Namespace<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, any>;

  public init(server: http.Server) {
    this.io = new Server(server, {
      // path: '/rankland_broadcast_hub/socket.io',
    });
    this.mount();
  }

  public mount() {
    this.rootMount();
    this.broadcasterMount();
    this.viewerMount();
  }

  public rootMount() {
    this.rootNsp = this.io.of('/');
    this.rootNsp.use(async (socket, next) => {
      return next(getGuardErrorObject(new LogicException(ErrCode.IllegalRequest)));
    });
  }

  public broadcasterMount() {
    this.broadcasterNsp = this.io.of('/broadcaster');
    this.broadcasterNsp.use(async (socket, next) => {
      const { id: broadcasterId, alias, userId, broadcasterToken } = socket.handshake.auth;
      try {
        const contestMember = await this.liveContestService.findContestMemberById(alias, userId);
        if (!contestMember) {
          return next(getGuardErrorObject(new LogicException(ErrCode.LiveContestMemberNotFound)));
        }
        if (!broadcasterToken || broadcasterToken !== contestMember.broadcasterToken) {
          return next(getGuardErrorObject(new LogicException(ErrCode.InvalidAuthInfo)));
        }
        next();
      } catch (e) {
        console.error(
          `[socket.authGuard] broadcaster guard failed for broadcaster: ${broadcasterId} (${alias}, ${userId})`,
          e,
        );
        next(getGuardErrorObject(e));
      }
    });

    this.broadcasterNsp.on('connection', (socket) => {
      const { id: broadcasterId, alias, userId } = socket.handshake.auth;
      console.log(`[socket.connection] [${alias}:${userId}] broadcaster:`, broadcasterId);

      socket.on('disconnect', async (reason) => {
        console.log(`[socket.disconnect] [${alias}:${userId}] broadcaster:`, broadcasterId, reason);
        // 粗暴但有效的做法，一旦推流方断连就清空所有，下次需要重新走一套流程
        await this.clearRoomAndAllData(alias, userId);
      });

      registerSocketEvent(socket, 'getContestInfo', async () => {
        const contestInfo = await this.liveContestService.findContestByAlias(alias);
        if (!contestInfo) {
          throw new LogicException(ErrCode.LiveContestNotFound);
        }
        const contestMember = await this.liveContestService.findContestMemberById(alias, userId);
        if (!contestMember) {
          throw new LogicException(ErrCode.LiveContestMemberNotFound);
        }
        return {
          alias: contestInfo.alias,
          contest: contestInfo.contest,
          user: this.liveContestService.filterMemberForPublic(contestMember),
          serverTimestamp: Date.now(),
        };
      });

      /**
       * confirmReady: 确认准备就绪，服务端创建 media room 并创建 transport
       */
      registerSocketEvent(socket, 'confirmReady', async (data: { tracks: BroadcasterStoreTracks[] }) => {
        console.log(`[socket.confirmReady] [${alias}:${userId}] data:`, data);
        socket.join(this.getBroadcasterRoomKey(alias, userId));
        await this.redis.set(
          `${this.getBroadcasterRoomKey(alias, userId)}:info`,
          JSON.stringify({
            status: 'ready',
            broadcastingTrackIds: [],
          }),
        );
        await this.redis.set(`${this.getBroadcasterRoomKey(alias, userId)}:tracks`, JSON.stringify(data.tracks));

        const transport = await this.mediasoupRouter.createWebRtcTransport({
          listenIps: [{ ip: '0.0.0.0', announcedIp: process.env.PUBLIC_IP || '127.0.0.1' }],
          enableUdp: true,
          enableTcp: true,
        });
        const room = this.createMediaRoom();
        const roomKey = this.getMediaRoomKey(alias, userId);
        const broadcasterPeer: MediaRoomPeer = {
          transport,
          trackProducers: new Map(),
        };
        room.peers.set(broadcasterId, broadcasterPeer);
        room.broadcaster = broadcasterPeer; // alias to peers[broadcasterId]
        this.mediaRooms.set(roomKey, room);
        console.log(`[socket.confirmReady] [${alias}:${userId}] created media room: ${roomKey}`);
        console.log(`[socket.confirmReady] [${alias}:${userId}] joined broadcaster: ${broadcasterId}`);

        // temp trigger requestStartBroadcast
        // setTimeout(async () => {
        //   const info = getRedisJsonResp<BroadcasterStoreInfo>(
        //     await this.redis.get(`${this.getBroadcasterRoomKey(alias, userId)}:info`),
        //   );
        //   if (!info || info.status !== 'ready') {
        //     return;
        //   }
        //   const tracks = getRedisJsonResp<BroadcasterStoreTracks[]>(
        //     await this.redis.get(`${this.getBroadcasterRoomKey(alias, userId)}:tracks`),
        //   );
        //   if (!tracks || tracks.length === 0) {
        //     return;
        //   }
        //   console.log(
        //     `[socket.confirmReady] [${alias}:${userId}] temp trigger requestStartBroadcast:`,
        //     tracks.map((track: any) => track.trackId),
        //   );
        //   socket.emit('requestStartBroadcast', {
        //     trackIds: tracks.map((track: any) => track.trackId),
        //     transport: {
        //       id: transport.id,
        //       iceParameters: transport.iceParameters,
        //       iceCandidates: transport.iceCandidates,
        //       dtlsParameters: transport.dtlsParameters,
        //     },
        //     routerRtpCapabilities: this.mediasoupRouter.rtpCapabilities,
        //   });
        // }, 2000);
      });

      registerSocketEvent(socket, 'cancelReady', async () => {
        console.log(`[socket.cancelReady] [${alias}:${userId}]`);
        socket.leave(this.getBroadcasterRoomKey(alias, userId));
        await this.clearRoomAndAllData(alias, userId);
      });

      registerSocketEvent(socket, 'completeConnectTransport', async (data: { dtlsParameters: DtlsParameters }) => {
        console.log(`[socket.completeConnectTransport] [${alias}:${userId}] data:`, data);
        const mediaRoom = this.mediaRooms.get(this.getMediaRoomKey(alias, userId));
        if (!mediaRoom) {
          throw new LogicException(ErrCode.BroadcastMediaRoomBroken);
        }
        const peer = mediaRoom.peers.get(broadcasterId);
        if (!peer) {
          throw new LogicException(ErrCode.BroadcastMediaRoomPeerMissing);
        }
        await peer.transport.connect({
          dtlsParameters: data.dtlsParameters,
        });
        console.log(
          `[socket.completeConnectTransport] [${alias}:${userId}] connected to transport:`,
          peer.transport.id,
        );
      });

      registerSocketEvent(
        socket,
        'produce',
        async (data: { trackId: string; kind: MediaKind; rtpParameters: RtpParameters }) => {
          console.log(`[socket.produce] [${alias}:${userId}] data:`, data);
          const mediaRoom = this.mediaRooms.get(this.getMediaRoomKey(alias, userId));
          if (!mediaRoom) {
            throw new LogicException(ErrCode.BroadcastMediaRoomBroken);
          }
          const peer = mediaRoom.peers.get(broadcasterId);
          if (!peer) {
            throw new LogicException(ErrCode.BroadcastMediaRoomPeerMissing);
          }
          const producer = await peer.transport.produce({
            kind: data.kind,
            rtpParameters: data.rtpParameters,
            appData: {
              broadcasterId,
              alias,
              userId,
              trackId: data.trackId,
            },
          });
          console.log(`[socket.produce] [${alias}:${userId}] produced track:`, producer.id);
          peer.trackProducers?.set(data.trackId, producer);
          const info = getRedisJsonResp<BroadcasterStoreInfo>(
            await this.redis.get(`${this.getBroadcasterRoomKey(alias, userId)}:info`),
          );
          if (info) {
            info.status = 'broadcasting';
            info.broadcastingTrackIds.push(data.trackId);
            await this.redis.set(`${this.getBroadcasterRoomKey(alias, userId)}:info`, JSON.stringify(info));
          }
          return {
            producerId: producer.id,
            type: producer.type,
            appData: producer.appData,
          };
        },
      );
    });
  }

  public viewerMount() {
    this.viewerNsp = this.io.of('/viewer');
    this.viewerNsp.use(async (socket, next) => {
      const { id: viewerId, alias, userId, token } = socket.handshake.auth;
      try {
        // TODO use contest token instead of global auth token
        if (!token || token !== process.env.AUTH_TOKEN) {
          return next(getGuardErrorObject(new LogicException(ErrCode.InvalidAuthInfo)));
        }
        next();
      } catch (e) {
        console.error(`[socket.authGuard] viewer guard failed for viewer: ${viewerId} (${alias}, ${userId})`, e);
        next(getGuardErrorObject(e));
      }
    });

    this.viewerNsp.on('connection', async (socket) => {
      const { id: viewerId, alias, userId } = socket.handshake.auth;
      console.log(`[socket.connection] [${alias}:${userId}] viewer:`, viewerId);
      socket.join(this.getViewerRoomKey(alias, userId));

      /**
       * 断连后此 viewer 相关 peer 信息和 transport 都会被清理，需要重新 joinBroadcastRoom
       */
      socket.on('disconnect', () => {
        console.log(`[socket.disconnect] [${alias}:${userId}] viewer:`, viewerId);
        const mediaRoom = this.mediaRooms.get(this.getMediaRoomKey(alias, userId));
        const peer = mediaRoom?.peers.get(viewerId);
        peer?.transport.close();
        mediaRoom?.peers.delete(viewerId);
        mediaRoom?.viewers.delete(viewerId);
      });

      registerSocketEvent(socket, 'startBroadcast', async (data: { trackIds: string[] }) => {
        const info = getRedisJsonResp<BroadcasterStoreInfo>(
          await this.redis.get(`${this.getBroadcasterRoomKey(alias, userId)}:info`),
        );
        if (!info || info.status !== 'ready') {
          throw new LogicException(ErrCode.BroadcastNotReady);
        }
        const tracks = getRedisJsonResp<BroadcasterStoreTracks[]>(
          await this.redis.get(`${this.getBroadcasterRoomKey(alias, userId)}:tracks`),
        );
        if (!tracks || tracks.length === 0) {
          throw new LogicException(ErrCode.BroadcastNotReady);
        }
        // 找到 room 里的 broadcaster，并由服务端向 broadcaster 请求开始推流
        const mediaRoom = this.mediaRooms.get(this.getMediaRoomKey(alias, userId));
        if (!mediaRoom) {
          throw new LogicException(ErrCode.BroadcastMediaRoomBroken);
        }
        const broadcasterPeer = mediaRoom.broadcaster;
        if (!broadcasterPeer) {
          throw new LogicException(ErrCode.BroadcastMediaRoomPeerMissing);
        }
        const availableTracks = data.trackIds.filter((trackId) => {
          return tracks.some((track: any) => track.trackId === trackId);
        });
        console.log(`[socket.startBroadcast] [${alias}:${userId}] tracks:`, availableTracks);
        if (availableTracks.length > 0) {
          console.log(
            `[socket.emit.requestStartBroadcast] [${alias}:${userId}] requesting start broadcast to broadcaster`,
          );
          this.broadcasterNsp.to(this.getBroadcasterRoomKey(alias, userId)).emit('requestStartBroadcast', {
            trackIds: availableTracks,
            transport: {
              id: broadcasterPeer.transport.id,
              iceParameters: broadcasterPeer.transport.iceParameters,
              iceCandidates: broadcasterPeer.transport.iceCandidates,
              dtlsParameters: broadcasterPeer.transport.dtlsParameters,
            },
            routerRtpCapabilities: this.mediasoupRouter.rtpCapabilities,
          });
        }
      });

      registerSocketEvent(socket, 'joinBroadcastRoom', async () => {
        const mediaRoom = this.mediaRooms.get(this.getMediaRoomKey(alias, userId));
        if (!mediaRoom) {
          throw new LogicException(ErrCode.BroadcastMediaRoomBroken);
        }
        const transport = await this.mediasoupRouter.createWebRtcTransport({
          listenIps: [{ ip: '0.0.0.0', announcedIp: process.env.PUBLIC_IP || '127.0.0.1' }],
          enableUdp: true,
          enableTcp: true,
        });
        const viewerPeer: MediaRoomPeer = {
          transport,
        };
        mediaRoom.peers.set(viewerId, viewerPeer);
        mediaRoom.viewers.set(viewerId, viewerPeer); // alias to peers[viewerId]
        console.log(`[socket.joinBroadcastRoom] [${alias}:${userId}] joined viewer:`, viewerId);
        return {
          transport: {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
          },
          routerRtpCapabilities: this.mediasoupRouter.rtpCapabilities,
        };
      });

      registerSocketEvent(socket, 'completeConnectTransport', async (data: { dtlsParameters: DtlsParameters }) => {
        console.log(`[socket.completeConnectTransport] [${alias}:${userId}] data:`, data);
        const mediaRoom = this.mediaRooms.get(this.getMediaRoomKey(alias, userId));
        if (!mediaRoom) {
          throw new LogicException(ErrCode.BroadcastMediaRoomBroken);
        }
        const peer = mediaRoom.peers.get(viewerId);
        if (!peer) {
          throw new LogicException(ErrCode.BroadcastMediaRoomPeerMissing);
        }
        await peer.transport.connect({
          dtlsParameters: data.dtlsParameters,
        });
        console.log(
          `[socket.completeConnectTransport] [${alias}:${userId}] connected to transport:`,
          peer.transport.id,
        );
      });

      registerSocketEvent(
        socket,
        'consume',
        async (data: {
          trackId: string;
          rtpCapabilities: RtpCapabilities;
          paused?: boolean;
          preferredLayers?: ConsumerLayers;
        }) => {
          console.log(`[socket.consume] [${alias}:${userId}] data:`, data);
          const mediaRoom = this.mediaRooms.get(this.getMediaRoomKey(alias, userId));
          if (!mediaRoom) {
            throw new LogicException(ErrCode.BroadcastMediaRoomBroken);
          }
          const peer = mediaRoom.peers.get(viewerId);
          if (!peer) {
            throw new LogicException(ErrCode.BroadcastMediaRoomPeerMissing);
          }
          const broadcasterPeer = mediaRoom.broadcaster;
          if (!broadcasterPeer) {
            throw new LogicException(ErrCode.BroadcastMediaRoomPeerMissing);
          }
          const producer = broadcasterPeer.trackProducers?.get(data.trackId);
          if (!producer) {
            throw new LogicException(ErrCode.BroadcastMediaRoomRequiredTrackMissing);
          }
          const canConsume = this.mediasoupRouter.canConsume({
            producerId: producer.id,
            rtpCapabilities: data.rtpCapabilities,
          });
          if (!canConsume) {
            throw new LogicException(ErrCode.BroadcastMediaRoomCannotConsume);
          }
          const consumer = await peer.transport.consume({
            producerId: producer.id,
            rtpCapabilities: data.rtpCapabilities,
            paused: data.paused,
            preferredLayers: data.preferredLayers,
            appData: {
              viewerId,
              alias,
              userId,
              trackId: data.trackId,
            },
          });
          console.log(`[socket.consume] [${alias}:${userId}] consumed track:`, consumer.id);
          return {
            consumerId: consumer.id,
            producerId: producer.id,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
            type: consumer.type,
            producerPaused: consumer.producerPaused,
            appData: consumer.appData,
          };
        },
      );

      registerSocketEvent(socket, 'stopBroadcast', async () => {
        console.log(`[socket.stopBroadcast] [${alias}:${userId}]`);
        const mediaRoom = this.mediaRooms.get(this.getMediaRoomKey(alias, userId));
        if (!mediaRoom) {
          throw new LogicException(ErrCode.BroadcastMediaRoomBroken);
        }
        this.broadcasterNsp.to(this.getBroadcasterRoomKey(alias, userId)).emit('requestStopBroadcast', async () => {
          console.log(
            `[socket.emit.requestStopBroadcast] [${alias}:${userId}] received broadcaster ack, cleaning up producers`,
          );
          // 仅清理 producers 相关，不关闭 transport
          const info = getRedisJsonResp<BroadcasterStoreInfo>(
            await this.redis.get(`${this.getBroadcasterRoomKey(alias, userId)}:info`),
          );
          if (info) {
            info.status = 'ready';
            info.broadcastingTrackIds = [];
            await this.redis.set(`${this.getBroadcasterRoomKey(alias, userId)}:info`, JSON.stringify(info));
          }
          mediaRoom.broadcaster?.trackProducers?.forEach((producer) => {
            producer.close();
          });
          mediaRoom.broadcaster?.trackProducers?.clear();
          this.viewerNsp.to(this.getViewerRoomKey(alias, userId)).emit('broadcastStopped');
        });
      });
    });
  }

  private getBroadcasterRoomKey(alias: string, userId: string) {
    return `broadcaster:${alias}:${userId}`;
  }

  private getViewerRoomKey(alias: string, userId: string) {
    return `viewer:${alias}:${userId}`;
  }

  private getMediaRoomKey(alias: string, userId: string, trackId?: string) {
    return trackId ? `${alias}:${userId}:${trackId}` : `${alias}:${userId}`;
  }

  private createMediaRoom() {
    const room: MediaRoom = {
      peers: new Map<string, MediaRoomPeer>(),
      broadcaster: null,
      viewers: new Map<string, MediaRoomPeer>(),
    };
    return room;
  }

  private async clearRoomAndAllData(alias: string, userId: string) {
    await Promise.all([
      this.redis.del(`${this.getBroadcasterRoomKey(alias, userId)}:info`),
      this.redis.del(`${this.getBroadcasterRoomKey(alias, userId)}:tracks`),
    ]);

    const room = this.mediaRooms.get(this.getMediaRoomKey(alias, userId));
    if (room) {
      room.broadcaster?.trackProducers?.forEach((producer) => {
        producer.close();
      });
      room.peers.forEach((peer) => {
        peer.transport.close();
      });
      room.peers.clear();
      this.mediaRooms.delete(this.getMediaRoomKey(alias, userId));
    }
  }
}

function handleError(e: any) {
  if (e instanceof LogicException) {
    return {
      success: false,
      code: e.code,
      msg: errCodeConfigs[e.code],
    };
  }
  return {
    success: false,
    code: ErrCode.SystemError,
    msg: errCodeConfigs[ErrCode.SystemError],
  };
}

function getGuardErrorObject(e: any) {
  const err = new Error(e instanceof LogicException ? e.message : 'System error');
  // @ts-ignore
  err.data = handleError(e);
  return err;
}

function wrapSocketHandler(event: string, handler: (data: any) => Promise<any> | any) {
  return async (...args: any[]) => {
    const callback = args[args.length - 1];
    const data = args.length > 1 ? args[0] : undefined;
    try {
      const result = await handler(data);
      callback({
        success: true,
        code: 0,
        data: result,
      });
    } catch (err) {
      console.error(`[socket.${event}] error:`, err);
      callback(handleError(err));
    }
  };
}

function registerSocketEvent(socket: Socket, event: string, handler: (data: any) => Promise<any> | any) {
  socket.on(event, wrapSocketHandler(event, handler));
}

function getRedisJsonResp<T>(redisResp: string | null): T | null {
  if (!redisResp) {
    return null;
  }
  try {
    return JSON.parse(redisResp);
  } catch (e) {
    return null;
  }
}
