import { Inject, Provide } from 'bwcx-core';
import { Namespace, Server, Socket } from 'socket.io';
import type http from 'http';
import type { DefaultEventsMap } from 'socket.io/dist/typed-events';
import LiveContestService, { BroadcasterStoreTracks } from '../live-contest/live-contest.service';
import LogicException from '@server/exceptions/logic.exception';
import { errCodeConfigs } from '@server/err-code-configs';
import { ErrCode } from '@common/enums/err-code.enum';
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

@Provide()
export default class SocketIOServer {
  private mediasoupRouter: Router<AppData>;
  private mediaRooms: Map<string, MediaRoom> = new Map();

  public constructor(
    @Inject() private readonly liveContestService: LiveContestService,
    @Inject() private readonly mediasoupWorker: MediasoupWorker,
  ) {
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
      const uca = socket.handshake.headers['x-uca']?.toString() || socket.handshake.query.uca?.toString() || '';
      const userId =
        socket.handshake.headers['x-user-id']?.toString() || socket.handshake.query.userId?.toString() || '';
      if (!uca || !userId) {
        return next(getGuardErrorObject(new LogicException(ErrCode.IllegalParameters)));
      }
      const { id, broadcasterToken, directorToken } = socket.handshake.auth;
      try {
        if ((broadcasterToken && directorToken) || (!broadcasterToken && !directorToken)) {
          return next(getGuardErrorObject(new LogicException(ErrCode.IllegalParameters)));
        }
        const contestMember = await this.liveContestService.findContestMemberById(uca, userId);
        if (!contestMember) {
          return next(getGuardErrorObject(new LogicException(ErrCode.LiveContestMemberNotFound)));
        }
        if (broadcasterToken && broadcasterToken !== contestMember.broadcasterToken) {
          return next(getGuardErrorObject(new LogicException(ErrCode.InvalidAuthInfo)));
        }
        // TODO use contest-specific token instead of global auth token
        if (directorToken && directorToken !== process.env.AUTH_TOKEN) {
          return next(getGuardErrorObject(new LogicException(ErrCode.InvalidAuthInfo)));
        }

        next();
      } catch (e) {
        console.error(`[socket.authGuard] broadcaster guard failed: ${id} (${uca}, ${userId})`, e);
        next(getGuardErrorObject(e));
      }
    });

    this.broadcasterNsp.on('connection', (socket) => {
      const uca = socket.handshake.headers['x-uca']?.toString() || socket.handshake.query.uca?.toString() || '';
      const userId =
        socket.handshake.headers['x-user-id']?.toString() || socket.handshake.query.userId?.toString() || '';
      const { id } = socket.handshake.auth;
      const role = socket.handshake.auth.broadcasterToken
        ? 'broadcaster'
        : socket.handshake.auth.directorToken
        ? 'director'
        : null;
      console.log(`[socket.connection] [${uca}:${userId}]`, id, role);
      if (role === 'broadcaster') {
        // TODO 踢出其他 broadcaster
      }
      if (role === 'director') {
        socket.join(this.getViewerRoomKey(uca, userId));
      }

      socket.on('disconnect', async (reason) => {
        console.log(`[socket.disconnect] [${uca}:${userId}]:`, id, role, reason);
        // 粗暴但有效的做法，一旦推流方断连就清空所有，下次需要重新走一套流程
        if (role === 'broadcaster') {
          await this.clearRoomAndAllData(uca, userId);
          this.broadcasterNsp.to(this.getViewerRoomKey(uca, userId)).emit('roomDestroyed');
        }
        if (role === 'director') {
          const mediaRoom = this.mediaRooms.get(this.getMediaRoomKey(uca, userId));
          const peer = mediaRoom?.peers.get(id);
          peer?.transport.close();
          mediaRoom?.peers.delete(id);
          mediaRoom?.viewers.delete(id);
        }
      });

      /**
       * getContestInfo: 获取比赛信息
       * @role broadcaster | director
       */
      registerSocketEvent(socket, 'getContestInfo', async () => {
        const contestInfo = await this.liveContestService.findContestByAlias(uca);
        if (!contestInfo) {
          throw new LogicException(ErrCode.LiveContestNotFound);
        }
        const contestMember = await this.liveContestService.findContestMemberById(uca, userId);
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
       * @role broadcaster
       */
      registerSocketEvent(socket, 'confirmReady', async (data: { tracks: BroadcasterStoreTracks }) => {
        if (role !== 'broadcaster') {
          throw new LogicException(ErrCode.IllegalRequest);
        }

        console.log(`[socket.confirmReady] [${uca}:${userId}:${id}] data:`, data);
        socket.join(this.getBroadcasterRoomKey(uca, userId));

        await this.liveContestService.setBroadcasterStoreInfo(uca, userId, {
          status: 'ready',
          tracks: data.tracks.map((track) => ({
            trackId: track.trackId,
            type: track.type,
          })),
          broadcastingTrackIds: [],
        });
        await this.liveContestService.setBroadcasterStoreTracks(uca, userId, data.tracks);

        const transport = await this.mediasoupRouter.createWebRtcTransport({
          listenIps: [{ ip: '0.0.0.0', announcedIp: process.env.PUBLIC_IP || '127.0.0.1' }],
          enableUdp: true,
          enableTcp: true,
        });
        const room = this.createMediaRoom();
        const roomKey = this.getMediaRoomKey(uca, userId);
        const broadcasterPeer: MediaRoomPeer = {
          transport,
          trackProducers: new Map(),
        };
        room.peers.set(id, broadcasterPeer);
        room.broadcaster = broadcasterPeer; // alias to peers[id]
        this.mediaRooms.set(roomKey, room);
        console.log(`[socket.confirmReady] [${uca}:${userId}:${id}] created media room: ${roomKey}`);
        console.log(`[socket.confirmReady] [${uca}:${userId}:${id}] joined broadcaster: ${id}`);

        return {
          transport: {
            id: broadcasterPeer.transport.id,
            iceParameters: broadcasterPeer.transport.iceParameters,
            iceCandidates: broadcasterPeer.transport.iceCandidates,
            dtlsParameters: broadcasterPeer.transport.dtlsParameters,
          },
          routerRtpCapabilities: this.mediasoupRouter.rtpCapabilities,
        };
      });

      /**
       * cancelReady: 取消准备就绪
       * @role broadcaster
       */
      registerSocketEvent(socket, 'cancelReady', async () => {
        if (role !== 'broadcaster') {
          throw new LogicException(ErrCode.IllegalRequest);
        }

        console.log(`[socket.cancelReady] [${uca}:${userId}:${id}]`);
        socket.leave(this.getBroadcasterRoomKey(uca, userId));
        await this.clearRoomAndAllData(uca, userId);
        this.broadcasterNsp.to(this.getViewerRoomKey(uca, userId)).emit('roomDestroyed');
      });

      /**
       * completeConnectTransport: 完成连接 transport
       * @role broadcaster | director
       */
      registerSocketEvent(socket, 'completeConnectTransport', async (data: { dtlsParameters: DtlsParameters }) => {
        console.log(`[socket.completeConnectTransport] [${uca}:${userId}:${id}:${role}] data:`, data);
        const mediaRoom = this.mediaRooms.get(this.getMediaRoomKey(uca, userId));
        if (!mediaRoom) {
          throw new LogicException(ErrCode.BroadcastMediaRoomBroken);
        }
        const peer = mediaRoom.peers.get(id);
        if (!peer) {
          throw new LogicException(ErrCode.BroadcastMediaRoomPeerMissing);
        }
        await peer.transport.connect({
          dtlsParameters: data.dtlsParameters,
        });
        console.log(
          `[socket.completeConnectTransport] [${uca}:${userId}:${id}:${role}] connected to transport:`,
          peer.transport.id,
        );
      });

      /**
       * produce: 频流
       * @role broadcaster
       */
      registerSocketEvent(
        socket,
        'produce',
        async (data: { trackId: string; kind: MediaKind; rtpParameters: RtpParameters }) => {
          if (role !== 'broadcaster') {
            throw new LogicException(ErrCode.IllegalRequest);
          }

          console.log(`[socket.produce] [${uca}:${userId}:${id}] data:`, data);
          const mediaRoom = this.mediaRooms.get(this.getMediaRoomKey(uca, userId));
          if (!mediaRoom) {
            throw new LogicException(ErrCode.BroadcastMediaRoomBroken);
          }
          const peer = mediaRoom.peers.get(id);
          if (!peer) {
            throw new LogicException(ErrCode.BroadcastMediaRoomPeerMissing);
          }
          const producer = await peer.transport.produce({
            kind: data.kind,
            rtpParameters: data.rtpParameters,
            appData: {
              id,
              uca,
              userId,
              trackId: data.trackId,
            },
          });
          console.log(`[socket.produce] [${uca}:${userId}:${id}] produced track:`, producer.id);
          peer.trackProducers?.set(data.trackId, producer);
          const info = await this.liveContestService.getBroadcasterStoreInfo(uca, userId);
          if (info) {
            info.status = 'broadcasting';
            if (!info.broadcastingTrackIds.includes(data.trackId)) {
              info.broadcastingTrackIds.push(data.trackId);
            }
            await this.liveContestService.setBroadcasterStoreInfo(uca, userId, info);
          }

          return {
            producerId: producer.id,
            type: producer.type,
            appData: producer.appData,
          };
        },
      );

      /**
       * joinBroadcastRoom: 加入推流房间
       * @role director
       */
      registerSocketEvent(socket, 'joinBroadcastRoom', async () => {
        if (role !== 'director') {
          throw new LogicException(ErrCode.IllegalRequest);
        }

        const mediaRoom = this.mediaRooms.get(this.getMediaRoomKey(uca, userId));
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
        mediaRoom.peers.set(id, viewerPeer);
        mediaRoom.viewers.set(id, viewerPeer); // alias to peers[id]
        console.log(`[socket.joinBroadcastRoom] [${uca}:${userId}:${id}] joined viewer:`, id);

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

      /**
       * startBroadcast: 请求开始推流
       * @role director
       */
      registerSocketEvent(socket, 'startBroadcast', async (data: { trackIds: string[] }) => {
        if (role !== 'director') {
          throw new LogicException(ErrCode.IllegalRequest);
        }

        console.log(`[socket.startBroadcast] [${uca}:${userId}:${id}] data:`, data);
        const info = await this.liveContestService.getBroadcasterStoreInfo(uca, userId);
        if (!info || !['ready', 'broadcasting'].includes(info.status)) {
          throw new LogicException(ErrCode.BroadcastNotReady);
        }
        const tracks = await this.liveContestService.getBroadcasterStoreTracks(uca, userId);
        if (!tracks || tracks.length === 0) {
          throw new LogicException(ErrCode.BroadcastNotReady);
        }
        // 找到 room 里的 broadcaster，并由服务端向 broadcaster 请求开始推流
        const mediaRoom = this.mediaRooms.get(this.getMediaRoomKey(uca, userId));
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
        console.log(`[socket.startBroadcast] [${uca}:${userId}:${id}] checking available tracks:`, availableTracks);
        if (availableTracks.length > 0) {
          console.log(
            `[socket.emit.requestStartBroadcast] [${uca}:${userId}:${id}] requesting start broadcast to broadcaster`,
          );
          this.broadcasterNsp.to(this.getBroadcasterRoomKey(uca, userId)).emit('requestStartBroadcast', {
            trackIds: availableTracks,
          });
        }
      });

      /**
       * consume: 消费流
       * @role director
       */
      registerSocketEvent(
        socket,
        'consume',
        async (data: {
          trackId: string;
          rtpCapabilities: RtpCapabilities;
          paused?: boolean;
          preferredLayers?: ConsumerLayers;
        }) => {
          if (role !== 'director') {
            throw new LogicException(ErrCode.IllegalRequest);
          }

          console.log(`[socket.consume] [${uca}:${userId}:${id}] data:`, data);
          const mediaRoom = this.mediaRooms.get(this.getMediaRoomKey(uca, userId));
          if (!mediaRoom) {
            throw new LogicException(ErrCode.BroadcastMediaRoomBroken);
          }
          const peer = mediaRoom.peers.get(id);
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
              id,
              uca,
              userId,
              trackId: data.trackId,
            },
          });
          console.log(`[socket.consume] [${uca}:${userId}:${id}] consumed track:`, consumer.id);

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

      /**
       * stopBroadcast: 请求停止推流
       * @role director
       */
      registerSocketEvent(socket, 'stopBroadcast', async (data: { trackIds: string[] }) => {
        if (role !== 'director') {
          throw new LogicException(ErrCode.IllegalRequest);
        }

        console.log(`[socket.stopBroadcast] [${uca}:${userId}:${id}] data:`, data);
        const mediaRoom = this.mediaRooms.get(this.getMediaRoomKey(uca, userId));
        if (!mediaRoom) {
          throw new LogicException(ErrCode.BroadcastMediaRoomBroken);
        }
        this.broadcasterNsp.to(this.getBroadcasterRoomKey(uca, userId)).emit(
          'requestStopBroadcast',
          {
            trackIds: data.trackIds,
          },
          async () => {
            console.log(
              `[socket.emit.requestStopBroadcast] [${uca}:${userId}:${id}] received broadcaster ack, cleaning up producers:`,
              data.trackIds,
            );
            // 仅清理 producers 相关，不关闭 transport
            const info = await this.liveContestService.getBroadcasterStoreInfo(uca, userId);
            if (info) {
              const nextBroadcastingTrackIds = info.broadcastingTrackIds.filter(
                (trackId) => !data.trackIds.includes(trackId),
              );
              info.status = nextBroadcastingTrackIds.length > 0 ? 'broadcasting' : 'ready';
              info.broadcastingTrackIds = nextBroadcastingTrackIds;
              await this.liveContestService.setBroadcasterStoreInfo(uca, userId, info);
            }
            mediaRoom.broadcaster?.trackProducers?.forEach((producer, trackId) => {
              if (data.trackIds.includes(trackId)) {
                producer.close();
                mediaRoom.broadcaster?.trackProducers?.delete(trackId);
              }
            });
            // this.viewerNsp.to(this.getViewerRoomKey(uca, userId)).emit('broadcastStopped');
          },
        );
      });
    });
  }

  private getBroadcasterRoomKey(uca: string, userId: string) {
    return `broadcaster:${uca}:${userId}`;
  }

  private getViewerRoomKey(uca: string, userId: string) {
    return `viewer:${uca}:${userId}`;
  }

  private getMediaRoomKey(uca: string, userId: string, trackId?: string) {
    return trackId ? `${uca}:${userId}:${trackId}` : `${uca}:${userId}`;
  }

  private createMediaRoom() {
    const room: MediaRoom = {
      peers: new Map<string, MediaRoomPeer>(),
      broadcaster: null,
      viewers: new Map<string, MediaRoomPeer>(),
    };
    return room;
  }

  private async clearRoomAndAllData(uca: string, userId: string) {
    await Promise.all([
      this.liveContestService.delBroadcasterStoreInfo(uca, userId),
      this.liveContestService.delBroadcasterStoreTracks(uca, userId),
    ]);

    const room = this.mediaRooms.get(this.getMediaRoomKey(uca, userId));
    if (room) {
      room.broadcaster?.trackProducers?.forEach((producer) => {
        producer.close();
      });
      room.peers.forEach((peer) => {
        peer.transport.close();
      });
      room.peers.clear();
      this.mediaRooms.delete(this.getMediaRoomKey(uca, userId));
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
