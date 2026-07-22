// Adversary e2e для partiesGetListHandler + partyGetGuestlistListHandler.
// Контракт (из задачи):
//   auth: нет/битый/alg:none/протухший/удалённый юзер → 401 на ОБЕ ручки;
//   cursor: мусор/не-JSON/без полей/неверные типы → 400 (zod decode), НЕ 500;
//   SQL-инъекция в :id и cursor → не 500, таблицы целы;
//   limit: отрицательный/0/гигантский/нечисловой → 200 clamp [1..100];
//   guestCount не раздувается дублями party_time.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ulid } from 'ulid';
import { pool as dashboardPool } from '#Dashboard/Db/Pool.js';
import { signJwt } from '#Dashboard/Lib/Jwt.js';
import { dashboardFetch } from '#Dashboard/Router.js';
import { toDateTime } from '#Lib/Fmt.js';
import { closePool, dbOne, seedDashboardUser, signAuthToken, withClient } from './helpers/e2e.ts';

const DASH_PHONE = 'E2E_atk_pt_user';
const GHOST_PHONE = 'E2E_atk_pt_ghost';
const HOUR_MS = 3_600_000;
const NOW = Date.now();

const ACTIVE_ID = `E2E_atk_pt_active_${ulid()}`;
const GUEST_PHONE = 'E2E_atk_ptg_0';
const OWN_IDS = [ACTIVE_ID];

let token = '';

function jwtSecret(): string {
    const s = process.env.JWT_SECRET;
    if (!s) throw new Error('JWT_SECRET missing');
    return s;
}

