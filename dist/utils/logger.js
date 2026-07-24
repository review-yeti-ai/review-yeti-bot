"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = exports.Logger = void 0;
const LOG_LEVELS = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3
};
class Logger {
    currentLevel;
    constructor() {
        const envLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
        this.currentLevel = LOG_LEVELS[envLevel] !== undefined ? LOG_LEVELS[envLevel] : LOG_LEVELS.info;
    }
    setLevel(level) {
        if (LOG_LEVELS[level] !== undefined) {
            this.currentLevel = LOG_LEVELS[level];
        }
    }
    shouldLog(level) {
        return LOG_LEVELS[level] >= this.currentLevel;
    }
    formatMessage(level, message, meta) {
        const timestamp = new Date().toISOString();
        const isProduction = process.env.NODE_ENV === 'production';
        if (isProduction) {
            return JSON.stringify({
                timestamp,
                level: level.toUpperCase(),
                message,
                ...meta
            });
        }
        const metaString = meta && Object.keys(meta).length > 0 ? ` | Meta: ${JSON.stringify(meta)}` : '';
        return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaString}`;
    }
    debug(message, meta) {
        if (this.shouldLog('debug')) {
            console.debug(this.formatMessage('debug', message, meta));
        }
    }
    info(message, meta) {
        if (this.shouldLog('info')) {
            console.info(this.formatMessage('info', message, meta));
        }
    }
    warn(message, meta) {
        if (this.shouldLog('warn')) {
            console.warn(this.formatMessage('warn', message, meta));
        }
    }
    error(message, meta) {
        if (this.shouldLog('error')) {
            console.error(this.formatMessage('error', message, meta));
        }
    }
}
exports.Logger = Logger;
exports.logger = new Logger();
//# sourceMappingURL=logger.js.map