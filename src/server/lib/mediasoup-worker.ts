import { Inject, Provide } from 'bwcx-core';
import { createWorker } from 'mediasoup';
import type { AppData, Router } from 'mediasoup/node/lib/types';
import MediasoupConfig from '@server/configs/mediasoup/mediasoup.config';

@Provide()
export default class MediasoupWorker {
  public worker: Awaited<ReturnType<typeof createWorker>>;
  public routerMap: Map<string, Router<AppData>> = new Map();

  public constructor(
    @Inject()
    private readonly mediasoupConfig: MediasoupConfig,
  ) {}

  public async init() {
    try {
      this.worker = await createWorker({
        logLevel: 'warn',
        logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
        rtcMinPort: this.mediasoupConfig.rtcMinPort,
        rtcMaxPort: this.mediasoupConfig.rtcMaxPort,
      });
      console.log('Mediasoup worker created');
    } catch (error) {
      console.error('Failed to create mediasoup worker:', error);
      throw error;
    }
  }

  public async createRouter(routerId: string, appData?: AppData) {
    if (!this.worker) {
      throw new Error('Mediasoup worker not initialized');
    }
    try {
      const router = await this.worker.createRouter({
        mediaCodecs: this.mediasoupConfig.mediaCodecs,
        appData,
      });
      this.routerMap.set(routerId, router);
      return router;
    } catch (error) {
      console.error('Failed to create mediasoup router:', error);
      throw error;
    }
  }

  close() {
    try {
      for (const router of this.routerMap.values()) {
        router.close();
        this.routerMap.delete(router.id);
      }
      this.worker?.close();
    } catch (error) {
      console.error('Failed to close mediasoup worker:', error);
      throw error;
    }
  }
}
