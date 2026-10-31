// Запуск: pnpm exec tsx --conditions=development --env-file=.env.dev tests/probes/Gender.ts [--limit=N]
import { pool } from '#Db/Pool.js';
import { GenderDetector } from '#Lib/Gender.js';
import { fmt } from '../helpers/e2e.js';

const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : 10;
const BUDGET_MS = 1_000;

const { rows } = await pool.query<{ first_name: string; last_name: string | null }>(
    `select first_name, last_name from guests where first_name is not null order by random() limit $1`,
    [LIMIT],
);
await pool.end();

let over = 0;
for (const { first_name, last_name } of rows) {
    const name = last_name ? `${first_name} ${last_name}` : first_name;
    const start = process.hrtime.bigint();
    const gender = await GenderDetector.detect(name);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const slow = ms > BUDGET_MS;
    if (slow) {
        over++;
    }
    console.log(`[gender] ${name} → ${gender ?? 'null'} — ${fmt(ms)}${slow ? ' SLOW' : ''}`);
}
console.log(`[gender] over budget: ${over}/${rows.length}`);
