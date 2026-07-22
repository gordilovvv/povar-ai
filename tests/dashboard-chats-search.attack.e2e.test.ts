// Attack-приёмка: query-параметр phone в GET /chats (chatsGetListHandler).
// Каждая проба бьёт напрямую в dashboardFetch и сверяется с БД (dbOne/dbQuery).
// Чистим строго свои строки (список E2E_PHONES + dashboard-user).
//
// Векторы: auth (нет/Basic/битая подпись/протухший/валидный на удалённого) —
//          фильтр не обходит гейт; SQL-инъекция в phone (мета уходит значением,
//          таблица цела); like-метасимволы %/_ НЕ работают как wildcards
//          (дискриминатор: raw-LIKE нашёл бы чат, digits-only — нет);
//          кривой ввод (гигантская строка, unicode-цифры, «+» без цифр,
//          отрицательный limit, битый cursor вместе с phone).
// Гонки неприменимы — ручка read-only.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ulid } from 'ulid';
import { pool as dashboardPool } from '#Dashboard/Db/Pool.js';
import { signJwt } from '#Dashboard/Lib/Jwt.js';
import { dashboardFetch } from '#Dashboard/Router.js';
import { toDateTime } from '#Lib/Fmt.js';
import {
    closePool,
    dbOne,
    dbQuery,
    seedDashboardUser,
    signAuthToken,
    withClient,
} from './helpers/e2e.ts';

const DASH_PHONE = 'E2E_atk_cs_user';

// Чаты с кодом 999 (в проде гости UAE — коллизий нет).
const CHAT_A = '79990002001'; // для инъекции-с-цифрами и точного/like-поиска
const CHAT_B = '79990002002';
// Дискриминатор для %/_ : между двумя «999»-группами ровно один символ '5'.
// raw-LIKE «7999_999» / «7999%999» матчит WILD, digits-only «7999999» — нет.
const WILD = '79995999';
const E2E_PHONES = [CHAT_A, CHAT_B, WILD];
const LAST_AT = '2032-07-01T10:00:00.000Z';

interface ListResponse {
    items: { phone: string }[];
    nextCursor: string | null;
}

let token = '';
let userId = '';

function req(query: string, headers: Record<string, string> = {}): Request {
    return new Request(`http://dashboard/chats${query}`, { headers });
}

function auth(query: string): Request {
    return req(query, { authorization: `Bearer ${token}` });
}

async function cleanup(): Promise<void> {
    await withClient(async (client) => {
        await client.query(`delete from wa_chats where wa_phone = any($1)`, [E2E_PHONES]);
        await client.query(`delete from dashboard_users where phone_number = $1`, [DASH_PHONE]);
    });
}

