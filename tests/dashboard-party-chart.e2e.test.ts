// Задача модулей (partyGetGuestlistChartHandler, partiesGetChartHandler):
//   вход  → GET /parties/:id/guestlist/chart; GET /parties/chart?from&to (ISO UTC), Bearer JWT
//   выход → [{ date (день по Дубаю), count (гость + friends) }] по date asc, пустые дни пропущены;
//           [{ id, name, startsAt, guestCount }] со startsAt в [from, to), по startsAt asc
//   бюджет → сеть/БД не меряем, только measure()
//   негатив → вечеринки нет → []; нет/кривой from|to, to ≤ from → 400
//   бэк смотрит на прод: окно в 2030, сеем 3 вечеринки и 3 гостей под e2e_pc_*, всё чистим

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { pool as dashboardPool } from '#Dashboard/Db/Pool.js';
import { dashboardFetch } from '#Dashboard/Router.js';
import {
    closePool,
    dbOne,
    dbQuery,
    measure,
    seedDashboardUser,
    signAuthToken,
    withClient,
} from './helpers/e2e.ts';

const DASH_PHONE = 'E2E_partychart_user';
const RUN = Date.now().toString(36);
const FULL_ID = `e2e_pc_full_${RUN}`;
const EMPTY_ID = `e2e_pc_empty_${RUN}`;
const OUTSIDE_ID = `e2e_pc_outside_${RUN}`;
const CONFIRM_ID = `e2e_pc_confirm_${RUN}`;
const PARTY_IDS = [FULL_ID, EMPTY_ID, OUTSIDE_ID, CONFIRM_ID];
const CONFIRM_GUESTS: { answer: string | null; joinedAt: string; friends: string[] | null }[] = [
    { answer: 'no', joinedAt: '2030-03-01T10:00:00Z', friends: ['No F1', 'No F2', 'No F3'] },
    { answer: 'pending', joinedAt: '2030-03-02T10:00:00Z', friends: ['Pending F1'] },
    { answer: 'yes', joinedAt: '2030-03-02T11:00:00Z', friends: null },
    { answer: 'failed', joinedAt: '2030-03-03T10:00:00Z', friends: ['Failed F1', 'Failed F2'] },
    { answer: null, joinedAt: '2030-03-03T11:00:00Z', friends: null },
];
const CONFIRM_GUEST_IDS = CONFIRM_GUESTS.map((_, i) => `e2e_pc_cguest${i}_${RUN}`);
const GUEST_IDS = [...[1, 2, 3].map((n) => `e2e_pc_guest${n}_${RUN}`), ...CONFIRM_GUEST_IDS];
const CONFIRM_FROM = '2030-03-01T00:00:00.000Z';
const CONFIRM_TO = '2030-04-01T00:00:00.000Z';

const FROM = '2030-01-01T00:00:00.000Z';
const TO = '2030-02-01T00:00:00.000Z';

let token = '';

async function get(path: string): Promise<Response> {
    const { result } = await measure(`GET ${path}`, () =>
        dashboardFetch(
            new Request(`http://dashboard${path}`, {
                headers: { authorization: `Bearer ${token}` },
            }),
        ),
    );
    return result;
}

async function cleanup(): Promise<void> {
    await withClient(async (client) => {
        await client.query(`delete from party_guestlist where party_id = any($1)`, [PARTY_IDS]);
        await client.query(`delete from guests where id = any($1)`, [GUEST_IDS]);
        await client.query(`delete from party_time where party_id = any($1)`, [PARTY_IDS]);
        await client.query(`delete from party where id = any($1)`, [PARTY_IDS]);
        await client.query(`delete from dashboard_users where phone_number = $1`, [DASH_PHONE]);
    });
}

