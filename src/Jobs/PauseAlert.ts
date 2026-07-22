import { Worker } from 'node:worker_threads';
import { env } from '#environment.js';
import type { PauseAlertJobConfig } from '#Jobs/PauseAlertEntry.js';

const ENTRY = new URL(
    import.meta.url.endsWith('.ts') ? './PauseAlertEntry.ts' : './PauseAlertEntry.js',
    import.meta.url,
);

export const startPauseAlertJob = () => {
    const worker = new Worker(ENTRY, {
        workerData: {
            databaseUrl: env.DATABASE_URL,
            telegramBotToken: env.TELEGRAM_BOT_TOKEN,
            telegramGroupId: env.TELEGRAM_GROUP_ID,
        } satisfies PauseAlertJobConfig,
    });
    worker.on('error', (error) => {
        console.error('[jobs] pause-alert thread fatal', error);
        process.exit(1);
    });
    worker.on('exit', (code) => {
        if (code !== 0) {
            console.error(`[jobs] pause-alert thread exited ${code}`);
            process.exit(1);
        }
    });
    return worker;
};
