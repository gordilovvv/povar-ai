import pino from 'pino';

const logger = pino({ level: 'debug', transport: { target: 'pino-pretty' } });

export class Logger {
    static log(message: string, ...details: unknown[]): void {
        Logger.write('info', message, details);
    }

    static logWarn(message: string, ...details: unknown[]): void {
        Logger.write('warn', message, details);
    }

    static logError(message: string, error?: unknown, ...details: unknown[]): void {
        if (error === undefined) {
            logger.error(message);
            return;
        }
        logger.error(details.length ? { err: error, details } : { err: error }, message);
    }

    static debug(message: string, ...details: unknown[]): void {
        Logger.write('debug', message, details);
    }

    private static write(level: 'info' | 'warn' | 'debug', message: string, details: unknown[]) {
        if (details.length === 0) {
            logger[level](message);
            return;
        }
        logger[level]({ details }, message);
    }
}
