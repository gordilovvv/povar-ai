import pino from 'pino';

const logger = pino({ level: 'debug', transport: { target: 'pino-pretty' } });

export class Logger {
    static log(message: string): void {
        logger.info(message);
    }

    static logWarn(message: string): void {
        logger.warn(message);
    }

    static logError(message: string, error?: unknown): void {
        if (error === undefined) {
            logger.error(message);
        } else {
            logger.error({ err: error }, message);
        }
    }

    static debug(message: string): void {
        logger.debug(message);
    }
}
