import { Worker } from 'node:worker_threads';
import { env } from '#environment.js';
import type { GuestlistJobConfig } from '#Jobs/GuestlistEntry.js';

const ENTRY = new URL(
    import.meta.url.endsWith('.ts') ? './GuestlistEntry.ts' : './GuestlistEntry.js',
    import.meta.url,
);

export const startGuestlistJob = () => {
    const worker = new Worker(ENTRY, {
        workerData: {
            databaseUrl: env.DATABASE_URL,
            telegramBotToken: env.TELEGRAM_BOT_TOKEN,
            telegramGroupId: env.TELEGRAM_GROUP_ID,
        } satisfies GuestlistJobConfig,
    });
    worker.on('error', (error) => {
        console.error('[jobs] guestlist thread fatal', error);
        process.exit(1);
    });
    worker.on('exit', (code) => {
        if (code !== 0) {
            console.error(`[jobs] guestlist thread exited ${code}`);
            process.exit(1);
        }
    });
    return worker;
};
