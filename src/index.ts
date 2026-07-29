if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = '16';
}

import { createApp } from './app';
import { logger } from './utils/logger';

const PORT = parseInt(process.env.PORT || '3000', 10);
const app = createApp();

const server = app.listen(PORT, process.env.HOST || '0.0.0.0', () => {
  logger.info(`ct-review-bot service listening on port ${PORT}`, {
    port: PORT,
    nodeEnv: process.env.NODE_ENV || 'development'
  });
});

function gracefulShutdown(signal: string) {
  logger.info(`Received ${signal}. Initiating graceful shutdown...`);
  server.close(() => {
    logger.info('HTTP server closed. Exiting process.');
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('Forced shutdown: HTTP server failed to close in time.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason: unknown) => {
  logger.error('Unhandled Promise Rejection', { error: reason instanceof Error ? reason.message : String(reason) });
});

process.on('uncaughtException', (err: Error) => {
  logger.error('Uncaught Exception', { error: err.message, stack: err.stack });
  gracefulShutdown('uncaughtException');
});

export { app, server, createApp };
