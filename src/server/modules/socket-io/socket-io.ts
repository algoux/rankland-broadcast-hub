import { Inject, Provide } from 'bwcx-core';
import { Namespace, Server, Socket } from 'socket.io';
import type http from 'http';
import type { DefaultEventsMap } from 'socket.io/dist/typed-events';
import LiveContestService, { BroadcasterStoreTracks, ShotStoreTracks } from '../live-contest/live-contest.service';
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

interface BroadcasterMediaRoom {
  peers: Map<string, MediaRoomPeer>;
  broadcaster: MediaRoomPeer | null; // 指向 peer 中的 broadcaster
  viewers: Map<string, MediaRoomPeer>;
}

interface ShotMediaRoom {
  peers: Map<string, MediaRoomPeer>;
  shots: Map<string, MediaRoomPeer>;
  viewers: Map<string, MediaRoomPeer>;
}

interface MediaRoomPeer {
  transport: WebRtcTransport;
  /**
   * 此 peer 推流轨道的所有 producer 实例
   *
   * 仅 broadcaster/shot 存在此属性
   */
  trackProducers?: Map</** trackId */ string, Producer>;
}

@Provide()
export default class SocketIOServer {
  private mediasoupRouter: Router<AppData>;
  private broadcasterMediaRooms: Map<string, BroadcasterMediaRoom> = new Map();
  private shotMediaRooms: Map<string, ShotMediaRoom> = new Map();

  public constructor(
    @Inject() private readonly liveContestService: LiveContestService,
    @Inject() private readonly mediasoupWorker: MediasoupWorker,
  ) {
    this.mediasoupRouter = this.mediasoupWorker.routerMap.get('default');
  }

  public io: Server;
  public rootNsp: Namespace<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, any>;
  public broadcasterNsp: Namespace<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, any>;
  // public viewerNsp: Namespace<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, any>;
  public shotNsp: Namespace<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, any>;

  public init(server: http.Server) {
    this.io = new Server(server, {
      // path: '/rankland_broadcast_hub/socket.io',
    });
    this.mount();
  }

