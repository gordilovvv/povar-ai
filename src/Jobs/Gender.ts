import { Worker } from 'node:worker_threads';

const ENTRY = new URL(
    import.meta.url.endsWith('.ts') ? './GenderEntry.ts' : './GenderEntry.js',
    import.meta.url,
);

export const startGenderJob = () => {
    const worker = new Worker(ENTRY);
    worker.on('error', (error) => {
        console.error('[jobs] gender thread fatal', error);
        process.exit(1);
    });
    worker.on('exit', (code) => {
        if (code !== 0) {
            console.error(`[jobs] gender thread exited ${code}`);
            process.exit(1);
        }
    });
    return worker;
};
