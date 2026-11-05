// Задача модуля (guestsGetStatisticHandler + guestsGetListHandler):
//   вход  → GET /guests/statistic ; GET /guests?limit&lastId&marketing  (Bearer JWT, гейт withAuthorization)
//   выход → statistic: { guestsCount, maleCount, femaleCount } = факт count(*) по guests
//           list: { id, phone, firstName, lastName, instagram, gender, marketing }[] — keyset id > lastId, order by id asc
//           marketing — опц. фильтр enabled|disabled|blocked_by_user, без него/невалидный — все
//           limit 1..100, default 30, клампится
//   бюджет → сеть/БД не меряем, только measure()
//   негатив → нет/битый токен → 401 (в .attack)

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ulid } from 'ulid';
import { pool as dashboardPool } from '#Dashboard/Db/Pool.js';
import { dashboardFetch } from '#Dashboard/Router.js';
import {
    closePool,
    dbOne,
    measure,
    seedDashboardUser,
    signAuthToken,
    withClient,
} from './helpers/e2e.ts';

const DASH_PHONE = 'E2E_guests_user';
const GUESTS = [
    {
        id: ulid(),
        phone: 'E2E_gs_0',
        first: 'Ann',
        last: 'Male',
        insta: 'https://insta/0',
        gender: 'male',
        marketing: 'enabled',
    },
    {
        id: ulid(),
        phone: 'E2E_gs_1',
        first: 'Bea',
        last: 'Female',
        insta: null,
        gender: 'female',
        marketing: 'disabled',
    },
    {
        id: ulid(),
        phone: 'E2E_gs_2',
        first: null,
        last: null,
        insta: null,
        gender: null,
        marketing: 'blocked_by_user',
    },
].sort((a, b) => (a.id < b.id ? -1 : 1));
const GUEST_PHONES = GUESTS.map((g) => g.phone);

type GuestsList = {
    id: string;
    phone: string | null;
    firstName: string | null;
    lastName: string | null;
    instagram: string | null;
    gender: 'male' | 'female' | null;
    marketing: 'enabled' | 'disabled' | 'blocked_by_user' | null;
}[];

interface Statistic {
    guestsCount: number;
    maleCount: number;
    femaleCount: number;
}

let token = '';

async function get<T>(path: string): Promise<T> {
    const { result } = await measure(`GET ${path}`, () =>
        dashboardFetch(
            new Request(`http://dashboard${path}`, {
                headers: { authorization: `Bearer ${token}` },
            }),
        ),
    );
    assert.equal(result.status, 200, `${path} → 200`);
    return (await result.json()) as T;
}

async function cleanup(): Promise<void> {
    await withClient(async (client) => {
        await client.query(`delete from guests where wa_phone = any($1)`, [GUEST_PHONES]);
        await client.query(`delete from dashboard_users where phone_number = $1`, [DASH_PHONE]);
    });
}

async function dbStatistic(): Promise<Statistic> {
    const row = await dbOne<{ g: string; m: string; f: string }>(
        `select (select count(*) from guests) g,
                (select count(*) from guests where gender = 'male') m,
                (select count(*) from guests where gender = 'female') f`,
    );
    return { guestsCount: Number(row?.g), maleCount: Number(row?.m), femaleCount: Number(row?.f) };
}