  public mount() {
    this.rootMount();
    this.broadcasterMount();
    this.shotMount();
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
        console.log('[socket] [/broadcaster] [authGuard] all fields are missing');
        return next(getGuardErrorObject(new LogicException(ErrCode.IllegalParameters)));
      }
      const { id, broadcasterToken, directorToken } = socket.handshake.auth;
      try {
        if ((broadcasterToken && directorToken) || (!broadcasterToken && !directorToken)) {
          console.log('[socket] [/broadcaster] [authGuard] conflict token or missing token');
          return next(getGuardErrorObject(new LogicException(ErrCode.IllegalParameters)));
        }
        const contestMember = await this.liveContestService.findContestMemberById(uca, userId);
        if (!contestMember) {
          return next(getGuardErrorObject(new LogicException(ErrCode.LiveContestMemberNotFound)));
        }
        if (broadcasterToken && broadcasterToken !== contestMember.broadcasterToken) {
          console.log('[socket] [/broadcaster] [authGuard] invalid broadcaster token');
          return next(getGuardErrorObject(new LogicException(ErrCode.InvalidAuthInfo)));
        }
        // TODO use contest-specific token instead of global auth token
        if (directorToken && directorToken !== process.env.AUTH_TOKEN) {
          console.log('[socket] [/broadcaster] [authGuard] invalid director token');
          return next(getGuardErrorObject(new LogicException(ErrCode.InvalidAuthInfo)));
        }

        next();
      } catch (e) {
        console.error(`[socket] [/broadcaster] [authGuard] guard failed: ${id} (${uca}, ${userId})`, e);
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
      console.log(`[socket] [/broadcaster] [connection] [${uca}:${userId}]`, id, role);
      if (role === 'broadcaster') {
        // TODO 踢出其他 broadcaster
      }
      if (role === 'director') {
        socket.join(this.getViewerLogicRoomKey(uca, userId));
      }

      socket.on('disconnect', async (reason) => {
        console.log(`[socket] [/broadcaster] [disconnect] [${uca}:${userId}]:`, id, role, reason);
        // 粗暴但有效的做法，一旦推流方断连就清空所有，下次需要重新走一套流程
        if (role === 'broadcaster') {
          await this.clearBroadcasterRoomAndAllData(uca, userId);
          this.broadcasterNsp.to(this.getViewerLogicRoomKey(uca, userId)).emit('roomDestroyed');
        }
        if (role === 'director') {
          const mediaRoom = this.broadcasterMediaRooms.get(this.getBroadcasterMediaRoomKey(uca, userId));
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

        console.log(`[socket] [/broadcaster] [confirmReady] [${uca}:${userId}:${id}] data:`, data);
        socket.join(this.getBroadcasterLogicRoomKey(uca, userId));

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
        const room: BroadcasterMediaRoom = {
          peers: new Map<string, MediaRoomPeer>(),
          broadcaster: null,
          viewers: new Map<string, MediaRoomPeer>(),
        };
        const roomKey = this.getBroadcasterMediaRoomKey(uca, userId);
        const broadcasterPeer: MediaRoomPeer = {
          transport,
          trackProducers: new Map(),
        };
        room.peers.set(id, broadcasterPeer);
        room.broadcaster = broadcasterPeer; // alias to peers[id]
        this.broadcasterMediaRooms.set(roomKey, room);
        console.log(`[socket] [/broadcaster] [confirmReady] [${uca}:${userId}:${id}] created media room: ${roomKey}`);
        console.log(`[socket] [/broadcaster] [confirmReady] [${uca}:${userId}:${id}] joined broadcaster: ${id}`);

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

        console.log(`[socket] [/broadcaster] [cancelReady] [${uca}:${userId}:${id}]`);
        socket.leave(this.getBroadcasterLogicRoomKey(uca, userId));
        await this.clearBroadcasterRoomAndAllData(uca, userId);
        this.broadcasterNsp.to(this.getViewerLogicRoomKey(uca, userId)).emit('roomDestroyed');
      });

      /**
       * completeConnectTransport: 完成连接 transport
       * @role broadcaster | director
       */
      registerSocketEvent(socket, 'completeConnectTransport', async (data: { dtlsParameters: DtlsParameters }) => {
        console.log(`[socket] [/broadcaster] [completeConnectTransport] [${uca}:${userId}:${id}:${role}] data:`, data);
        const mediaRoom = this.broadcasterMediaRooms.get(this.getBroadcasterMediaRoomKey(uca, userId));
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
          `[socket] [/broadcaster] [completeConnectTransport] [${uca}:${userId}:${id}:${role}] connected to transport:`,
          peer.transport.id,
        );
      });

      /**
       * produce: 推流
       * @role broadcaster
       */
      registerSocketEvent(
        socket,
        'produce',
        async (data: { trackId: string; kind: MediaKind; rtpParameters: RtpParameters }) => {
          if (role !== 'broadcaster') {
            throw new LogicException(ErrCode.IllegalRequest);
          }

          console.log(`[socket] [/broadcaster] [produce] [${uca}:${userId}:${id}] data:`, data);
          const mediaRoom = this.broadcasterMediaRooms.get(this.getBroadcasterMediaRoomKey(uca, userId));
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
          console.log(`[socket] [/broadcaster] [produce] [${uca}:${userId}:${id}] produced track:`, producer.id);
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

        const mediaRoom = this.broadcasterMediaRooms.get(this.getBroadcasterMediaRoomKey(uca, userId));
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
        console.log(`[socket] [/broadcaster] [joinBroadcastRoom] [${uca}:${userId}:${id}] joined viewer:`, id);

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

        console.log(`[socket] [/broadcaster] [startBroadcast] [${uca}:${userId}:${id}] data:`, data);
        const info = await this.liveContestService.getBroadcasterStoreInfo(uca, userId);
        if (!info || !['ready', 'broadcasting'].includes(info.status)) {
          throw new LogicException(ErrCode.BroadcastNotReady);
        }
        const tracks = await this.liveContestService.getBroadcasterStoreTracks(uca, userId);
        if (!tracks || tracks.length === 0) {
          throw new LogicException(ErrCode.BroadcastNotReady);
        }
        // 找到 room 里的 broadcaster，并由服务端向 broadcaster 请求开始推流
        const mediaRoom = this.broadcasterMediaRooms.get(this.getBroadcasterMediaRoomKey(uca, userId));
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
        console.log(
          `[socket] [/broadcaster] [startBroadcast] [${uca}:${userId}:${id}] checking available tracks:`,
          availableTracks,
        );
        if (availableTracks.length > 0) {
          console.log(
            `[socket] [/broadcaster] [emit.requestStartBroadcast] [${uca}:${userId}:${id}] requesting start broadcast to broadcaster`,
          );
          this.broadcasterNsp.to(this.getBroadcasterLogicRoomKey(uca, userId)).emit('requestStartBroadcast', {
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

          console.log(`[socket] [/broadcaster] [consume] [${uca}:${userId}:${id}] data:`, data);
          const mediaRoom = this.broadcasterMediaRooms.get(this.getBroadcasterMediaRoomKey(uca, userId));
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
          console.log(`[socket] [/broadcaster] [consume] [${uca}:${userId}:${id}] consumed track:`, consumer.id);

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

        console.log(`[socket] [/broadcaster] [stopBroadcast] [${uca}:${userId}:${id}] data:`, data);
        const mediaRoom = this.broadcasterMediaRooms.get(this.getBroadcasterMediaRoomKey(uca, userId));
        if (!mediaRoom) {
          throw new LogicException(ErrCode.BroadcastMediaRoomBroken);
        }
        this.broadcasterNsp.to(this.getBroadcasterLogicRoomKey(uca, userId)).emit(
          'requestStopBroadcast',
          {
            trackIds: data.trackIds,
          },
          async () => {
            console.log(
              `[socket] [/broadcaster] [emit.requestStopBroadcast] [${uca}:${userId}:${id}] received broadcaster ack, cleaning up producers:`,
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
            // this.viewerNsp.to(this.getViewerLogicRoomKey(uca, userId)).emit('broadcastStopped');
          },
        );
      });
    });
  }

  public shotMount() {
    this.shotNsp = this.io.of('/shot');
    this.shotNsp.use(async (socket, next) => {
      const uca = socket.handshake.headers['x-uca']?.toString() || socket.handshake.query.uca?.toString() || '';
      if (!uca) {
        console.log('[socket] [/shot] [authGuard] all fields are missing');
        return next(getGuardErrorObject(new LogicException(ErrCode.IllegalParameters)));
      }
      const { id, shotToken, directorToken } = socket.handshake.auth;
      try {
        if ((shotToken && directorToken) || (!shotToken && !directorToken)) {
          console.log('[socket] [/shot] [authGuard] conflict token or missing token');
          return next(getGuardErrorObject(new LogicException(ErrCode.IllegalParameters)));
        }
        const contestInfo = await this.liveContestService.findContestByAlias(uca);
        if (!contestInfo) {
          return next(getGuardErrorObject(new LogicException(ErrCode.LiveContestNotFound)));
        }
        // TODO use contest-specific token instead of global auth token
        if (shotToken && shotToken !== process.env.AUTH_TOKEN) {
          console.log('[socket] [/shot] [authGuard] invalid shot token');
          return next(getGuardErrorObject(new LogicException(ErrCode.InvalidAuthInfo)));
        }
        // TODO use contest-specific token instead of global auth token
        if (directorToken && directorToken !== process.env.AUTH_TOKEN) {
          console.log('[socket] [/shot] [authGuard] invalid director token');
          return next(getGuardErrorObject(new LogicException(ErrCode.InvalidAuthInfo)));
        }

        next();
      } catch (e) {
        console.error(`[socket] [/shot] [authGuard] guard failed: ${id} (${uca})`, e);
        next(getGuardErrorObject(e));
      }
    });

    this.shotNsp.on('connection', (socket) => {
      const uca = socket.handshake.headers['x-uca']?.toString() || socket.handshake.query.uca?.toString() || '';
      const { id } = socket.handshake.auth;
      const role = socket.handshake.auth.shotToken ? 'shot' : socket.handshake.auth.directorToken ? 'director' : null;
      console.log(`[socket] [/shot] [connection] [${uca}]`, id, role);

      const mediaRoomKey = this.getShotMediaRoomKey(uca);
      if (!this.shotMediaRooms.has(mediaRoomKey)) {
        const room: ShotMediaRoom = {
          peers: new Map<string, MediaRoomPeer>(),
          shots: new Map<string, MediaRoomPeer>(),
          viewers: new Map<string, MediaRoomPeer>(),
        };
        this.shotMediaRooms.set(mediaRoomKey, room);
        console.log(`[socket] [/shot] [connection] [${uca}] created media room: ${mediaRoomKey}`);
      }
      const mediaRoom = this.shotMediaRooms.get(mediaRoomKey);

      // if (role === 'shot') {
      // }
      if (role === 'director') {
        socket.join(this.getViewerLogicRoomKey(uca));
      }

      socket.on('disconnect', async (reason) => {
        console.log(`[socket] [/shot] [disconnect] [${uca}]:`, id, role, reason);
        if (role === 'shot') {
          this.clearSingleShotInRoom(uca, id);
          this.shotNsp.to(this.getViewerLogicRoomKey(uca)).emit('shotGone', { shotId: id });
        }
        if (role === 'director') {
          const peer = mediaRoom?.peers.get(id);
          peer?.transport.close();
          mediaRoom?.peers.delete(id);
          mediaRoom?.viewers.delete(id);
        }
      });

      /**
       * getContestInfo: 获取比赛信息
       * @role shot | director
       */
      registerSocketEvent(socket, 'getContestInfo', async () => {
        const contestInfo = await this.liveContestService.findContestByAlias(uca);
        if (!contestInfo) {
          throw new LogicException(ErrCode.LiveContestNotFound);
        }

        return {
          alias: contestInfo.alias,
          contest: contestInfo.contest,
          serverTimestamp: Date.now(),
        };
      });

      /**
       * confirmReady: 确认准备就绪，服务端创建 media room 并创建 transport
       * @role shot
       */
      registerSocketEvent(socket, 'confirmReady', async (data: { shotId: string; shotName: string; tracks: ShotStoreTracks }) => {
        if (role !== 'shot') {
          throw new LogicException(ErrCode.IllegalRequest);
        }

        console.log(`[socket] [/shot] [confirmReady] [${uca}:${id}] data:`, data);
        socket.join(this.getShotLogicRoomKey(uca, id));

        this.liveContestService.setShotStore(uca, id, {
          shotName: data.shotName,
          status: 'ready',
          tracks: data.tracks,
          broadcastingTrackIds: [],
        });

        const transport = await this.mediasoupRouter.createWebRtcTransport({
          listenIps: [{ ip: '0.0.0.0', announcedIp: process.env.PUBLIC_IP || '127.0.0.1' }],
          enableUdp: true,
          enableTcp: true,
        });
        const shotPeer: MediaRoomPeer = {
          transport,
          trackProducers: new Map(),
        };
        mediaRoom.peers.set(id, shotPeer);
        mediaRoom.shots.set(id, shotPeer);

        console.log(`[socket] [/shot] [confirmReady] [${uca}:${id}] joined shot: ${id}`);

        return {
          transport: {
            id: shotPeer.transport.id,
            iceParameters: shotPeer.transport.iceParameters,
            iceCandidates: shotPeer.transport.iceCandidates,
            dtlsParameters: shotPeer.transport.dtlsParameters,
          },
          routerRtpCapabilities: this.mediasoupRouter.rtpCapabilities,
        };
      });

      /**
       * cancelReady: 取消准备就绪
       * @role shot
       */
      registerSocketEvent(socket, 'cancelReady', async () => {
        if (role !== 'shot') {
          throw new LogicException(ErrCode.IllegalRequest);
        }

        console.log(`[socket] [/shot] [cancelReady] [${uca}:${id}]`);
        socket.leave(this.getShotLogicRoomKey(uca, id));
        this.clearSingleShotInRoom(uca, id);
        this.shotNsp.to(this.getViewerLogicRoomKey(uca)).emit('shotGone', { shotId: id });
      });

      /**
       * completeConnectTransport: 完成连接 transport
       * @role shot | director
       */
      registerSocketEvent(socket, 'completeConnectTransport', async (data: { dtlsParameters: DtlsParameters }) => {
        console.log(`[socket] [/shot] [completeConnectTransport] [${uca}:${id}:${role}] data:`, data);
        const peer = mediaRoom.peers.get(id);
        if (!peer) {
          throw new LogicException(ErrCode.BroadcastMediaRoomPeerMissing);
        }
        await peer.transport.connect({
          dtlsParameters: data.dtlsParameters,
        });
        console.log(
          `[socket] [/shot] [completeConnectTransport] [${uca}:${id}:${role}] connected to transport:`,
          peer.transport.id,
        );
      });

      /**
       * produce: 推流
       * @role shot
       */
      registerSocketEvent(
        socket,
        'produce',
        async (data: { trackId: string; kind: MediaKind; rtpParameters: RtpParameters }) => {
          if (role !== 'shot') {
            throw new LogicException(ErrCode.IllegalRequest);
          }

          console.log(`[socket] [/shot] [produce] [${uca}:${id}] data:`, data);
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
              trackId: data.trackId,
            },
          });
          console.log(`[socket] [/shot] [produce] [${uca}:${id}] produced track:`, producer.id);
          peer.trackProducers?.set(data.trackId, producer);
          const info = this.liveContestService.getShotStore(uca)?.get(id);
          if (info) {
            info.status = 'broadcasting';
            if (!info.broadcastingTrackIds.includes(data.trackId)) {
              info.broadcastingTrackIds.push(data.trackId);
            }
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
        console.log(`[socket] [/shot] [joinBroadcastRoom] [${uca}:${id}] joined viewer:`, id);

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
      registerSocketEvent(socket, 'startBroadcast', async (data: { shotId: string; trackIds: string[] }) => {
        if (role !== 'director') {
          throw new LogicException(ErrCode.IllegalRequest);
        }

        console.log(`[socket] [/shot] [startBroadcast] [${uca}:${id}] data:`, data);
        const info = this.liveContestService.getShotStore(uca)?.get(data.shotId);
        if (!info || !['ready', 'broadcasting'].includes(info.status)) {
          throw new LogicException(ErrCode.BroadcastNotReady);
        }
        const tracks = info.tracks;
        if (!tracks || tracks.length === 0) {
          throw new LogicException(ErrCode.BroadcastNotReady);
        }
        // 找到 room 里的 shot，并由服务端向 shot 请求开始推流
        const shotPeer = mediaRoom.shots.get(data.shotId);
        if (!shotPeer) {
          throw new LogicException(ErrCode.BroadcastMediaRoomPeerMissing);
        }
        const availableTracks = data.trackIds.filter((trackId) => {
          return tracks.some((track: any) => track.trackId === trackId);
        });
        console.log(
          `[socket] [/shot] [startBroadcast] [${uca}:${id}] checking available tracks:`,
          availableTracks,
        );
        if (availableTracks.length > 0) {
          console.log(
            `[socket] [/shot] [emit.requestStartBroadcast] [${uca}:${id}] requesting start broadcast to shot`,
          );
          this.shotNsp.to(this.getShotLogicRoomKey(uca, data.shotId)).emit('requestStartBroadcast', {
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
          shotId: string;
          trackId: string;
          rtpCapabilities: RtpCapabilities;
          paused?: boolean;
          preferredLayers?: ConsumerLayers;
        }) => {
          if (role !== 'director') {
            throw new LogicException(ErrCode.IllegalRequest);
          }

          console.log(`[socket] [/shot] [consume] [${uca}:${id}] data:`, data);
          const peer = mediaRoom.peers.get(id);
          if (!peer) {
            throw new LogicException(ErrCode.BroadcastMediaRoomPeerMissing);
          }
          const shotPeer = mediaRoom.shots.get(data.shotId);
          if (!shotPeer) {
            throw new LogicException(ErrCode.BroadcastMediaRoomPeerMissing);
          }
          const producer = shotPeer.trackProducers?.get(data.trackId);
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
              shotId: data.shotId,
              trackId: data.trackId,
            },
          });
          console.log(`[socket] [/shot] [consume] [${uca}:${id}] consumed track:`, consumer.id);

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
      registerSocketEvent(socket, 'stopBroadcast', async (data: { shotId: string; trackIds: string[] }) => {
        if (role !== 'director') {
          throw new LogicException(ErrCode.IllegalRequest);
        }

        console.log(`[socket] [/shot] [stopBroadcast] [${uca}:${id}] data:`, data);
        this.shotNsp.to(this.getShotLogicRoomKey(uca, data.shotId)).emit(
          'requestStopBroadcast',
          {
            trackIds: data.trackIds,
          },
          async () => {
            console.log(
              `[socket] [/shot] [emit.requestStopBroadcast] [${uca}:${id}] received shot ack, cleaning up producers:`,
              data.trackIds,
            );
            // 仅清理 producers 相关，不关闭 transport
            const info = this.liveContestService.getShotStore(uca)?.get(data.shotId);
            if (info) {
              const nextBroadcastingTrackIds = info.broadcastingTrackIds.filter(
                (trackId) => !data.trackIds.includes(trackId),
              );
              info.status = nextBroadcastingTrackIds.length > 0 ? 'broadcasting' : 'ready';
              info.broadcastingTrackIds = nextBroadcastingTrackIds;
            }
            mediaRoom.shots.get(data.shotId)?.trackProducers?.forEach((producer, trackId) => {
              if (data.trackIds.includes(trackId)) {
                producer.close();
                mediaRoom.shots.get(data.shotId)?.trackProducers?.delete(trackId);
              }
            });
            // this.viewerNsp.to(this.getViewerLogicRoomKey(uca)).emit('shotGone', { shotId: data.shotId });
          },
        );
      });
    });
  }

  private getBroadcasterLogicRoomKey(uca: string, userId: string) {
    return `broadcaster:${uca}:${userId}`;
  }

  private getViewerLogicRoomKey(uca: string, userId?: string) {
    return userId ? `viewer:${uca}:${userId}` : `viewer:${uca}`;
  }

  private getShotLogicRoomKey(uca: string, shotId: string) {
    return `shot:${uca}:${shotId}`;
  }

  private getBroadcasterMediaRoomKey(uca: string, userId: string) {
    return `${uca}:${userId}`;
  }

  private getShotMediaRoomKey(uca: string) {
    return `${uca}`;
  }

  private async clearBroadcasterRoomAndAllData(uca: string, userId: string) {
    await Promise.all([
      this.liveContestService.delBroadcasterStoreInfo(uca, userId),
      this.liveContestService.delBroadcasterStoreTracks(uca, userId),
    ]);

    const room = this.broadcasterMediaRooms.get(this.getBroadcasterMediaRoomKey(uca, userId));
    if (room) {
      room.broadcaster?.trackProducers?.forEach((producer) => {
        producer.close();
      });
      room.peers.forEach((peer) => {
        peer.transport.close();
      });
      room.peers.clear();
      this.broadcasterMediaRooms.delete(this.getBroadcasterMediaRoomKey(uca, userId));
    }
  }

  private async clearSingleShotInRoom(uca: string, id: string) {
    const room = this.shotMediaRooms.get(this.getShotMediaRoomKey(uca));
    if (room) {
      const peer = room.peers.get(id);
      if (peer) {
        peer.trackProducers?.forEach((producer) => {
          producer.close();
        });
        peer.transport.close();
        room.shots.delete(id);
        room.peers.delete(id);
      }
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
      console.error(`[socket] [${event}] error:`, err);
      callback(handleError(err));
    }
  };
}

function registerSocketEvent(socket: Socket, event: string, handler: (data: any) => Promise<any> | any) {
  socket.on(event, wrapSocketHandler(event, handler));
}
