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
import { closePool, measure, seedDashboardUser, signAuthToken, withClient } from './helpers/e2e.ts';

const DASH_PHONE = 'E2E_partychart_user';
const RUN = Date.now().toString(36);
const FULL_ID = `e2e_pc_full_${RUN}`;
const EMPTY_ID = `e2e_pc_empty_${RUN}`;
const OUTSIDE_ID = `e2e_pc_outside_${RUN}`;
const PARTY_IDS = [FULL_ID, EMPTY_ID, OUTSIDE_ID];
const GUEST_IDS = [1, 2, 3].map((n) => `e2e_pc_guest${n}_${RUN}`);

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
