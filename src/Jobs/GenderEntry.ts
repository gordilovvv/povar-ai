import { parentPort } from 'node:worker_threads';
import type pg from 'pg';
import { pool } from '#Db/Pool.js';
import { GenderDetector } from '#Lib/Gender.js';

interface GuestRow {
    id: string;
    first_name: string;
    last_name: string | null;
}

const TICK_INTERVAL_MS = 60_000;
const CLAIM_LIMIT = 20;

export const runTick = async (db: pg.Pool) => {
    const { rows } = await db.query<GuestRow>(
        `select id, first_name, last_name from guests
        where gender is null and trim(first_name) <> ''
        order by id
        limit $1`,
        [CLAIM_LIMIT],
    );
    for (const guest of rows) {
        const name = [guest.first_name, guest.last_name].filter(Boolean).join(' ');
        const gender = await GenderDetector.detect(name);
        await db.query('update guests set gender = $1 where id = $2 and gender is null', [
            gender,
            guest.id,
        ]);
        console.log(`[jobs:gender] ${guest.id} ${name} → ${gender}`);
    }
};

if (parentPort) {
    const tick = async () => {
        try {
            await runTick(pool);
        } catch (error) {
            console.error('[jobs] gender tick failed', error);
        }
    };
    void tick();
    setInterval(() => void tick(), TICK_INTERVAL_MS);
}