describe('e2e: dashboard party charts', () => {
    before(async () => {
        await cleanup();
        token = signAuthToken(await seedDashboardUser(DASH_PHONE));
        await withClient(async (client) => {
            const parties: [string, string][] = [
                [FULL_ID, '2030-01-10T18:00:00Z'],
                [EMPTY_ID, '2030-01-05T18:00:00Z'],
                [OUTSIDE_ID, '2030-02-01T00:00:00Z'],
                [CONFIRM_ID, '2030-03-10T18:00:00Z'],
            ];
            for (const [id, startsAt] of parties) {
                await client.query(
                    `insert into party (id, type, name, price, location) values ($1, 'owned', $1, 0, 'E2E')`,
                    [id],
                );
                await client.query(
                    `insert into party_time (party_id, party_start_at, party_end_at) values ($1, $2, $2)`,
                    [id, startsAt],
                );
            }
            // 19:30Z = 23:30 по Дубаю (08-е), 20:30Z = 00:30 по Дубаю (уже 09-е)
            const joins: [string, string, string[] | null][] = [
                [GUEST_IDS[0], '2030-01-08T19:30:00Z', ['Friend One', 'Friend Two']],
                [GUEST_IDS[1], '2030-01-08T20:30:00Z', null],
                [GUEST_IDS[2], '2030-01-09T10:00:00Z', ['Friend Three']],
            ];
            for (const [guestId, joinedAt, friends] of joins) {
                await client.query(`insert into guests (id, first_name) values ($1, 'E2E')`, [
                    guestId,
                ]);
                await client.query(
                    `insert into party_guestlist (party_id, guest_id, joined_at, friends) values ($1, $2, $3, $4)`,
                    [FULL_ID, guestId, joinedAt, friends],
                );
            }
            for (const [i, guest] of CONFIRM_GUESTS.entries()) {
                await client.query(`insert into guests (id, first_name) values ($1, 'E2E')`, [
                    CONFIRM_GUEST_IDS[i],
                ]);
                await client.query(
                    `insert into party_guestlist (party_id, guest_id, joined_at, friends, guest_confirm_answer)
                     values ($1, $2, $3, $4, $5)`,
                    [CONFIRM_ID, CONFIRM_GUEST_IDS[i], guest.joinedAt, guest.friends, guest.answer],
                );
            }
        });
    });

    after(async () => {
        await cleanup();
        await closePool();
        await dashboardPool.end();
    });

    it('e2e: guestlistChart — дни по Дубаю, гость + friends, пустые дни пропущены', async () => {
        const res = await get(`/parties/${FULL_ID}/guestlist/chart`);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), [
            { date: '2030-01-08', count: 3 },
            { date: '2030-01-09', count: 3 },
        ]);
    });

    it('e2e: guestlistChart — несуществующая вечеринка → []', async () => {
        const res = await get(`/parties/e2e_pc_missing_${RUN}/guestlist/chart`);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), []);
    });

    it("e2e: guestlistChart — гость с guest_confirm_answer = 'no' и его friends не считаются", async () => {
        const res = await get(`/parties/${CONFIRM_ID}/guestlist/chart`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.deepEqual(
            body,
            [
                { date: '2030-03-02', count: 3 },
                { date: '2030-03-03', count: 4 },
            ],
            "день только с 'no'-гостем выпал, pending/yes/failed/null + friends на месте",
        );

        const dbRows = await dbQuery<{ date: string; count: number; refused: number }>(
            `select to_char((joined_at at time zone 'Asia/Dubai')::date, 'YYYY-MM-DD') as date,
                (sum(1 + coalesce(cardinality(friends), 0))
                    filter (where guest_confirm_answer is distinct from 'no'))::int as count,
                (sum(1 + coalesce(cardinality(friends), 0))
                    filter (where guest_confirm_answer = 'no'))::int as refused
             from party_guestlist where party_id = $1 group by 1 order by 1`,
            [CONFIRM_ID],
        );
        assert.equal(
            dbRows.find((r) => r.date === '2030-03-01')?.refused,
            4,
            "в БД 'no'-гость с friends лежит 2030-03-01",
        );
        assert.deepEqual(
            body,
            dbRows.filter((r) => r.count !== null).map((r) => ({ date: r.date, count: r.count })),
            'график = факт БД без no',
        );
    });

    it("e2e: partiesChart — гость с guest_confirm_answer = 'no' и его friends не в guestCount", async () => {
        const res = await get(`/parties/chart?from=${CONFIRM_FROM}&to=${CONFIRM_TO}`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as { id: string; guestCount: number }[];
        assert.deepEqual(body, [
            {
                id: CONFIRM_ID,
                name: CONFIRM_ID,
                startsAt: '2030-03-10T18:00:00.000Z',
                guestCount: 7,
            },
        ]);

        const counts = await dbOne<{ kept: number; total: number }>(
            `select
                (sum(1 + coalesce(cardinality(friends), 0))
                    filter (where guest_confirm_answer is distinct from 'no'))::int as kept,
                sum(1 + coalesce(cardinality(friends), 0))::int as total
             from party_guestlist where party_id = $1`,
            [CONFIRM_ID],
        );
        assert.deepEqual(counts, { kept: 7, total: 11 }, "в БД 'no'-гость с 3 friends лежит");
        assert.equal(body[0].guestCount, counts?.kept, 'guestCount = факт БД без no');
    });

    it('e2e: partiesChart — окно [from, to): по startsAt asc, без гостей 0, граница to исключена', async () => {
        const res = await get(`/parties/chart?from=${FROM}&to=${TO}`);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), [
            { id: EMPTY_ID, name: EMPTY_ID, startsAt: '2030-01-05T18:00:00.000Z', guestCount: 0 },
            { id: FULL_ID, name: FULL_ID, startsAt: '2030-01-10T18:00:00.000Z', guestCount: 6 },
        ]);
    });

    it('e2e: partiesChart — нет from, кривой to, to ≤ from → 400', async () => {
        for (const query of [`to=${TO}`, `from=${FROM}&to=nope`, `from=${TO}&to=${FROM}`]) {
            const res = await get(`/parties/chart?${query}`);
            assert.equal(res.status, 400, query);
        }
    });
});