function craftCursor(payload: unknown): string {
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

async function partiesReq(query: string, auth = `Bearer ${token}`): Promise<Response> {
    const headers: Record<string, string> = {};
    if (auth) headers.authorization = auth;
    return dashboardFetch(new Request(`http://dashboard/parties?${query}`, { headers }));
}

async function guestlistReq(id: string, auth = `Bearer ${token}`): Promise<Response> {
    const headers: Record<string, string> = {};
    if (auth) headers.authorization = auth;
    return dashboardFetch(
        new Request(`http://dashboard/parties/${encodeURIComponent(id)}/guestlist`, { headers }),
    );
}

async function cleanup(): Promise<void> {
    await withClient(async (client) => {
        await client.query(`delete from party_guestlist where party_id = any($1)`, [OWN_IDS]);
        await client.query(`delete from party_time where party_id = any($1)`, [OWN_IDS]);
        await client.query(`delete from party where id = any($1)`, [OWN_IDS]);
        await client.query(`delete from guests where wa_phone = $1`, [GUEST_PHONE]);
        await client.query(`delete from dashboard_users where phone_number = any($1)`, [
            [DASH_PHONE, GHOST_PHONE],
        ]);
    });
}

async function seed(): Promise<void> {
    await withClient(async (client) => {
        await client.query(
            `insert into party (id, name, location, type) values ($1, $2, $3, 'owned')`,
            [ACTIVE_ID, 'Atk active', 'Atk loc'],
        );
        // Два party_time на одну party — проверяем что guestCount не раздувается и строка не двоится.
        await client.query(`insert into party_time (party_id, party_start_at) values ($1, $2)`, [
            ACTIVE_ID,
            toDateTime(new Date(NOW - 2 * HOUR_MS)),
        ]);
        await client.query(`insert into party_time (party_id, party_start_at) values ($1, $2)`, [
            ACTIVE_ID,
            toDateTime(new Date(NOW - 1 * HOUR_MS)),
        ]);
        const guestId = ulid();
        await client.query(
            `insert into guests (id, wa_phone, first_name, last_name, instagram)
             values ($1, $2, $3, $4, $5)`,
            [guestId, GUEST_PHONE, 'A', 'B', null],
        );
        await client.query(
            `insert into party_guestlist (party_id, guest_id, joined_at) values ($1, $2, $3)`,
            [ACTIVE_ID, guestId, toDateTime(new Date(NOW))],
        );
    });
}

async function tablesIntact(): Promise<void> {
    for (const t of ['party', 'party_time', 'party_guestlist', 'guests']) {
        const row = await dbOne<{ reg: string | null }>(`select to_regclass($1) as reg`, [t]);
        assert.equal(row?.reg, t, `таблица ${t} цела`);
    }
    const mine = await dbOne<{ n: string }>(`select count(*)::text n from party where id = $1`, [
        ACTIVE_ID,
    ]);
    assert.equal(mine?.n, '1', 'моя party на месте');
}

describe('attack: dashboard parties + guestlist', () => {
    before(async () => {
        await cleanup();
        const userId = await seedDashboardUser(DASH_PHONE);
        token = signAuthToken(userId);
        await seed();
    });

    after(async () => {
        await cleanup();
        await closePool();
        await dashboardPool.end();
    });

    // ---------- AUTH ----------

    it('auth: нет заголовка → 401 обе ручки', async () => {
        assert.equal((await partiesReq('limit=5', '')).status, 401, 'parties без токена');
        assert.equal((await guestlistReq(ACTIVE_ID, '')).status, 401, 'guestlist без токена');
    });

    it('auth: Basic-схема → 401', async () => {
        const basic = 'Basic YWRtaW46YWRtaW4=';
        assert.equal((await partiesReq('limit=5', basic)).status, 401);
        assert.equal((await guestlistReq(ACTIVE_ID, basic)).status, 401);
    });

    it('auth: подделанная подпись → 401', async () => {
        const good = signAuthToken(await seedDashboardUser(DASH_PHONE));
        const tampered = `${good.slice(0, -2)}${good.endsWith('a') ? 'b' : 'a'}`;
        assert.equal((await partiesReq('limit=5', `Bearer ${tampered}`)).status, 401);
        assert.equal((await guestlistReq(ACTIVE_ID, `Bearer ${tampered}`)).status, 401);
    });

    it('auth: alg:none без подписи → 401', async () => {
        const userId = await seedDashboardUser(DASH_PHONE);
        const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
            'base64url',
        );
        const body = Buffer.from(
            JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 3600 }),
        ).toString('base64url');
        const forged = `${header}.${body}.`;
        assert.equal((await partiesReq('limit=5', `Bearer ${forged}`)).status, 401);
        assert.equal((await guestlistReq(ACTIVE_ID, `Bearer ${forged}`)).status, 401);
    });

    it('auth: протухший токен → 401', async () => {
        const userId = await seedDashboardUser(DASH_PHONE);
        const expired = signJwt(
            { sub: userId, exp: Math.floor(Date.now() / 1000) - 10 },
            jwtSecret(),
        );
        assert.equal((await partiesReq('limit=5', `Bearer ${expired}`)).status, 401);
        assert.equal((await guestlistReq(ACTIVE_ID, `Bearer ${expired}`)).status, 401);
    });

    it('auth: валидная подпись на удалённого юзера → 401', async () => {
        const ghostId = await seedDashboardUser(GHOST_PHONE);
        const ghostToken = signAuthToken(ghostId);
        await withClient((c) => c.query(`delete from dashboard_users where id = $1`, [ghostId]));
        assert.equal((await partiesReq('limit=5', `Bearer ${ghostToken}`)).status, 401);
        assert.equal((await guestlistReq(ACTIVE_ID, `Bearer ${ghostToken}`)).status, 401);
    });

    // ---------- SQL-инъекция ----------

    it('inj: :id с SQL-метой → не 500, таблицы целы', async () => {
        const evil = `${ACTIVE_ID}'; drop table party_guestlist; --`;
        const res = await guestlistReq(evil);
        assert.notEqual(res.status, 500, 'инъекция в id не роняет');
        assert.ok(res.status === 200 || res.status === 400, `id-инъекция → ${res.status}`);
        await tablesIntact();
    });

    it('inj: cursor как сырой SQL (не base64/JSON) → 400, не 500', async () => {
        const res = await partiesReq(
            `limit=5&cursor=${encodeURIComponent("1'; drop table party; --")}`,
        );
        assert.equal(res.status, 400, 'кривой cursor → 400');
        await tablesIntact();
    });

    // ---------- cursor decode ----------

    it('cursor: мусор / не-JSON base64 / без полей / неверный тип → 400', async () => {
        const bad: string[] = [
            'not+base64+json',
            Buffer.from('not json at all').toString('base64url'),
            craftCursor({ startsAt: null }), // нет bucket/id
            craftCursor({ bucket: '2', startsAt: null, id: 'x' }), // bucket строкой
            craftCursor({ bucket: 2, startsAt: null, id: '' }), // id пустой
        ];
        for (const c of bad) {
            const res = await partiesReq(`limit=5&cursor=${encodeURIComponent(c)}`);
            assert.equal(res.status, 400, `битый cursor → 400: ${c}`);
        }
        await tablesIntact();
    });

    it('cursor(ДЫРА): startsAt не-дата при bucket=2 → должно быть 400, а не 500', async () => {
        const c = craftCursor({ bucket: 2, startsAt: 'garbage-not-a-date', id: 'x' });
        const res = await partiesReq(`limit=5&cursor=${encodeURIComponent(c)}`);
        assert.notEqual(res.status, 500, 'form-valid cursor с кривой датой не должен давать 500');
        assert.equal(res.status, 400, 'кривая startsAt → 400 (zod-декод)');
        await tablesIntact();
    });

    it('cursor(ДЫРА): bucket вне диапазона int4 → должно быть 400, а не 500', async () => {
        const c = craftCursor({ bucket: 2147483648, startsAt: null, id: 'x' });
        const res = await partiesReq(`limit=5&cursor=${encodeURIComponent(c)}`);
        assert.notEqual(res.status, 500, 'bucket вне int4 не должен давать 500');
        assert.ok(res.status === 400 || res.status === 200, `bucket out-of-range → ${res.status}`);
        await tablesIntact();
    });

    // ---------- limit ----------

    it('limit: отрицательный/0/гигант/нечисловой/дробный → 200, не падает', async () => {
        for (const l of ['-5', '0', '999999999', 'abc', '2.5', "1'; drop table party; --"]) {
            const res = await partiesReq(`limit=${encodeURIComponent(l)}`);
            assert.equal(res.status, 200, `limit=${l} → 200`);
        }
        await tablesIntact();
    });

    // ---------- guestCount / целостность ----------

    it('guestCount: дубли party_time не раздувают счёт и не двоят строку', async () => {
        const res = await partiesReq('limit=100');
        assert.equal(res.status, 200);
        const body = (await res.json()) as {
            items: { id: string; guestCount: number }[];
        };
        const mine = body.items.filter((i) => i.id === ACTIVE_ID);
        assert.equal(mine.length, 1, 'party с 2 party_time не двоится в списке');

        const dbCount = await dbOne<{ n: string }>(
            `select count(*)::text n from party_guestlist where party_id = $1`,
            [ACTIVE_ID],
        );
        assert.equal(String(mine[0]?.guestCount), dbCount?.n, 'guestCount = факт БД');
        assert.equal(dbCount?.n, '1', 'ровно один гость в БД');
    });

    // ---------- новые поля (аддитивка): friends / price ----------

    it('friends: спецсимволы (запятая/кавычки/скобки/бэкслеш/SQL-мета) — маппинг байт-в-байт с БД', async () => {
        const nasty = [
            'a,b',
            'has"quote',
            'brace}{',
            'back\\slash',
            'semi;colon',
            "q'; drop--",
            '',
        ];
        await withClient((c) =>
            c.query(
                `update party_guestlist set friends = $2
                 where party_id = $1 and guest_id = (
                    select id from guests where wa_phone = $3)`,
                [ACTIVE_ID, nasty, GUEST_PHONE],
            ),
        );
        const res = await guestlistReq(ACTIVE_ID);
        assert.equal(res.status, 200);
        const body = (await res.json()) as { friends: string[] }[];
        assert.equal(body.length, 1, 'ровно один гость');

        const dbRow = await dbOne<{ friends: string[] | null }>(
            `select friends from party_guestlist where party_id = $1 and guest_id = (
                select id from guests where wa_phone = $2)`,
            [ACTIVE_ID, GUEST_PHONE],
        );
        // Сверка НАПРЯМУЮ с БД: спецсимволы уходят как значения, не как SQL; таблица цела.
        assert.deepEqual(
            body[0]?.friends,
            dbRow?.friends,
            'API friends == факт БД (без искажений)',
        );
        await tablesIntact();
    });

    it('friends: NULL и пустой массив → []', async () => {
        await withClient((c) =>
            c.query(
                `update party_guestlist set friends = null
                 where party_id = $1 and guest_id = (
                    select id from guests where wa_phone = $2)`,
                [ACTIVE_ID, GUEST_PHONE],
            ),
        );
        let body = (await (await guestlistReq(ACTIVE_ID)).json()) as { friends: string[] }[];
        assert.deepEqual(body[0]?.friends, [], 'friends NULL → []');

        await withClient((c) =>
            c.query(
                `update party_guestlist set friends = '{}'::text[]
                 where party_id = $1 and guest_id = (
                    select id from guests where wa_phone = $2)`,
                [ACTIVE_ID, GUEST_PHONE],
            ),
        );
        body = (await (await guestlistReq(ACTIVE_ID)).json()) as { friends: string[] }[];
        assert.deepEqual(body[0]?.friends, [], 'friends {} → []');
    });

    it('price: реальный numeric с копейками не теряется грубо; NULL → null (не 0/NaN)', async () => {
        await withClient((c) =>
            c.query(`update party set price = '4999.99' where id = $1`, [ACTIVE_ID]),
        );
        const readPrice = async (): Promise<number | null | undefined> => {
            const b = (await (await partiesReq('limit=100')).json()) as {
                items: { id: string; price: number | null }[];
            };
            return b.items.find((i) => i.id === ACTIVE_ID)?.price;
        };
        let price = await readPrice();
        const dbPrice = await dbOne<{ price: string }>(
            `select price::text as price from party where id = $1`,
            [ACTIVE_ID],
        );
        assert.equal(typeof price, 'number', 'price → number');
        assert.equal(Number(dbPrice?.price), price, 'price == факт БД (без грубой потери)');

        await withClient((c) =>
            c.query(`update party set price = null where id = $1`, [ACTIVE_ID]),
        );
        price = await readPrice();
        assert.equal(price, null, 'price NULL → null (не 0/NaN)');
    });
});
