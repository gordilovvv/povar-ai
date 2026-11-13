// Adversary e2e: гости с party_guestlist.guest_confirm_answer = 'no' не учитываются в админке.
// Контракт (из задачи):
//   'no' — исключён вместе со своими friends из: GET /parties guestCount, GET /parties/:id guestCount,
//   GET /parties/:id/guestlist, GET /parties/chart guestCount, GET /parties/:id/guestlist/chart;
//   null / 'pending' / 'yes' / 'failed' учитываются как раньше.
// Атаки: вечеринка, где все гости 'no' (счёт 0, не null/пропуск); несколько party_time
//   не размножают 'no'-исключение; соседняя party с тем же гостем 'yes' не страдает.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { pool as dashboardPool } from '#Dashboard/Db/Pool.js';
import { dashboardFetch } from '#Dashboard/Router.js';
import { closePool, dbOne, seedDashboardUser, signAuthToken, withClient } from './helpers/e2e.ts';

const DASH_PHONE = 'E2E_atk_gc_user';
const RUN = Date.now().toString(36);
const PREFIX = 'e2e_atk_gc_';
const ALLNO_ID = `${PREFIX}allno_${RUN}`;
const MIX_ID = `${PREFIX}mix_${RUN}`;
const PARTY_IDS = [ALLNO_ID, MIX_ID];
const GUEST_IDS = [0, 1, 2].map((n) => `${PREFIX}g${n}_${RUN}`);

const FROM = '2032-05-01T00:00:00.000Z';
const TO = '2032-06-01T00:00:00.000Z';

let token = '';

async function get<T>(path: string): Promise<T> {
    const res = await dashboardFetch(
        new Request(`http://dashboard${path}`, { headers: { authorization: `Bearer ${token}` } }),
    );
    assert.equal(res.status, 200, path);
    return (await res.json()) as T;
}

const dbKept = async (partyId: string) =>
    Number(
        (
            await dbOne<{ n: string }>(
                `select coalesce(sum(1 + coalesce(cardinality(friends), 0)), 0)::text n
                 from party_guestlist where party_id = $1 and guest_confirm_answer is distinct from 'no'`,
                [partyId],
            )
        )?.n,
    );

async function cleanup(): Promise<void> {
    await withClient(async (client) => {
        await client.query(`delete from party_guestlist where party_id = any($1)`, [PARTY_IDS]);
        await client.query(`delete from guests where id = any($1)`, [GUEST_IDS]);
        await client.query(`delete from party_time where party_id = any($1)`, [PARTY_IDS]);
        await client.query(`delete from party where id = any($1)`, [PARTY_IDS]);
        await client.query(`delete from dashboard_users where phone_number = $1`, [DASH_PHONE]);
    });
}

