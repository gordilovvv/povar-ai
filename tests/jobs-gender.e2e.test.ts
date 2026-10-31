import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { pool } from '#Db/Pool.js';
import { runTick } from '#Jobs/GenderEntry.js';
import { closePool, dbOne, dbQuery, measure } from './helpers/e2e.ts';

// '0000…' < любого ULID: тик берёт первые 20 по id, иначе на общей базе с бэклогом до тестовых строк не дойдёт.
const GUESTS = [
    { id: '0000_E2E_GD_1', first_name: 'Иван', last_name: 'Петров', expected: 'male' },
    { id: '0000_E2E_GD_2', first_name: 'Anna', last_name: null, expected: 'female' },
    { id: '0000_E2E_GD_3', first_name: 'xq7zt', last_name: null, expected: 'unknown' },
    { id: '0000_E2E_GD_4', first_name: null, last_name: 'Smith', expected: null },
];
const PRESET = { id: '0000_E2E_GD_5', first_name: 'Олег', gender: 'female' };

const genderOf = async (id: string) =>
    (await dbOne<{ gender: string | null }>('select gender from guests where id = $1', [id]))
        ?.gender ?? null;

const cleanup = async () => {
    await dbQuery(`delete from guests where id like '0000_E2E_GD_%'`);
};

describe('e2e: jobs-gender', () => {
    before(async () => {
        await cleanup();
        for (const guest of GUESTS) {
            await dbQuery('insert into guests (id, first_name, last_name) values ($1,$2,$3)', [
                guest.id,
                guest.first_name,
                guest.last_name,
            ]);
        }
        await dbQuery('insert into guests (id, first_name, gender) values ($1,$2,$3)', [
            PRESET.id,
            PRESET.first_name,
            PRESET.gender,
        ]);
    });

    after(async () => {
        await cleanup();
        await pool.end();
        await closePool();
    });

    test('e2e: jobs-gender — тик проставляет пол из ответа модели, без имени и с готовым полом не трогает', async () => {
        await measure('jobs-gender tick', () => runTick(pool));

        for (const guest of GUESTS) {
            assert.equal(await genderOf(guest.id), guest.expected, guest.id);
        }
        assert.equal(await genderOf(PRESET.id), PRESET.gender);
    });
});