describe('e2e: dashboard guests', () => {
    before(async () => {
        await cleanup();
        token = signAuthToken(await seedDashboardUser(DASH_PHONE));
    });

    after(async () => {
        await cleanup();
        await closePool();
        await dashboardPool.end();
    });

    it('e2e: guests statistic — счётчики совпадают с БД, сид двигает каждый на 1', async () => {
        const beforeSeed = await get<Statistic>('/guests/statistic');
        assert.deepEqual(beforeSeed, await dbStatistic(), 'до сида — факт из БД');

        await withClient(async (client) => {
            for (const g of GUESTS) {
                await client.query(
                    `insert into guests (id, wa_phone, first_name, last_name, instagram, gender, marketing)
                     values ($1, $2, $3, $4, $5, $6, $7)`,
                    [g.id, g.phone, g.first, g.last, g.insta, g.gender, g.marketing],
                );
            }
        });

        const afterSeed = await get<Statistic>('/guests/statistic');
        assert.deepEqual(afterSeed, await dbStatistic(), 'после сида — факт из БД');
        assert.deepEqual(
            afterSeed,
            {
                guestsCount: beforeSeed.guestsCount + 3,
                maleCount: beforeSeed.maleCount + 1,
                femaleCount: beforeSeed.femaleCount + 1,
            },
            'gender null входит только в guestsCount',
        );
    });

    it('e2e: guests list — keyset после lastId, маппинг полей 1:1 с БД', async () => {
        const [first, second, third] = GUESTS;
        const page = await get<GuestsList>(`/guests?lastId=${first.id}&limit=2`);
        assert.deepEqual(
            page,
            [second, third].map((g) => ({
                id: g.id,
                phone: g.phone,
                firstName: g.first,
                lastName: g.last,
                instagram: g.insta,
                gender: g.gender,
                marketing: g.marketing,
            })),
            'ровно 2 гостя строго после lastId, по id asc',
        );

        const tail = await get<GuestsList>(`/guests?lastId=${third.id}`);
        const dbTail = await dbOne<{ n: string }>(`select count(*) n from guests where id > $1`, [
            third.id,
        ]);
        assert.equal(tail.length, Number(dbTail?.n), 'после последнего — столько, сколько в БД');
    });

    it('e2e: guests list — limit default 30, клампится в 1..100, порядок id asc', async () => {
        const total = (await dbStatistic()).guestsCount;

        const byDefault = await get<GuestsList>('/guests');
        assert.equal(byDefault.length, Math.min(30, total));
        const ids = byDefault.map((g) => g.id);
        assert.deepEqual(ids, [...ids].sort(), 'id по возрастанию');
        const dbFirst = await dbOne<{ id: string }>(
            `select id from guests order by id asc limit 1`,
        );
        assert.equal(ids[0], dbFirst?.id, 'первая страница начинается с минимального id');

        assert.equal((await get<GuestsList>('/guests?limit=1000')).length, Math.min(100, total));
        assert.equal((await get<GuestsList>('/guests?limit=0')).length, Math.min(1, total));
        assert.equal((await get<GuestsList>('/guests?limit=abc')).length, Math.min(30, total));
    });

    it('e2e: guests list — фильтр marketing отдаёт только нужный статус, невалидный → все', async () => {
        for (const status of ['enabled', 'disabled', 'blocked_by_user'] as const) {
            const page = await get<GuestsList>(`/guests?marketing=${status}&limit=100`);
            assert.ok(page.length > 0, `${status}: сид гарантирует минимум одного`);
            assert.ok(
                page.every((g) => g.marketing === status),
                `${status}: все строки с этим статусом`,
            );
            const dbCount = await dbOne<{ n: string }>(
                `select count(*) n from (select 1 from guests where marketing = $1 order by id asc limit 100) t`,
                [status],
            );
            assert.equal(page.length, Number(dbCount?.n), `${status}: размер страницы = факт БД`);
        }

        const seeded = new Set(GUESTS.map((g) => g.id));
        const [first] = GUESTS;
        const afterFirst = await get<GuestsList>(`/guests?marketing=disabled&lastId=${first.id}`);
        assert.deepEqual(
            afterFirst.filter((g) => seeded.has(g.id)).map((g) => g.id),
            GUESTS.filter((g) => g.marketing === 'disabled' && g.id > first.id).map((g) => g.id),
            'фильтр и keyset работают вместе',
        );

        const total = (await dbStatistic()).guestsCount;
        assert.equal(
            (await get<GuestsList>('/guests?marketing=whatever')).length,
            Math.min(30, total),
            'невалидный фильтр → без фильтра',
        );
    });
});
