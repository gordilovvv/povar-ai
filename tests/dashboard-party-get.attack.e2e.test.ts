// Adversary e2e для partyGetHandler (GET /parties/:id) + лateral-time в GET /parties.
// Контракт (из задачи):
//   auth: нет/Basic/битая подпись/alg:none/протухший/удалённый юзер → 401, тела нет;
//   id: пустой/пробелы/control → 400; несуществующий / SQL-мета / traversal → 404, не 500,
//       таблицы целы; >512 символов → 400; чужие данные не отдаются;
//   party с несколькими party_time → одна строка, самая ранняя по party_start_at (все 4 поля),
//       guestCount = факт БД (не умножается на число party_time); в списке та же party один раз;
//   keyset-пагинация limit=1 обходит каждую party ровно один раз.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ulid } from 'ulid';
import { pool as dashboardPool } from '#Dashboard/Db/Pool.js';
import { signJwt } from '#Dashboard/Lib/Jwt.js';
import { dashboardFetch } from '#Dashboard/Router.js';
import { toDateTime } from '#Lib/Fmt.js';
import { closePool, dbOne, seedDashboardUser, signAuthToken, withClient } from './helpers/e2e.ts';

const DASH_PHONE = 'E2E_atk_pg_user';
const GHOST_PHONE = 'E2E_atk_pg_ghost';
const HOUR_MS = 3_600_000;
const NOW = Date.now();
const RUN = ulid().toLowerCase();

const MULTI_ID = `e2e_atk_pg_multi_${RUN}`;
const NOTIME_ID = `e2e_atk_pg_notime_${RUN}`;
const GUEST_PHONE = 'E2E_atk_pgg_0';
const OWN_IDS = [MULTI_ID, NOTIME_ID];

// Две party_time: поздняя вставлена ПЕРВОЙ, чтобы «первая попавшаяся» ≠ «самая ранняя».
const LATE = {
    start: NOW + 48 * HOUR_MS,
    end: NOW + 54 * HOUR_MS,
    free: NOW + 49 * HOUR_MS,
    alert: NOW + 40 * HOUR_MS,
};
const EARLY = {
    start: NOW + 24 * HOUR_MS,
    end: NOW + 30 * HOUR_MS,
    free: null,
    alert: NOW + 20 * HOUR_MS,
};
const isoSec = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString();

interface PartyTime {
    startsAt: string | null;
    endsAt: string | null;
    freeEntryBefore: string | null;
    guestlistAlertAt: string | null;
}
interface PartyBody {
    id: string;
    guestCount: number;
    time: PartyTime | null;
}

let token = '';

function jwtSecret(): string {
    const s = process.env.JWT_SECRET;
    if (!s) throw new Error('JWT_SECRET missing');
    return s;
}

async function partyReq(rawPath: string, auth = `Bearer ${token}`): Promise<Response> {
    const headers: Record<string, string> = {};
    if (auth) headers.authorization = auth;
    return dashboardFetch(new Request(`http://dashboard/parties/${rawPath}`, { headers }));
}

async function listReq(query: string): Promise<Response> {
    return dashboardFetch(
        new Request(`http://dashboard/parties?${query}`, {
            headers: { authorization: `Bearer ${token}` },
        }),
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
            `insert into party (id, name, location, type, price, google_map_link)
             values ($1, 'Atk multi', 'Atk loc', 'owned', 250, 'https://maps/atk')`,
            [MULTI_ID],
        );
        await client.query(
            `insert into party (id, name, location, type) values ($1, 'Atk notime', 'Atk loc', 'invited')`,
            [NOTIME_ID],
        );
        for (const t of [LATE, EARLY]) {
            await client.query(
                `insert into party_time (party_id, party_start_at, party_end_at, free_entry_before, guestlist_alert_at)
                 values ($1, $2, $3, $4, $5)`,
                [
                    MULTI_ID,
                    toDateTime(new Date(t.start)),
                    toDateTime(new Date(t.end)),
                    t.free === null ? null : toDateTime(new Date(t.free)),
                    toDateTime(new Date(t.alert)),
                ],
            );
        }
        const guestId = ulid();
        await client.query(
            `insert into guests (id, wa_phone, first_name, last_name, instagram)
             values ($1, $2, 'A', 'B', null)`,
            [guestId, GUEST_PHONE],
        );
        await client.query(
            `insert into party_guestlist (party_id, guest_id, joined_at) values ($1, $2, $3)`,
            [MULTI_ID, guestId, toDateTime(new Date(NOW))],
        );
    });
}

