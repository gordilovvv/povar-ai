// Adversary e2e для partyGetGuestlistChartHandler и partiesGetChartHandler.
// Контракт (из задачи):
//   auth: нет/протухший/юзера нет в базе → 401 на обеих ручках;
//   guestlist/chart: joined_at null не учитывается; кривой id/инъекция в path → 400/[] без 500, таблицы целы;
//   parties/chart: startsAt = min(party_time) в [from, to) — from включён, to исключён (до миллисекунды),
//     sort startsAt asc, id asc; без времени не попадает; кривые from/to (SQL-мета, массив, не-UTC,
//     дата без времени, гигантская строка), to ≤ from → 400.
//   бэк смотрит на прод: 3 вечеринки под e2e_atk_pc_*, окна в 2031, всё чистится.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { pool as dashboardPool } from '#Dashboard/Db/Pool.js';
import { dashboardFetch } from '#Dashboard/Router.js';
import { closePool, dbOne, seedDashboardUser, signAuthToken, withClient } from './helpers/e2e.ts';

const DASH_PHONE = 'E2E_atk_pc_user';
const GHOST_PHONE = 'E2E_atk_pc_ghost';
const RUN = Date.now().toString(36);
const PREFIX = `e2e_atk_pc_`;
const A_ID = `${PREFIX}a_${RUN}`;
const B_ID = `${PREFIX}b_${RUN}`;
const C_ID = `${PREFIX}c_${RUN}`;
const PARTY_IDS = [A_ID, B_ID, C_ID];
const GUEST_IDS = [1, 2].map((n) => `${PREFIX}guest${n}_${RUN}`);

const FROM = '2031-03-01T00:00:00.000Z';
const TO = '2031-04-01T00:00:00.000Z';

let token = '';

function get(path: string, auth: string | null = `Bearer ${token}`): Promise<Response> {
    const headers: Record<string, string> = {};
    if (auth !== null) headers.authorization = auth;
    return dashboardFetch(new Request(`http://dashboard${path}`, { headers }));
}

type ChartRow = { id: string; name: string; startsAt: string; guestCount: number };

