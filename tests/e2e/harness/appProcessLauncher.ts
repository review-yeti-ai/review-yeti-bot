import { Express } from 'express';
import { Server } from 'http';
import { createApp } from '../../../src/app';

export interface AppProcessOptions {
  port?: number;
  env?: Record<string, string>;
}

export interface RunningApp {
  app: Express;
  server: Server;
  url: string;
  port: number;
  stop: () => Promise<void>;
}

export class AppProcessLauncher {
  private runningServer: Server | null = null;
  private originalEnv: Record<string, string | undefined> = {};

  public async startApp(options: AppProcessOptions = {}): Promise<RunningApp> {
    const envOverrides = options.env || {};
    for (const key of Object.keys(envOverrides)) {
      this.originalEnv[key] = process.env[key];
      process.env[key] = envOverrides[key];
    }

    const app = createApp();
    const port = options.port !== undefined ? options.port : 0;

    return new Promise((resolve, reject) => {
      try {
        const server = app.listen(port, '127.0.0.1', () => {
          const address = server.address();
          const actualPort = typeof address === 'object' && address !== null ? address.port : port;
          this.runningServer = server;

          resolve({
            app,
            server,
            port: actualPort,
            url: `http://127.0.0.1:${actualPort}`,
            stop: async () => {
              await this.stopApp();
            },
          });
        });

        server.on('error', (err) => {
          this.restoreEnv();
          reject(err);
        });
      } catch (err) {
        this.restoreEnv();
        reject(err);
      }
    });
  }

  public async stopApp(): Promise<void> {
    if (this.runningServer) {
      await new Promise<void>((resolve) => {
        this.runningServer!.close(() => {
          this.runningServer = null;
          resolve();
        });
      });
    }
    this.restoreEnv();
  }

  private restoreEnv(): void {
    for (const key of Object.keys(this.originalEnv)) {
      if (this.originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = this.originalEnv[key];
      }
    }
    this.originalEnv = {};
  }
}