describe('attack: GET /chats — query-параметр phone', () => {
    before(async () => {
        await cleanup();
        userId = await seedDashboardUser(DASH_PHONE);
        token = signAuthToken(userId);
        await withClient(async (client) => {
            for (const phone of E2E_PHONES) {
                await client.query(
                    `insert into wa_chats (wa_phone, last_received_message_at) values ($1, $2)`,
                    [phone, toDateTime(new Date(LAST_AT))],
                );
            }
        });
    });

    after(async () => {
        await cleanup();
        await closePool();
        await dashboardPool.end();
    });

    // ---------- AUTH: фильтр не обходит гейт ----------

    it('auth: нет токена + phone=<валидный> → 401, чат не течёт', async () => {
        const res = await dashboardFetch(req(`?phone=${CHAT_A}`));
        assert.equal(res.status, 401);
        const body = (await res.json()) as Record<string, unknown>;
        assert.equal(body.items, undefined, 'без токена items не отдаются даже с фильтром');
    });

    it('auth: нет токена + мусорный phone → 401 (гейт раньше валидации, не 400)', async () => {
        const res = await dashboardFetch(req('?phone=abc'));
        assert.equal(res.status, 401, 'auth-гейт срабатывает раньше 400 по phone');
    });

    it('auth: Basic вместо Bearer + phone → 401', async () => {
        const res = await dashboardFetch(
            req(`?phone=${CHAT_A}`, { authorization: 'Basic YWRtaW46YWRtaW4=' }),
        );
        assert.equal(res.status, 401);
    });

    it('auth: битая подпись + phone → 401', async () => {
        const parts = token.split('.');
        const sig = parts[2] ?? '';
        const flipped = `${sig.slice(0, -1)}${sig.slice(-1) === 'A' ? 'B' : 'A'}`;
        const tampered = `${parts[0]}.${parts[1]}.${flipped}`;
        const res = await dashboardFetch(
            req(`?phone=${CHAT_A}`, { authorization: `Bearer ${tampered}` }),
        );
        assert.equal(res.status, 401);
    });

    it('auth: протухший токен + phone → 401', async () => {
        const expired = signAuthToken(userId, -10);
        const res = await dashboardFetch(
            req(`?phone=${CHAT_A}`, { authorization: `Bearer ${expired}` }),
        );
        assert.equal(res.status, 401);
    });

    it('auth: валидная подпись на юзера не из dashboard_users + phone → 401', async () => {
        const orphan = signJwt(
            { sub: ulid(), exp: Math.floor(Date.now() / 1000) + 3600 },
            process.env.JWT_SECRET ?? '',
        );
        const res = await dashboardFetch(
            req(`?phone=${CHAT_A}`, { authorization: `Bearer ${orphan}` }),
        );
        assert.equal(res.status, 401);
    });

    // ---------- SQL-ИНЪЕКЦИЯ ----------

    it('injection: phone с цифрами + drop table — не 500, таблица цела, без расширения выборки', async () => {
        const evil = `${CHAT_A}'; drop table wa_chats;--`;
        const res = await dashboardFetch(auth(`?phone=${encodeURIComponent(evil)}`));
        assert.notEqual(res.status, 500, 'инъекция не роняет хендлер');
        assert.equal(res.status, 200, 'мета вырезана до цифр → валидный запрос');
        const body = (await res.json()) as ListResponse;
        // Мета ушла значением: остались только цифры CHAT_A → каждый item содержит их.
        for (const item of body.items) {
            assert.ok(item.phone.includes(CHAT_A), `инъекция не расширила выборку: ${item.phone}`);
        }
        assert.ok(
            body.items.some((i) => i.phone === CHAT_A),
            'свой чат по цифрам найден',
        );
        const reg = await dbOne<{ m: string | null }>(`select to_regclass('public.wa_chats') as m`);
        assert.equal(reg?.m, 'wa_chats', 'таблица wa_chats цела после инъекции');
    });

    it('injection: phone из одной мета без цифр → 400, таблица цела', async () => {
        const res = await dashboardFetch(
            auth(`?phone=${encodeURIComponent("'; drop table wa_chats;--")}`),
        );
        assert.equal(res.status, 400, 'нет ни одной цифры → badRequest');
        const reg = await dbOne<{ m: string | null }>(`select to_regclass('public.wa_chats') as m`);
        assert.equal(reg?.m, 'wa_chats', 'таблица цела');
    });

    it('injection: like-метасимвол «_» НЕ wildcard (digits-only, дискриминатор)', async () => {
        // raw-LIKE '%7999_999%' матчил бы WILD='79995999'; digits-only ищет '7999999' — не подстрока.
        const res = await dashboardFetch(auth(`?phone=${encodeURIComponent('7999_999')}`));
        assert.equal(res.status, 200);
        const body = (await res.json()) as ListResponse;
        assert.ok(
            !body.items.some((i) => i.phone === WILD),
            '«_» не сработал как одиночный wildcard — WILD не найден',
        );
    });

    it('injection: like-метасимвол «%» НЕ wildcard (digits-only, дискриминатор)', async () => {
        // raw-LIKE '%7999%999%' матчил бы WILD; digits-only ищет '7999999' — не подстрока.
        const res = await dashboardFetch(auth(`?phone=${encodeURIComponent('7999%999')}`));
        assert.equal(res.status, 200);
        const body = (await res.json()) as ListResponse;
        assert.ok(
            !body.items.some((i) => i.phone === WILD),
            '«%» не сработал как многосимвольный wildcard — WILD не найден',
        );
        // Контроль: WILD реально в БД (иначе проба ничего не доказывает).
        const exists = await dbOne<{ n: string }>(
            `select wa_phone as n from wa_chats where wa_phone = $1`,
            [WILD],
        );
        assert.equal(exists?.n, WILD, 'WILD реально существует в БД');
    });

    // ---------- КРИВОЙ ВВОД ----------

    it('input: гигантская строка (>512) → 400, не 500, следов в БД нет', async () => {
        const huge = '9'.repeat(5000);
        const res = await dashboardFetch(auth(`?phone=${huge}`));
        assert.notEqual(res.status, 500, 'гигантский ввод не роняет');
        assert.equal(res.status, 400, 'длиннее лимита → badRequest');
    });

    it('input: только unicode-цифры (٥٥٥) → 400 (ASCII \\d не видит их как цифры)', async () => {
        const res = await dashboardFetch(auth(`?phone=${encodeURIComponent('٥٥٥')}`));
        assert.equal(res.status, 400, 'unicode-цифры без ASCII → нет цифр → 400');
    });

    it('input: «+» без цифр → 400', async () => {
        const res = await dashboardFetch(auth(`?phone=${encodeURIComponent('+')}`));
        assert.equal(res.status, 400);
    });

    it('input: пустой phone (?phone=) → 200 без фильтра (фильтр не задан)', async () => {
        const res = await dashboardFetch(auth('?phone='));
        assert.equal(res.status, 200, 'пустая строка = поиск не задан → полный список');
    });

    it('input: phone повторён дважды (массив) → 200 без фильтра, не молчаливый матч', async () => {
        const res = await dashboardFetch(auth(`?phone=${CHAT_A}&phone=${CHAT_B}`));
        assert.equal(res.status, 200, 'массив в phone = не строка → фильтр не задан');
    });

    it('input: отрицательный limit + phone → clamp к 1, не падение, не негативный LIMIT', async () => {
        const res = await dashboardFetch(auth(`?phone=7999000200&limit=-5`));
        assert.equal(res.status, 200);
        const body = (await res.json()) as ListResponse;
        assert.ok(body.items.length <= 1, 'отрицательный limit клампится к 1');
    });

    it('input: битый cursor вместе с валидным phone → 400 (cursor валидируется)', async () => {
        const res = await dashboardFetch(auth(`?phone=${CHAT_A}&cursor=not-a-cursor`));
        assert.equal(res.status, 400, 'битый cursor режется даже при валидном phone');
    });

    it('input: cursor с SQL-инъекцией + phone → не 500, таблица цела', async () => {
        const evil = "2099-06-01T10:00:00.000Z|'; drop table wa_chats;--";
        const res = await dashboardFetch(
            auth(`?phone=7999000200&cursor=${encodeURIComponent(evil)}`),
        );
        assert.notEqual(res.status, 500, 'инъекция в cursor не роняет');
        const reg = await dbOne<{ m: string | null }>(`select to_regclass('public.wa_chats') as m`);
        assert.equal(reg?.m, 'wa_chats', 'таблица цела после cursor-инъекции');
    });

    // ---------- УТЕЧКА: фильтр не создаёт лишних строк ----------

    it('leak: инъекции не наплодили строк с E2E-номерами (сверка count в БД)', async () => {
        const rows = await dbQuery<{ wa_phone: string }>(
            `select wa_phone from wa_chats where wa_phone = any($1)`,
            [E2E_PHONES],
        );
        assert.equal(rows.length, E2E_PHONES.length, 'ровно посеянные строки, дублей/новых нет');
    });
});
