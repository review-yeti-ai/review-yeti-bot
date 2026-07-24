"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTokenManager = exports.getProviderPool = exports.createApp = exports.server = exports.app = void 0;
const app_1 = require("./app");
Object.defineProperty(exports, "createApp", { enumerable: true, get: function () { return app_1.createApp; } });
Object.defineProperty(exports, "getProviderPool", { enumerable: true, get: function () { return app_1.getProviderPool; } });
Object.defineProperty(exports, "getTokenManager", { enumerable: true, get: function () { return app_1.getTokenManager; } });
const logger_1 = require("./utils/logger");
__exportStar(require("./router/tokenManager"), exports);
__exportStar(require("./router/omniRouteAdapter"), exports);
__exportStar(require("./router/providerPool"), exports);
const PORT = parseInt(process.env.PORT || '3000', 10);
const app = (0, app_1.createApp)();
exports.app = app;
const server = app.listen(PORT, process.env.HOST || '0.0.0.0', () => {
    logger_1.logger.info(`ct-review-bot service listening on port ${PORT}`, {
        port: PORT,
        nodeEnv: process.env.NODE_ENV || 'development'
    });
});
exports.server = server;
function gracefulShutdown(signal) {
    logger_1.logger.info(`Received ${signal}. Initiating graceful shutdown...`);
    server.close(() => {
        logger_1.logger.info('HTTP server closed. Exiting process.');
        process.exit(0);
    });
    setTimeout(() => {
        logger_1.logger.error('Forced shutdown: HTTP server failed to close in time.');
        process.exit(1);
    }, 10000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
    logger_1.logger.error('Unhandled Promise Rejection', { error: reason instanceof Error ? reason.message : String(reason) });
});
process.on('uncaughtException', (err) => {
    logger_1.logger.error('Uncaught Exception', { error: err.message, stack: err.stack });
    gracefulShutdown('uncaughtException');
});
//# sourceMappingURL=index.js.map