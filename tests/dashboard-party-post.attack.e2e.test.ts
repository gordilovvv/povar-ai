// Adversary e2e для partyPostHandler.
// Контракт (из задачи):
//   auth: нет/битый/протухший/чужая подпись/удалённый юзер → 401, в БД ничего не записано;
//   400: не-JSON, нет ключей, неверные типы, price < 0, кривой enum, кривой slug (SQL-мета, upper),
//        невалидный ISO, endsAt < startsAt, time без guestlistAlertAt — и в БД ничего (ни party, ни party_time);
//   инъекции в текстовых полях хранятся как есть, таблицы целы;
//   параллельные POST одного id (новый и существующий, с разным time) → ровно 1 party и 1 party_time;
//   marketing_message и party_tables не трогаются.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { pool as dashboardPool } from '#Dashboard/Db/Pool.js';
import { signJwt } from '#Dashboard/Lib/Jwt.js';
import { dashboardFetch } from '#Dashboard/Router.js';
import {
    closePool,
    dbOne,
    dbQuery,
    seedDashboardUser,
    signAuthToken,
    withClient,
} from './helpers/e2e.ts';

const DASH_PHONE = 'E2E_atk_pp_user';
const GHOST_PHONE = 'E2E_atk_pp_ghost';
const RUN = Date.now().toString(36);
const AUTH_ID = `e2e_atk_pp_auth_${RUN}`;
const BAD_ID = `e2e_atk_pp_bad_${RUN}`;
const INJ_ID = `e2e_atk_pp_inj_${RUN}`;
const RACE_NEW_ID = `e2e_atk_pp_rnew_${RUN}`;
const RACE_OLD_ID = `e2e_atk_pp_rold_${RUN}`;
const RACE_MIX_ID = `e2e_atk_pp_rmix_${RUN}`;
const OWN_IDS = [AUTH_ID, BAD_ID, INJ_ID, RACE_NEW_ID, RACE_OLD_ID, RACE_MIX_ID];

const TIME = {
    startsAt: '2026-12-01T18:00:00.000Z',
    endsAt: '2026-12-02T02:00:00.000Z',
    guestlistAlertAt: '2026-12-01T14:00:00.000Z',
};
const BODY = {
    id: BAD_ID,
    type: 'owned',
    name: 'E2E atk',
    price: 100,
    location: 'E2E loc',
    googleMapLink: null,
    reelsUrl: null,
    notes: null,
    time: TIME,
};

let token = '';

function jwtSecret(): string {
    const s = process.env.JWT_SECRET;
    if (!s) throw new Error('JWT_SECRET missing');
    return s;
}

async function postRaw(body: string, auth: string | null = `Bearer ${token}`): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (auth !== null) headers.authorization = auth;
    return dashboardFetch(new Request('http://dashboard/party', { method: 'POST', headers, body }));
}

const post = (body: unknown, auth?: string | null) => postRaw(JSON.stringify(body), auth);

async function countRows(id: string): Promise<{ party: number; time: number }> {
    const row = await dbOne<{ p: string; t: string }>(
        `select (select count(*) from party where id = $1) p,
                (select count(*) from party_time where party_id = $1) t`,
        [id],
    );
    return { party: Number(row?.p), time: Number(row?.t) };
}

async function cleanup(): Promise<void> {
    await withClient(async (client) => {
        await client.query(`delete from party_tables where party_id = any($1)`, [OWN_IDS]);
        await client.query(`delete from party_time where party_id = any($1)`, [OWN_IDS]);
        await client.query(`delete from party where id = any($1)`, [OWN_IDS]);
        await client.query(`delete from dashboard_users where phone_number = any($1)`, [
            [DASH_PHONE, GHOST_PHONE],
        ]);
    });
}

