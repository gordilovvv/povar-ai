import { Worker } from 'node:worker_threads';
import { env } from '#environment.js';
import type { GuestConfirmJobConfig } from '#Jobs/GuestConfirmEntry.js';

const ENTRY = new URL(
    import.meta.url.endsWith('.ts') ? './GuestConfirmEntry.ts' : './GuestConfirmEntry.js',
    import.meta.url,
);

export const startGuestConfirmJob = () => {
    const worker = new Worker(ENTRY, {
        workerData: {
            databaseUrl: env.DATABASE_URL,
            waToken: env.WA_TOKEN,
            waPhoneId: env.WA_PHONE_ID,
            waSend: env.WA_SEND,
        } satisfies GuestConfirmJobConfig,
    });
    worker.on('error', (error) => {
        console.error('[jobs] guest-confirm thread fatal', error);
        process.exit(1);
    });
    worker.on('exit', (code) => {
        if (code !== 0) {
            console.error(`[jobs] guest-confirm thread exited ${code}`);
            process.exit(1);
        }
    });
    return worker;
};
