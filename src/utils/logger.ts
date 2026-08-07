export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

export class Logger {
  private currentLevel: number;

  constructor() {
    const envLevel = (process.env.LOG_LEVEL || 'info').toLowerCase() as LogLevel;
    this.currentLevel = LOG_LEVELS[envLevel] !== undefined ? LOG_LEVELS[envLevel] : LOG_LEVELS.info;
  }

  public setLevel(level: LogLevel): void {
    if (LOG_LEVELS[level] !== undefined) {
      this.currentLevel = LOG_LEVELS[level];
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= this.currentLevel;
  }

  private formatMessage(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
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

  debug(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('debug')) {
      console.debug(this.formatMessage('debug', message, meta));
    }
  }

  info(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('info')) {
      console.info(this.formatMessage('info', message, meta));
    }
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('warn')) {
      console.warn(this.formatMessage('warn', message, meta));
    }
  }

  error(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('error')) {
      console.error(this.formatMessage('error', message, meta));
    }
  }
}

export const logger = new Logger();