describe('attack: dashboard guest_confirm_answer = no', () => {
    before(async () => {
        await cleanup();
        token = signAuthToken(await seedDashboardUser(DASH_PHONE));
        await withClient(async (client) => {
            for (const id of PARTY_IDS) {
                await client.query(
                    `insert into party (id, type, name, price, location) values ($1, 'owned', $1, 0, 'E2E')`,
                    [id],
                );
            }
            const times: [string, string][] = [
                [ALLNO_ID, '2032-05-10T18:00:00Z'],
                [ALLNO_ID, '2032-05-20T18:00:00Z'],
                [MIX_ID, '2032-05-11T18:00:00Z'],
                [MIX_ID, '2032-05-12T18:00:00Z'],
                [MIX_ID, '2032-05-13T18:00:00Z'],
            ];
            for (const [id, startsAt] of times) {
                await client.query(
                    `insert into party_time (party_id, party_start_at, party_end_at) values ($1, $2, $2)`,
                    [id, startsAt],
                );
            }
            for (const id of GUEST_IDS) {
                await client.query(`insert into guests (id, first_name) values ($1, 'E2E')`, [id]);
            }
            const rows: [string, string, string | null, string[] | null, string | null][] = [
                [ALLNO_ID, GUEST_IDS[0], '2032-05-01T10:00:00Z', ['F1', 'F2'], 'no'],
                [ALLNO_ID, GUEST_IDS[1], '2032-05-02T10:00:00Z', null, 'no'],
                [ALLNO_ID, GUEST_IDS[2], null, ['F3'], 'no'],
                [MIX_ID, GUEST_IDS[0], '2032-05-01T10:00:00Z', ['M1'], 'yes'],
                [MIX_ID, GUEST_IDS[1], '2032-05-01T11:00:00Z', ['M2', 'M3'], 'no'],
                [MIX_ID, GUEST_IDS[2], '2032-05-02T10:00:00Z', [], 'failed'],
            ];
            for (const [partyId, guestId, joinedAt, friends, answer] of rows) {
                await client.query(
                    `insert into party_guestlist (party_id, guest_id, joined_at, friends, guest_confirm_answer)
                     values ($1, $2, $3, $4, $5)`,
                    [partyId, guestId, joinedAt, friends, answer],
                );
            }
        });
    });

    after(async () => {
        await cleanup();
        await closePool();
        await dashboardPool.end();
    });

    it('все гости no: guestCount 0 (число, не null) в списке, карточке и chart; guestlist [] и chart []', async () => {
        assert.equal(await dbKept(ALLNO_ID), 0);
        const card = await get<{ guestCount: unknown }>(`/parties/${ALLNO_ID}`);
        assert.strictEqual(card.guestCount, 0, 'карточка');

        const seen = new Map<string, unknown>();
        let cursor: string | null = null;
        for (let page = 0; page < 500; page++) {
            const q: string = cursor
                ? `limit=100&cursor=${encodeURIComponent(cursor)}`
                : 'limit=100';
            const res = await get<{
                items: { id: string; guestCount: unknown }[];
                nextCursor: string | null;
            }>(`/parties?${q}`);
            for (const item of res.items) seen.set(item.id, item.guestCount);
            cursor = res.nextCursor;
            if (cursor === null) break;
        }
        assert.strictEqual(seen.get(ALLNO_ID), 0, 'список');

        const chart = await get<{ id: string; guestCount: unknown }[]>(
            `/parties/chart?from=${FROM}&to=${TO}`,
        );
        assert.strictEqual(chart.find((r) => r.id === ALLNO_ID)?.guestCount, 0, 'parties chart');
        assert.equal(chart.filter((r) => r.id === ALLNO_ID).length, 1, 'одна строка на party');

        assert.deepEqual(await get(`/parties/${ALLNO_ID}/guestlist`), [], 'guestlist пуст');
        assert.deepEqual(
            await get(`/parties/${ALLNO_ID}/guestlist/chart`),
            [],
            'guestlist chart пуст',
        );
    });

    it('смесь + 3 party_time: no исключён ровно один раз, тот же гость yes в другой party не страдает', async () => {
        const kept = await dbKept(MIX_ID);
        assert.equal(kept, 3, 'yes(1+1) + failed(1+0)');

        const card = await get<{ guestCount: number }>(`/parties/${MIX_ID}`);
        assert.equal(card.guestCount, kept, 'карточка = факт БД');

        const chart = await get<{ id: string; guestCount: number }[]>(
            `/parties/chart?from=${FROM}&to=${TO}`,
        );
        const mine = chart.filter((r) => r.id === MIX_ID);
        assert.equal(mine.length, 1, 'party_time не размножают строку');
        assert.equal(mine[0].guestCount, kept, 'parties chart = факт БД');

        const list = await get<{ guestId: string }[]>(`/parties/${MIX_ID}/guestlist`);
        assert.deepEqual(
            list.map((g) => g.guestId),
            [GUEST_IDS[0], GUEST_IDS[2]],
            'no-гость исключён только в своей party',
        );

        const daily = await get<{ date: string; count: number }[]>(
            `/parties/${MIX_ID}/guestlist/chart`,
        );
        assert.deepEqual(daily, [
            { date: '2032-05-01', count: 2 },
            { date: '2032-05-02', count: 1 },
        ]);
    });
});