async function tablesIntact(): Promise<void> {
    for (const t of ['party', 'party_time', 'party_guestlist', 'guests']) {
        const row = await dbOne<{ reg: string | null }>(`select to_regclass($1) as reg`, [t]);
        assert.equal(row?.reg, t, `таблица ${t} цела`);
    }
    const mine = await dbOne<{ n: string }>(
        `select count(*)::text n from party where id = any($1)`,
        [OWN_IDS],
    );
    assert.equal(mine?.n, '2', 'мои party на месте');
}

describe('attack: dashboard partyGet', () => {
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

    it('auth: нет заголовка / Basic / битая подпись → 401, тело без данных', async () => {
        const good = token;
        const tampered = `${good.slice(0, -2)}${good.endsWith('a') ? 'b' : 'a'}`;
        for (const auth of ['', 'Basic YWRtaW46YWRtaW4=', `Bearer ${tampered}`, 'Bearer ']) {
            const res = await partyReq(MULTI_ID, auth);
            assert.equal(res.status, 401, `auth=${JSON.stringify(auth)} → 401`);
            const text = await res.text();
            assert.ok(!text.includes(MULTI_ID), 'в теле 401 нет данных вечеринки');
        }
    });

    it('auth: alg:none / протухший / удалённый юзер → 401', async () => {
        const userId = await seedDashboardUser(DASH_PHONE);
        const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
            'base64url',
        );
        const body = Buffer.from(
            JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 3600 }),
        ).toString('base64url');
        assert.equal((await partyReq(MULTI_ID, `Bearer ${header}.${body}.`)).status, 401);

        const expired = signJwt(
            { sub: userId, exp: Math.floor(Date.now() / 1000) - 10 },
            jwtSecret(),
        );
        assert.equal((await partyReq(MULTI_ID, `Bearer ${expired}`)).status, 401);

        const ghostId = await seedDashboardUser(GHOST_PHONE);
        const ghostToken = signAuthToken(ghostId);
        await withClient((c) => c.query(`delete from dashboard_users where id = $1`, [ghostId]));
        assert.equal((await partyReq(MULTI_ID, `Bearer ${ghostToken}`)).status, 401);
    });

    // ---------- кривой id ----------

    it('id: несуществующий → 404 {error:not_found}, не 500', async () => {
        const res = await partyReq(`e2e_atk_pg_missing_${RUN}`);
        assert.equal(res.status, 404);
        assert.deepEqual(await res.json(), { error: 'not_found' });
    });

    // Сырые ' ' / '\t' не берём: URL-парсер срезает хвостовые пробелы и путь становится /parties/ (список).
    it('id: пробелы / control-символы (percent-encoded) → 400 или 404, никогда 200/500', async () => {
        for (const raw of ['%20', '%20%20%20', '%09', '%0A', '%00', '%7F', '%20%09%20']) {
            const res = await partyReq(raw);
            assert.ok(
                res.status === 400 || res.status === 404,
                `id=${JSON.stringify(raw)} → ${res.status}, ожидали 400/404`,
            );
        }
    });

    it('id: длиннее 512 → 400, не 500 и не запрос в БД', async () => {
        const res = await partyReq('a'.repeat(513));
        assert.equal(res.status, 400);
        const huge = await partyReq(`${MULTI_ID}${'x'.repeat(5000)}`);
        assert.equal(huge.status, 400);
    });

    it('id: SQL-мета / кавычки / traversal / wildcard → 404, таблицы целы, чужого не отдаёт', async () => {
        const evil = [
            encodeURIComponent(`${MULTI_ID}'; drop table party_time; --`),
            encodeURIComponent(`' or 1=1 --`),
            `${MULTI_ID}%27`,
            '%25', // '%' как like-wildcard
            '_',
            encodeURIComponent('%'),
            '..%2F..%2Fchats',
            encodeURIComponent(`${MULTI_ID}\u0000`),
            encodeURIComponent('e2e_atk_pg_multi_%'),
        ];
        for (const raw of evil) {
            const res = await partyReq(raw);
            assert.ok(
                res.status === 400 || res.status === 404,
                `id=${raw} → ${res.status}, ожидали 400/404`,
            );
        }
        await tablesIntact();
    });

    it('id: padding пробелами вокруг существующего id → если 200, то ровно моя party', async () => {
        const res = await partyReq(`%20${MULTI_ID}%20`);
        assert.notEqual(res.status, 500);
        if (res.status === 200) {
            assert.equal(((await res.json()) as PartyBody).id, MULTI_ID);
        }
    });

    // Открытый вопрос (контракт молчит): itty-router не декодирует path-параметры, %5F ищется буквально → 404.
    it('id: percent-encoded форма существующего id (%5F вместо _) резолвится в ту же party', {
        todo: 'router не декодирует :id — решение за владельцем контракта',
    }, async () => {
        const res = await partyReq(MULTI_ID.replaceAll('_', '%5F'));
        assert.equal(res.status, 200, 'encoded id должен декодироваться в тот же ресурс');
        assert.equal(((await res.json()) as PartyBody).id, MULTI_ID);
    });

    it('id: без id (/parties/) и с пустым сегментом (/parties//) → не 500', async () => {
        for (const raw of ['', '/']) {
            const res = await partyReq(raw);
            assert.notEqual(res.status, 500, `/parties/${raw} → ${res.status}`);
        }
    });

    // ---------- несколько party_time ----------

    it('time: две party_time → ровно самая ранняя по party_start_at, все 4 поля = факт БД', async () => {
        const res = await partyReq(MULTI_ID);
        assert.equal(res.status, 200);
        const body = (await res.json()) as PartyBody;

        assert.deepEqual(body.time, {
            startsAt: isoSec(EARLY.start),
            endsAt: isoSec(EARLY.end),
            freeEntryBefore: null,
            guestlistAlertAt: isoSec(EARLY.alert),
        });

        const db = await dbOne<{
            s: Date;
            e: Date;
            f: Date | null;
            a: Date;
            n: string;
        }>(
            `select t.party_start_at s, t.party_end_at e, t.free_entry_before f, t.guestlist_alert_at a,
                (select count(*)::text from party_guestlist g where g.party_id = $1) n
             from party_time t where t.party_id = $1 order by t.party_start_at asc limit 1`,
            [MULTI_ID],
        );
        assert.ok(db);
        assert.equal(body.time?.startsAt, db.s.toISOString());
        assert.equal(body.time?.endsAt, db.e.toISOString());
        assert.equal(body.time?.freeEntryBefore, db.f ? db.f.toISOString() : null);
        assert.equal(body.time?.guestlistAlertAt, db.a.toISOString());
        assert.equal(String(body.guestCount), db.n, 'guestCount = факт БД, не ×2 от party_time');
        assert.equal(db.n, '1');
    });

    it('time: без party_time → time null (не объект из null-ов), guestCount 0', async () => {
        const res = await partyReq(NOTIME_ID);
        assert.equal(res.status, 200);
        const body = (await res.json()) as PartyBody;
        assert.equal(body.time, null);
        assert.equal(body.guestCount, 0);
        const db = await dbOne<{ n: string }>(
            `select count(*)::text n from party_time where party_id = $1`,
            [NOTIME_ID],
        );
        assert.equal(db?.n, '0', 'в БД party_time действительно нет');
    });

    // ---------- список: lateral + keyset ----------

    it('list: keyset limit=1 обходит каждую party ровно один раз; multi — один раз с ранним time', async () => {
        const seen: string[] = [];
        let multi: PartyBody | null = null;
        let cursor: string | null = null;
        for (let page = 0; page < 500; page++) {
            const res = await listReq(
                cursor ? `limit=1&cursor=${encodeURIComponent(cursor)}` : 'limit=1',
            );
            assert.equal(res.status, 200);
            const json = (await res.json()) as { items: PartyBody[]; nextCursor: string | null };
            for (const item of json.items) {
                seen.push(item.id);
                if (item.id === MULTI_ID) multi = item;
            }
            cursor = json.nextCursor;
            if (cursor === null) break;
        }
        assert.equal(new Set(seen).size, seen.length, 'нет дублей при обходе limit=1');
        assert.ok(seen.includes(MULTI_ID) && seen.includes(NOTIME_ID), 'обе мои party найдены');

        const stable = await dbOne<{ n: string }>(
            `select count(*)::text n from party where id not ilike 'e2e_%'`,
        );
        const seenStable = seen.filter((id) => !id.toLowerCase().startsWith('e2e_')).length;
        assert.equal(String(seenStable), stable?.n, 'обход покрыл все не-E2E party ровно по разу');

        assert.ok(multi);
        assert.equal(multi.time?.startsAt, isoSec(EARLY.start), 'в списке — ранняя party_time');
        assert.equal(multi.time?.endsAt, isoSec(EARLY.end));
        assert.equal(multi.guestCount, 1);
    });
});
