/* eslint-disable @typescript-eslint/no-require-imports */

const isProd = process.env.NODE_ENV === 'production';
const moduleAlias = require('module-alias');

moduleAlias.addAlias('@server', __dirname);
moduleAlias.addAlias('@common', require('path').join(__dirname, '../common'));

import { getDependency } from 'bwcx-core';
import type { IAppConfig } from 'bwcx-ljsm';
import { App } from 'bwcx-ljsm';
import http from 'http';
import path from 'path';
import cors from '@koa/cors';
import UtilityHeaderMiddleware from './middlewares/utility-header.middleware';
import LoggerMiddleware from './middlewares/logger.middleware';
import DefaultResponseHandler from '@server/response-handlers/default.response-handler';
import RedisClient from './lib/redis-client';
import SocketIOServer from './modules/socket-io/socket-io';
import MediasoupWorker from './lib/mediasoup-worker';

export default class OurApp extends App {
  protected baseDir = path.join(__dirname, '..');

  protected scanGlobs = [
    './server/**/*.(j|t)s',
    '!./server/**/*.d.ts',
    './common/**/*.(j|t)s',
    '!./common/**/*.d.ts',
    '!./common/api/**',
  ];

  public hostname = process.env.SERVER_HOST || '127.0.0.1';

  public port = parseInt(process.env.SERVER_PORT, 10) || 3001;

  protected exitTimeout = 5000;

  protected globalMiddlewares = [UtilityHeaderMiddleware, LoggerMiddleware];

  protected responseHandler = DefaultResponseHandler;

  protected validation: IAppConfig['validation'] = isProd
    ? {
        skipRespValidation: true,
      }
    : {};

  protected bodyParserOptions: IAppConfig['bodyParserOptions'] = {
    formLimit: '5mb',
    jsonLimit: '5mb',
  };

  protected multerOptions: IAppConfig['multerOptions'] = {
    limits: {
      fileSize: 8 * 1024 * 1024,
    },
  };

  public constructor() {
    super();
  }

  protected async beforeWire() {
    // cors
    this.instance.use(cors());
  }

  protected async afterWire() {
    this.instance.on('error', (error, ctx) => {
      try {
        console.error('Server error:', error, ctx);
      } catch (e) {
        console.error(e);
      }
    });

    const redisClient = getDependency<RedisClient>(RedisClient, this.container);
    await redisClient.init();
    const mediasoupWorker = getDependency<MediasoupWorker>(MediasoupWorker, this.container);
    await mediasoupWorker.init();
    await mediasoupWorker.createRouter('default');
  }

  protected async afterStart() {
    console.log(`🚀 A bwcx app is listening on http://${this.hostname || '0.0.0.0'}:${this.port}`);
  }

  public async beforeExit() {
    const redisClient = getDependency<RedisClient>(RedisClient, this.container);
    await redisClient.close();
    const mediasoupWorker = getDependency<MediasoupWorker>(MediasoupWorker, this.container);
    mediasoupWorker.close();
    console.log('Cleaned up before exit');
  }
}

const app = new OurApp();
app.scan();
app
  .bootstrap()
  .then(async () => {
    const socketIOServer = getDependency<SocketIOServer>(SocketIOServer, app.container);
    await app.startManually(async () => {
      const httpServer = http.createServer(app.instance.callback());
      socketIOServer.init(httpServer);
      const listenPromise = new Promise((resolve, _reject) => {
        httpServer.listen(app.port, app.hostname, () => {
          resolve(true);
        });
      });
      await listenPromise;
    });
  })
  .catch((err) => {
    console.error('Failed to start the server:', err);
    app.beforeExit().finally(() => {
      process.exit(1);
    });
  });