describe('attack: dashboard partyPost', () => {
    before(async () => {
        await cleanup();
        token = signAuthToken(await seedDashboardUser(DASH_PHONE));
    });

    after(async () => {
        await cleanup();
        await closePool();
        await dashboardPool.end();
    });

    it('auth: любой невалидный токен → 401, ничего не записано', async () => {
        const id = await seedDashboardUser(DASH_PHONE);
        const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
            'base64url',
        );
        const body = Buffer.from(JSON.stringify({ sub: id, exp: 9_999_999_999 })).toString(
            'base64url',
        );
        const ghostId = await seedDashboardUser(GHOST_PHONE);
        const ghostToken = signAuthToken(ghostId);
        await withClient((c) => c.query(`delete from dashboard_users where id = $1`, [ghostId]));
        for (const auth of [
            null,
            `Basic ${token}`,
            'Bearer a.b.c',
            `Bearer ${signAuthToken(id, -10)}`,
            `Bearer ${signJwt({ sub: id, exp: Math.floor(Date.now() / 1000) + 3600 }, `${jwtSecret()}x`)}`,
            `Bearer ${header}.${body}.`,
            `Bearer ${ghostToken}`,
        ]) {
            const res = await post({ ...BODY, id: AUTH_ID }, auth);
            assert.equal(res.status, 401, `[${auth}] → 401`);
            assert.deepEqual(
                await countRows(AUTH_ID),
                { party: 0, time: 0 },
                `[${auth}]: без записи`,
            );
        }
    });

    it('input: кривое тело → 400, в БД ничего', async () => {
        const { time: _t, ...noTime } = BODY;
        const { notes: _n, ...noNotes } = BODY;
        const { googleMapLink: _g, ...noMap } = BODY;
        const raws = ['', 'not json', '{', 'null', '[]', '"str"', '123', JSON.stringify([BODY])];
        const bodies: [string, unknown][] = [
            ['no notes', noNotes],
            ['no googleMapLink', noMap],
            ['no name', { ...noTime, name: undefined }],
            ['empty name', { ...BODY, name: '   ' }],
            ['price string', { ...BODY, price: '100' }],
            ['price negative', { ...BODY, price: -1 }],
            ['price null', { ...BODY, price: null }],
            ['type bad', { ...BODY, type: 'OWNED' }],
            ['type other', { ...BODY, type: 'public' }],
            ['location number', { ...BODY, location: 5 }],
            ['notes number', { ...BODY, notes: 5 }],
            ['time null', { ...BODY, time: null }],
            ['time string', { ...BODY, time: '2026-12-01' }],
            ['time no endsAt', { ...BODY, time: { startsAt: TIME.startsAt } }],
            ['startsAt garbage', { ...BODY, time: { ...TIME, startsAt: 'tomorrow' } }],
            ['startsAt feb 30', { ...BODY, time: { ...TIME, startsAt: '2026-02-30T18:00:00Z' } }],
            [
                'startsAt offset',
                { ...BODY, time: { ...TIME, startsAt: '2026-12-01T18:00:00+04:00' } },
            ],
            ['startsAt no tz', { ...BODY, time: { ...TIME, startsAt: '2026-12-01T18:00:00' } }],
            [
                'freeEntryBefore garbage',
                { ...BODY, time: { ...TIME, freeEntryBefore: '2026-13-01T00:00:00Z' } },
            ],
            ['guestlistAlertAt number', { ...BODY, time: { ...TIME, guestlistAlertAt: 123 } }],
            ['guestlistAlertAt null', { ...BODY, time: { ...TIME, guestlistAlertAt: null } }],
            [
                'time no guestlistAlertAt',
                { ...BODY, time: { startsAt: TIME.startsAt, endsAt: TIME.endsAt } },
            ],
            [
                'endsAt < startsAt',
                { ...BODY, time: { ...TIME, startsAt: TIME.endsAt, endsAt: TIME.startsAt } },
            ],
            [
                'endsAt < startsAt внутри секунды',
                {
                    ...BODY,
                    time: {
                        ...TIME,
                        startsAt: '2026-12-01T18:00:00.900Z',
                        endsAt: '2026-12-01T18:00:00.100Z',
                    },
                },
            ],
        ];
        const slugs = [
            '',
            'E2E_atk_pp_upper',
            `${BAD_ID}'; drop table party; --`,
            `${BAD_ID} `,
            `${BAD_ID}\n`,
            `${BAD_ID}-x`,
            'a'.repeat(101),
            `${BAD_ID}é`,
        ];
        for (const raw of raws) {
            const res = await postRaw(raw);
            assert.equal(res.status, 400, `raw ${JSON.stringify(raw)} → 400`);
        }
        for (const [label, body] of bodies) {
            const res = await post(body);
            assert.equal(res.status, 400, `${label} → 400`);
            assert.deepEqual(
                await countRows(BAD_ID),
                { party: 0, time: 0 },
                `${label}: без записи`,
            );
        }
        for (const id of slugs) {
            const res = await post({ ...BODY, id });
            assert.equal(res.status, 400, `slug ${JSON.stringify(id)} → 400`);
            assert.deepEqual(
                await countRows(id),
                { party: 0, time: 0 },
                `slug ${JSON.stringify(id)}`,
            );
        }
        assert.equal(
            (await dbOne<{ t: string }>(`select to_regclass('public.party')::text t`))?.t,
            'party',
        );
        assert.deepEqual(await countRows(BAD_ID), { party: 0, time: 0 });
    });

    it('input: NUL-байт в тексте → 400 (не 500), без записи', async () => {
        const res = await post({ ...BODY, id: BAD_ID, notes: 'a\u0000b' });
        assert.equal(res.status, 400, 'невалидный для pg текст → 400, не 500');
        assert.deepEqual(await countRows(BAD_ID), { party: 0, time: 0 });
    });

    it('inject: SQL-мета в текстовых полях хранится как есть, таблицы целы', async () => {
        const evil = {
            name: `'); drop table party; --`,
            location: `%L %s %I $1 \\' "`,
            googleMapLink: `https://x/?q=' or 1=1 --`,
            reelsUrl: `E'\\x00'`,
            notes: `🎉 '' ; delete from party_time; -- \\\\`,
        };
        const res = await post({ ...BODY, id: INJ_ID, ...evil });
        assert.equal(res.status, 200);
        const row = await dbOne(
            `select name, location, google_map_link "googleMapLink", reels_url "reelsUrl", notes
             from party where id = $1`,
            [INJ_ID],
        );
        assert.deepEqual(row, evil);
        for (const t of ['party', 'party_time', 'party_tables']) {
            assert.equal(
                (await dbOne<{ t: string }>(`select to_regclass($1)::text t`, [`public.${t}`]))?.t,
                t,
            );
        }
        assert.deepEqual(await countRows(INJ_ID), { party: 1, time: 1 });
    });

    const raceTimes = (n: number) =>
        Array.from({ length: n }, (_, i) => ({
            startsAt: `2026-12-${String(i + 1).padStart(2, '0')}T18:00:00.000Z`,
            endsAt: `2026-12-${String(i + 1).padStart(2, '0')}T23:00:00.000Z`,
            guestlistAlertAt: `2026-12-${String(i + 1).padStart(2, '0')}T12:00:00.000Z`,
        }));

    async function assertRace(
        id: string,
        statuses: PromiseSettledResult<Response>[],
    ): Promise<void> {
        for (const s of statuses) {
            assert.equal(s.status, 'fulfilled');
            if (s.status === 'fulfilled') assert.equal(s.value.status, 200);
        }
        assert.deepEqual(
            await countRows(id),
            { party: 1, time: 1 },
            `${id}: 1 party, 1 party_time`,
        );
    }

    it('race: 10 параллельных POST нового id с разным time → 1 party, 1 party_time', async () => {
        const times = raceTimes(10);
        const results = await Promise.allSettled(
            times.map((time, i) => post({ ...BODY, id: RACE_NEW_ID, name: `race ${i}`, time })),
        );
        await assertRace(RACE_NEW_ID, results);
        const p = await dbOne<{ name: string }>(`select name from party where id = $1`, [
            RACE_NEW_ID,
        ]);
        const t = await dbOne<{ s: Date }>(
            `select party_start_at s from party_time where party_id = $1`,
            [RACE_NEW_ID],
        );
        const winner = Number(p?.name.replace('race ', ''));
        assert.equal(
            t?.s.toISOString(),
            times[winner].startsAt,
            'party и party_time от одного победителя',
        );
    });

    it('race: 10 параллельных POST существующего id с разным time → 1 party, 1 party_time, marketing/tables целы', async () => {
        assert.equal((await post({ ...BODY, id: RACE_OLD_ID })).status, 200);
        const marketing = { image: 'e2e.jpg', message: 'e2e' };
        await withClient(async (c) => {
            await c.query(`update party set marketing_message = $1 where id = $2`, [
                marketing,
                RACE_OLD_ID,
            ]);
            await c.query(`insert into party_tables (party_id, map) values ($1, 'e2e map')`, [
                RACE_OLD_ID,
            ]);
        });
        const results = await Promise.allSettled(
            raceTimes(10).map((time, i) =>
                post({ ...BODY, id: RACE_OLD_ID, name: `race ${i}`, time }),
            ),
        );
        await assertRace(RACE_OLD_ID, results);
        const p = await dbOne<{ marketing_message: unknown }>(
            `select marketing_message from party where id = $1`,
            [RACE_OLD_ID],
        );
        assert.deepEqual(p?.marketing_message, marketing);
        assert.deepEqual(
            await dbQuery(`select map from party_tables where party_id = $1`, [RACE_OLD_ID]),
            [{ map: 'e2e map' }],
        );
    });

    it('race: смесь с time и без time на новый id → 1 party, ≤1 party_time', async () => {
        const times = raceTimes(10);
        const results = await Promise.allSettled(
            times.map((time, i) => {
                const { time: _t, ...noTime } = BODY;
                return post(
                    i % 2 ? { ...noTime, id: RACE_MIX_ID } : { ...BODY, id: RACE_MIX_ID, time },
                );
            }),
        );
        await assertRace(RACE_MIX_ID, results);
    });
});
