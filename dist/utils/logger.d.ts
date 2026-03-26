import pino from 'pino';
export declare const logger: pino.Logger<"metric", boolean>;
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'metric';
export interface LogContext {
    reqId?: string;
    streamerId?: string;
    vodId?: string;
    userId?: string;
    [key: string]: unknown;
}
export declare function childLogger(context: LogContext): pino.Logger<"metric", boolean>;
//# sourceMappingURL=logger.d.ts.map