async function ownChart(from: string, to: string): Promise<ChartRow[]> {
    const res = await get(
        `/parties/chart?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
    assert.equal(res.status, 200, `${from}..${to}`);
    const body = (await res.json()) as ChartRow[];
    return body.filter((r) => r.id.startsWith(PREFIX) && r.id.endsWith(RUN));
}

async function cleanup(): Promise<void> {
    await withClient(async (client) => {
        await client.query(`delete from party_guestlist where party_id = any($1)`, [PARTY_IDS]);
        await client.query(`delete from guests where id = any($1)`, [GUEST_IDS]);
        await client.query(`delete from party_time where party_id = any($1)`, [PARTY_IDS]);
        await client.query(`delete from party where id = any($1)`, [PARTY_IDS]);
        await client.query(`delete from dashboard_users where phone_number = any($1)`, [
            [DASH_PHONE, GHOST_PHONE],
        ]);
    });
}

async function tablesIntact(): Promise<void> {
    for (const t of ['party', 'party_time', 'party_guestlist', 'guests']) {
        assert.equal(
            (await dbOne<{ t: string }>(`select to_regclass($1)::text t`, [`public.${t}`]))?.t,
            t,
            `таблица ${t} цела`,
        );
    }
    const row = await dbOne<{ p: number; g: number }>(
        `select (select count(*)::int from party where id = any($1)) p,
                (select count(*)::int from party_guestlist where party_id = any($1)) g`,
        [PARTY_IDS],
    );
    assert.deepEqual(row, { p: 3, g: 2 }, 'свои строки целы');
}

describe('attack: dashboard party charts', () => {
    before(async () => {
        await cleanup();
        token = signAuthToken(await seedDashboardUser(DASH_PHONE));
        await withClient(async (client) => {
            const times: [string, string][] = [
                [A_ID, '2031-03-01T06:00:00Z'],
                [A_ID, FROM],
                [B_ID, FROM],
                [C_ID, TO],
            ];
            for (const id of PARTY_IDS) {
                await client.query(
                    `insert into party (id, type, name, price, location) values ($1, 'owned', $1, 0, 'E2E')`,
                    [id],
                );
            }
            for (const [id, startsAt] of times) {
                await client.query(
                    `insert into party_time (party_id, party_start_at, party_end_at) values ($1, $2, $2)`,
                    [id, startsAt],
                );
            }
            const joins: [string, string | null, string[] | null][] = [
                [GUEST_IDS[0], '2031-02-20T10:00:00Z', ['F1', 'F2']],
                [GUEST_IDS[1], null, ['F3']],
            ];
            for (const [guestId, joinedAt, friends] of joins) {
                await client.query(`insert into guests (id, first_name) values ($1, 'E2E')`, [
                    guestId,
                ]);
                await client.query(
                    `insert into party_guestlist (party_id, guest_id, joined_at, friends) values ($1, $2, $3, $4)`,
                    [A_ID, guestId, joinedAt, friends],
                );
            }
        });
    });

    after(async () => {
        await cleanup();
        await closePool();
        await dashboardPool.end();
    });

    it('auth: нет/битый/протухший/юзера нет в базе → 401 на обеих ручках', async () => {
        const id = await seedDashboardUser(DASH_PHONE);
        const ghostId = await seedDashboardUser(GHOST_PHONE);
        const ghostToken = signAuthToken(ghostId);
        await withClient((c) => c.query(`delete from dashboard_users where id = $1`, [ghostId]));
        for (const path of [
            `/parties/${A_ID}/guestlist/chart`,
            `/parties/chart?from=${FROM}&to=${TO}`,
        ]) {
            for (const auth of [
                null,
                '',
                'Bearer ',
                `Basic ${token}`,
                'Bearer a.b.c',
                `Bearer ${signAuthToken(id, -10)}`,
                `Bearer ${ghostToken}`,
            ]) {
                const res = await get(path, auth);
                assert.equal(res.status, 401, `${path} [${auth}] → 401`);
                assert.equal(await res.text().then((t) => t.includes(A_ID)), false, 'данных нет');
            }
        }
    });

    it('guestlistChart: joined_at null не учитывается (сверка с БД)', async () => {
        const db = await dbOne<{ c: number }>(
            `select coalesce(sum(1 + coalesce(cardinality(friends), 0)), 0)::int c
             from party_guestlist where party_id = $1 and joined_at is not null`,
            [A_ID],
        );
        assert.equal(db?.c, 3);
        const res = await get(`/parties/${A_ID}/guestlist/chart`);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), [{ date: '2031-02-20', count: 3 }]);
    });

    it('guestlistChart inject: кривой id в path → 400/404/[], не 500, таблицы целы', async () => {
        const ids = [
            `${A_ID}'; delete from party where id like 'e2e_atk_pc_%'; --`,
            `' or '1'='1`,
            `' or party_id like 'e2e_atk_pc_%' or '`,
            'e2e_atk_pc_%',
            '%25',
            '%27',
            '%00',
            '%0a',
            '%C3%28',
            '%ED%A0%80',
            `${A_ID}%20`,
            A_ID.toUpperCase(),
            '%L',
            '%1$L',
            '\\',
            'a'.repeat(5000),
        ];
        for (const id of ids) {
            const res = await get(`/parties/${id}/guestlist/chart`);
            assert.ok([200, 400, 404].includes(res.status), `${id.slice(0, 80)} → ${res.status}`);
            if (res.status === 200) {
                const body = (await res.json()) as unknown[];
                if (id === `${A_ID}%20`) {
                    // safeParseString тримит — тот же id, это не утечка чужого
                    continue;
                }
                assert.deepEqual(body, [], `${id.slice(0, 80)} → пусто`);
            }
        }
        await tablesIntact();
    });

    it('partiesChart: from включён, to исключён, min(party_time), tie по id asc', async () => {
        const db = await dbOne<{ a: string; c: string }>(
            `select (select min(party_start_at) from party_time where party_id = $1)::text a,
                    (select min(party_start_at) from party_time where party_id = $2)::text c`,
            [A_ID, C_ID],
        );
        assert.equal(db?.a, '2031-03-01 00:00:00+00');
        assert.deepEqual(await ownChart(FROM, TO), [
            { id: A_ID, name: A_ID, startsAt: FROM, guestCount: 5 },
            { id: B_ID, name: B_ID, startsAt: FROM, guestCount: 0 },
        ]);
    });

    it('partiesChart: граница from с миллисекундами — вечеринка раньше from не попадает', async () => {
        const rows = await ownChart('2031-03-01T00:00:00.500Z', TO);
        assert.deepEqual(
            rows.map((r) => r.id),
            [],
            'A/B стартуют в 00:00:00.000 < from=00:00:00.500 → не в [from, to)',
        );
    });

    it('partiesChart: граница to с миллисекундами — вечеринка раньше to попадает', async () => {
        const rows = await ownChart(FROM, '2031-04-01T00:00:00.500Z');
        assert.deepEqual(
            rows.map((r) => r.id),
            [A_ID, B_ID, C_ID],
            'C стартует в 00:00:00.000 < to=00:00:00.500 → в [from, to)',
        );
    });

    it('partiesChart: кривые from/to → 400, таблицы целы', async () => {
        const enc = encodeURIComponent;
        const giant = `${FROM}${'0'.repeat(5000)}`;
        const queries = [
            '',
            `from=${FROM}`,
            `to=${TO}`,
            `from=&to=${TO}`,
            `from=${enc(`${FROM}' or '1'='1`)}&to=${TO}`,
            `from=${enc(`'; drop table party; --`)}&to=${TO}`,
            `from=${FROM}&to=${enc(`${TO}'); delete from party; --`)}`,
            `from=${enc('%L')}&to=${TO}`,
            `from=${FROM}&from=${FROM}&to=${TO}`,
            `from=${FROM}&to=${TO}&to=${TO}`,
            `from=${enc('2031-03-01T04:00:00.000+04:00')}&to=${TO}`,
            `from=2031-03-01T04:00:00.000%2B04:00&to=${TO}`,
            `from=${FROM}&to=${enc('2031-04-01T00:00:00.000-01:00')}`,
            `from=2031-03-01&to=${TO}`,
            `from=${FROM}&to=2031-04-01`,
            `from=2031-03-01T00:00:00Z&to=${TO}`,
            `from=2031-03-01T00:00:00.000&to=${TO}`,
            `from=2031-02-30T00:00:00.000Z&to=${TO}`,
            `from=${FROM}&to=9999-99-99T00:00:00.000Z`,
            `from=1772323200000&to=${TO}`,
            `from=${enc(giant)}&to=${TO}`,
            `from=${FROM}&to=${enc(giant)}`,
            `from=${FROM}&to=${FROM}`,
            `from=${TO}&to=${FROM}`,
            `from[]=${FROM}&to=${TO}`,
        ];
        for (const q of queries) {
            const res = await get(`/parties/chart?${q}`);
            assert.equal(res.status, 400, `${q.slice(0, 120)} → 400, получили ${res.status}`);
        }
        await tablesIntact();
    });

    it('partiesChart: пробелы/\\n по краям тримятся общим safeParseString → как чистый ISO', async () => {
        const clean = await ownChart(FROM, TO);
        assert.deepEqual(await ownChart(`${FROM}\n`, TO), clean);
        assert.deepEqual(await ownChart(` ${FROM} `, ` ${TO}`), clean);
    });

    it('partiesChart: год 0000 (валиден для toISOString, не для pg) → 400, не 500', async () => {
        const res = await get(`/parties/chart?from=0000-01-01T00:00:00.000Z&to=${TO}`);
        assert.equal(res.status, 400, `получили ${res.status}`);
    });

    it('partiesChart: вечеринка без party_time не попадает', async () => {
        await withClient((c) => c.query(`delete from party_time where party_id = $1`, [C_ID]));
        const db = await dbOne<{ c: number }>(
            `select count(*)::int c from party_time where party_id = $1`,
            [C_ID],
        );
        assert.equal(db?.c, 0);
        const rows = await ownChart('1970-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z');
        assert.deepEqual(
            rows.map((r) => r.id),
            [A_ID, B_ID],
        );
    });
});
