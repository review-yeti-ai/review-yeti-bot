export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export declare class Logger {
    private currentLevel;
    constructor();
    setLevel(level: LogLevel): void;
    private shouldLog;
    private formatMessage;
    debug(message: string, meta?: Record<string, unknown>): void;
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
}
export declare const logger: Logger;
