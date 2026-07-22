// Attack-приёмка: chatGetHandler + chatGetMessagesHandler (read-only Dashboard).
// Каждая проба бьёт напрямую в dashboardFetch и сверяется с БД (dbOne/dbQuery).
// Чистим строго свои строки с префиксом E2E_atk_cg.
//
// Векторы: auth (нет/Basic/битая подпись/alg:none/протухший/валидный на удалённого),
//          SQL-инъекция в :phone и cursor (таблицы целы, не 500, не течёт),
//          phone пустой/пробелы/регистр, limit clamp, cursor-мусор,
//          целостность keyset (limit=1 без дублей/пропусков, id desc),
//          owner-маппинг (только user|bot), 404 vs 200, роут-разбор.

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

const DASH_PHONE = 'E2E_atk_cg_user';
const CHAT_PHONE = 'E2E_atk_cg_chat';

// 5 сообщений: id = ulid(ts) по возрастанию времени → в выдаче id desc новейшее первым.
const MSGS = [
    { at: '2031-05-01T10:00:00.000Z', owner: 'guest', status: 'delivered', text: 'm0 user' },
    { at: '2031-05-01T10:00:01.000Z', owner: 'sema', status: 'read', text: 'm1 bot' },
    { at: '2031-05-01T10:00:02.000Z', owner: 'guest', status: 'read', text: "m2 ' quote" },
    { at: '2031-05-01T10:00:03.000Z', owner: 'sema', status: 'sent', text: 'm3 bot' },
    { at: '2031-05-01T10:00:04.000Z', owner: 'guest', status: 'delivered', text: 'm4 user' },
];
const IDS = MSGS.map((m) => ulid(new Date(m.at).getTime()));
const ORDER_DESC = [...IDS].reverse();

const LAST_RECEIVED = '2031-05-01T10:00:04.000Z';
const LAST_SENT = '2031-05-01T10:00:03.000Z';

let token = '';
let userId = '';

async function cleanup(): Promise<void> {
    await withClient(async (client) => {
        await client.query(`delete from wa_messages where wa_chat_phone = $1`, [CHAT_PHONE]);
        await client.query(`delete from wa_chats where wa_phone = $1`, [CHAT_PHONE]);
        await client.query(`delete from guests where wa_phone = $1`, [CHAT_PHONE]);
        await client.query(`delete from dashboard_users where phone_number = $1`, [DASH_PHONE]);
    });
}

async function seed(): Promise<void> {
    await withClient(async (client) => {
        const guestId = ulid();
        await client.query(
            `insert into guests (id, wa_phone, first_name, last_name) values ($1, $2, 'Ivan', 'Petrov')`,
            [guestId, CHAT_PHONE],
        );
        await client.query(
            `insert into wa_chats (wa_phone, guest_id, last_received_message_at, last_sent_message_at)
             values ($1, $2, $3, $4)`,
            [
                CHAT_PHONE,
                guestId,
                toDateTime(new Date(LAST_RECEIVED)),
                toDateTime(new Date(LAST_SENT)),
            ],
        );
        for (let i = 0; i < MSGS.length; i++) {
            const m = MSGS[i];
            await client.query(
                `insert into wa_messages (id, wa_chat_phone, text, owner, status, sent_at)
                 values ($1, $2, $3, $4, $5, $6)`,
                [
                    IDS[i],
                    CHAT_PHONE,
                    m?.text,
                    m?.owner,
                    m?.status,
                    toDateTime(new Date(m?.at ?? 0)),
                ],
            );
        }
    });
}

function req(path: string, headers: Record<string, string> = {}): Request {
    return new Request(`http://dashboard${path}`, { headers });
}

function auth(path: string): Request {
    return req(path, { authorization: `Bearer ${token}` });
}

interface MessagesResponse {
    items: {
        id: string;
        text: string | null;
        owner: string;
        status: string | null;
        sentAt: string | null;
    }[];
    nextCursor: string | null;
}

describe('attack: dashboard chatGet + chatGetMessages', () => {
    before(async () => {
        await cleanup();
        userId = await seedDashboardUser(DASH_PHONE);
        token = signAuthToken(userId);
        await seed();
    });

    after(async () => {
        await cleanup();
        await closePool();
        await dashboardPool.end();
    });

    // ---------- AUTH ----------

    it('auth: нет заголовка → 401, чата не отдаёт', async () => {
        const res = await dashboardFetch(req(`/chats/${CHAT_PHONE}`));
        assert.equal(res.status, 401);
        const body = (await res.json()) as Record<string, unknown>;
        assert.equal(body.phone, undefined, 'без токена данные чата не текут');
    });

    it('auth: Basic вместо Bearer → 401', async () => {
        const res = await dashboardFetch(
            req(`/chats/${CHAT_PHONE}`, { authorization: 'Basic YWRtaW46YWRtaW4=' }),
        );
        assert.equal(res.status, 401);
    });

    it('auth: битая подпись → 401', async () => {
        const parts = token.split('.');
        const sig = parts[2] ?? '';
        const flipped = `${sig.slice(0, -1)}${sig.slice(-1) === 'A' ? 'B' : 'A'}`;
        const tampered = `${parts[0]}.${parts[1]}.${flipped}`;
        const res = await dashboardFetch(
            req(`/chats/${CHAT_PHONE}`, { authorization: `Bearer ${tampered}` }),
        );
        assert.equal(res.status, 401);
    });

    it('auth: alg:none без подписи → 401', async () => {
        const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
            'base64url',
        );
        const payload = Buffer.from(
            JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 3600 }),
        ).toString('base64url');
        const forged = `${header}.${payload}.`;
        const res = await dashboardFetch(
            req(`/chats/${CHAT_PHONE}`, { authorization: `Bearer ${forged}` }),
        );
        assert.equal(res.status, 401);
    });

    it('auth: протухший токен → 401', async () => {
        const expired = signAuthToken(userId, -10);
        const res = await dashboardFetch(
            req(`/chats/${CHAT_PHONE}`, { authorization: `Bearer ${expired}` }),
        );
        assert.equal(res.status, 401);
    });

    it('auth: валидная подпись на несуществующего dashboard-юзера → 401', async () => {
        const orphan = signJwt(
            { sub: ulid(), exp: Math.floor(Date.now() / 1000) + 3600 },
            process.env.JWT_SECRET ?? '',
        );
        const res = await dashboardFetch(
            req(`/chats/${CHAT_PHONE}`, { authorization: `Bearer ${orphan}` }),
        );
        assert.equal(res.status, 401);
    });

    it('auth: messages тоже под гейтом — без токена → 401', async () => {
        const res = await dashboardFetch(req(`/chats/${CHAT_PHONE}/messages`));
        assert.equal(res.status, 401);
    });

    // ---------- SQL-ИНЪЕКЦИЯ ----------

    it('injection: :phone с drop table — не 500, таблицы целы, чужого не отдаёт', async () => {
        const evil = `${CHAT_PHONE}'; drop table wa_messages; --`;
        const res = await dashboardFetch(auth(`/chats/${encodeURIComponent(evil)}`));
        assert.notEqual(res.status, 500, 'инъекция не должна ронять хендлер');
        assert.equal(res.status, 404, 'такого phone нет → 404 (значение, не SQL)');
        const reg = await dbOne<{ m: string | null }>(
            `select to_regclass('public.wa_messages') as m`,
        );
        assert.equal(reg?.m, 'wa_messages', 'таблица wa_messages цела');
    });

    it('injection: :phone с or 1=1 не протаскивает чужой чат', async () => {
        const evil = `' or '1'='1`;
        const res = await dashboardFetch(auth(`/chats/${encodeURIComponent(evil)}`));
        assert.notEqual(res.status, 500);
        assert.equal(res.status, 404, 'or 1=1 не должно «найти» какой-либо чат');
    });

    it('injection: cursor с drop table — 200, таблицы целы, без краша', async () => {
        const evil = `' or 1=1; drop table wa_messages; --`;
        const res = await dashboardFetch(
            auth(`/chats/${CHAT_PHONE}/messages?cursor=${encodeURIComponent(evil)}`),
        );
        assert.notEqual(res.status, 500, 'инъекция в cursor не роняет');
        assert.equal(res.status, 200);
        const reg = await dbOne<{ m: string | null }>(
            `select to_regclass('public.wa_messages') as m`,
        );
        assert.equal(reg?.m, 'wa_messages', 'таблица wa_messages цела после cursor-инъекции');
    });

    // ---------- PHONE ----------

    it('phone: пробелы (URL-encoded, itty не декодит) → не 500', async () => {
        // itty не декодит %20 → phone = литерал '%20%20' → чата нет → 404 (не 500, не течёт).
        const res = await dashboardFetch(auth('/chats/%20%20'));
        assert.notEqual(res.status, 500, 'whitespace phone не роняет');
        assert.notEqual(res.status, 200, 'литерал %20%20 не находит чужой чат');
    });

    it('phone: сверхдлинный (>512) → 400 (safeParseString режет), не 500', async () => {
        const res = await dashboardFetch(auth(`/chats/${'a'.repeat(600)}`));
        assert.notEqual(res.status, 500);
        assert.equal(res.status, 400, 'phone длиннее лимита → badRequest 400');
    });

    it('phone: другой регистр не находит чужой чат → 404', async () => {
        const res = await dashboardFetch(auth(`/chats/${CHAT_PHONE.toLowerCase()}`));
        assert.equal(res.status, 404, 'lowercase phone не матчит uppercase в БД');
    });

    // ---------- LIMIT ----------

    it('limit: отрицательный → clamp к 1 (ровно одно сообщение)', async () => {
        const res = await dashboardFetch(auth(`/chats/${CHAT_PHONE}/messages?limit=-5`));
        assert.equal(res.status, 200);
        const body = (await res.json()) as MessagesResponse;
        assert.equal(body.items.length, 1, 'negative limit клампится к 1');
        assert.equal(body.items[0]?.id, ORDER_DESC[0], 'первым — новейшее сообщение');
    });

    it('limit: 0 → clamp к 1', async () => {
        const res = await dashboardFetch(auth(`/chats/${CHAT_PHONE}/messages?limit=0`));
        assert.equal(res.status, 200);
        const body = (await res.json()) as MessagesResponse;
        assert.equal(body.items.length, 1);
    });

    it('limit: гигантский → clamp к 100, отдаёт все 5 без краша', async () => {
        const res = await dashboardFetch(auth(`/chats/${CHAT_PHONE}/messages?limit=999999999`));
        assert.equal(res.status, 200);
        const body = (await res.json()) as MessagesResponse;
        const mine = body.items.filter((m) => IDS.includes(m.id));
        assert.equal(mine.length, MSGS.length, 'все мои сообщения на одной странице');
        assert.equal(body.nextCursor, null, 'все влезли (< 100) → nextCursor null');
    });

    it('limit: нечисловой и дробный → default 30, не падает', async () => {
        for (const bad of ['abc', '1.5', "5' or '1'='1"]) {
            const res = await dashboardFetch(
                auth(`/chats/${CHAT_PHONE}/messages?limit=${encodeURIComponent(bad)}`),
            );
            assert.equal(res.status, 200, `limit=${bad} → 200`);
            const body = (await res.json()) as MessagesResponse;
            const mine = body.items.filter((m) => IDS.includes(m.id));
            assert.equal(mine.length, MSGS.length, `limit=${bad} → default 30 отдаёт все 5`);
        }
    });

    // ---------- CURSOR ----------

    it('cursor: мусор/не-ULID → 200 без краша', async () => {
        for (const bad of ['not-a-ulid', '!!!', '   ']) {
            const res = await dashboardFetch(
                auth(`/chats/${CHAT_PHONE}/messages?cursor=${encodeURIComponent(bad)}`),
            );
            assert.equal(res.status, 200, `cursor=${bad} → 200`);
        }
    });

    it('cursor: не достаёт чужой чат — cursor не меняет wa_chat_phone', async () => {
        // Курсор из «моего» чата, но phone несуществующий → items пустой (cursor не перепрыгивает чат).
        const res = await dashboardFetch(
            auth(`/chats/E2E_atk_cg_missing/messages?cursor=${encodeURIComponent(IDS[0] ?? '')}`),
        );
        assert.equal(res.status, 200);
        const body = (await res.json()) as MessagesResponse;
        assert.deepEqual(body.items, [], 'cursor не протаскивает сообщения из другого чата');
    });

    // ---------- KEYSET ЦЕЛОСТНОСТЬ ----------

    it('keyset: страницы limit=1 — все id, порядок desc, без дублей/пропусков (сверка с БД)', async () => {
        const collected: string[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 20; page++) {
            const q = cursor ? `?limit=1&cursor=${encodeURIComponent(cursor)}` : '?limit=1';
            const res = await dashboardFetch(auth(`/chats/${CHAT_PHONE}/messages${q}`));
            assert.equal(res.status, 200);
            const body = (await res.json()) as MessagesResponse;
            if (body.items.length === 0) {
                break;
            }
            for (const it of body.items) {
                collected.push(it.id);
            }
            cursor = body.nextCursor;
            if (cursor === null) {
                break;
            }
        }
        assert.equal(new Set(collected).size, collected.length, 'нет дублей между страницами');
        assert.deepEqual(
            collected,
            ORDER_DESC,
            'keyset отдал все id в порядке desc, без пропусков',
        );

        const dbRows = await dbQuery<{ id: string }>(
            `select id from wa_messages where wa_chat_phone = $1 order by id desc`,
            [CHAT_PHONE],
        );
        assert.deepEqual(
            collected,
            dbRows.map((r) => r.id),
            'порядок совпадает с фактом в БД (id desc)',
        );
    });

    // ---------- OWNER MAPPING ----------

    it('owner: в выдаче только user|bot, guest→user / sema→bot (сверка с owner в БД)', async () => {
        const res = await dashboardFetch(auth(`/chats/${CHAT_PHONE}/messages?limit=100`));
        assert.equal(res.status, 200);
        const body = (await res.json()) as MessagesResponse;
        const mine = body.items.filter((m) => IDS.includes(m.id));

        for (const item of mine) {
            assert.ok(
                item.owner === 'user' || item.owner === 'bot',
                `owner ∈ {user,bot}, got ${item.owner}`,
            );
        }
        const dbRows = await dbQuery<{ id: string; owner: string }>(
            `select id, owner from wa_messages where wa_chat_phone = $1`,
            [CHAT_PHONE],
        );
        const dbOwner = new Map(dbRows.map((r) => [r.id, r.owner]));
        for (const item of mine) {
            const expected = dbOwner.get(item.id) === 'sema' ? 'bot' : 'user';
            assert.equal(item.owner, expected, `маппинг owner для ${item.id}`);
        }
    });

    // ---------- 404 vs 200 ----------

    it('404 vs 200: chatGet несуществующего → 404, messages того же → 200 []', async () => {
        const c = await dashboardFetch(auth('/chats/E2E_atk_cg_missing'));
        assert.equal(c.status, 404, 'chatGet несуществующего → 404');

        const m = await dashboardFetch(auth('/chats/E2E_atk_cg_missing/messages'));
        assert.notEqual(m.status, 404, 'messages несуществующего НЕ 404');
        assert.notEqual(m.status, 500, 'messages несуществующего НЕ 500');
        assert.equal(m.status, 200);
        const body = (await m.json()) as MessagesResponse;
        assert.deepEqual(body.items, []);
        assert.equal(body.nextCursor, null);
    });

    // ---------- РОУТ-РАЗБОР ----------

    it('route: /chats/:phone/messages не перехвачен /chats/:phone (phone не станет X/messages)', async () => {
        // messages вернул бы 200; если бы перехватил chatGet, был бы 404 по phone "CHAT/messages".
        const res = await dashboardFetch(auth(`/chats/${CHAT_PHONE}/messages?limit=100`));
        assert.equal(res.status, 200);
        const body = (await res.json()) as MessagesResponse;
        const mine = body.items.filter((m) => IDS.includes(m.id));
        assert.equal(mine.length, MSGS.length, 'messages-роут реально отработал');
    });

    // ---------- GET /chats (список) — ранее не покрытая ручка ----------
    // Аддитивка: item.paused = (paused_at is not null). Проверяем, что новая
    // колонка не размножила/не потеряла строки и keyset жив.

    const LIST_NUL = 'E2E_atk_cl_null'; // без сообщений/таймстампов → last_message_at NULL
    const LIST_F1 = 'E2E_atk_cl_f1';
    const LIST_F2 = 'E2E_atk_cl_f2';
    const LIST_T1 = '2099-06-01T10:00:00.000Z';
    const LIST_T2 = '2099-06-01T09:00:00.000Z';

    async function seedList(): Promise<void> {
        await withClient(async (client) => {
            await client.query(`delete from wa_chats where wa_phone = any($1)`, [
                [LIST_NUL, LIST_F1, LIST_F2],
            ]);
            await client.query(`insert into wa_chats (wa_phone) values ($1)`, [LIST_NUL]);
            await client.query(
                `insert into wa_chats (wa_phone, last_received_message_at) values ($1, $2)`,
                [LIST_F1, toDateTime(new Date(LIST_T1))],
            );
            await client.query(
                `insert into wa_chats (wa_phone, last_received_message_at, paused_at, pause_details)
                 values ($1, $2, $3, 'на паузе')`,
                [LIST_F2, toDateTime(new Date(LIST_T2)), toDateTime(new Date(LIST_T2))],
            );
        });
    }

    async function cleanupList(): Promise<void> {
        await withClient(async (client) => {
            await client.query(`delete from wa_chats where wa_phone = any($1)`, [
                [LIST_NUL, LIST_F1, LIST_F2],
            ]);
        });
    }

    function authList(query: string): Request {
        return req(`/chats${query}`, { authorization: `Bearer ${token}` });
    }

    interface ListResponse {
        items: { phone: string; paused: boolean }[];
        nextCursor: string | null;
    }

    it('list auth: нет токена → 401, список не течёт', async () => {
        const res = await dashboardFetch(req('/chats'));
        assert.equal(res.status, 401);
        const body = (await res.json()) as Record<string, unknown>;
        assert.equal(body.items, undefined, 'без токена items не отдаются');
    });

    it('list auth: валидная подпись на удалённого юзера → 401', async () => {
        const orphan = signJwt(
            { sub: ulid(), exp: Math.floor(Date.now() / 1000) + 3600 },
            process.env.JWT_SECRET ?? '',
        );
        const res = await dashboardFetch(req('/chats', { authorization: `Bearer ${orphan}` }));
        assert.equal(res.status, 401);
    });

    it('list cursor: мусор без разделителя → 400', async () => {
        const res = await dashboardFetch(authList('?cursor=not-a-cursor'));
        assert.equal(res.status, 400, 'битый курсор режется валидацией');
    });

    it('list cursor: SQL-инъекция → 400 или значение, таблица wa_chats цела', async () => {
        for (const evil of [
            "' or 1=1; drop table wa_chats;--",
            "2099-06-01T10:00:00.000Z|'; drop table wa_chats;--",
        ]) {
            const res = await dashboardFetch(authList(`?cursor=${encodeURIComponent(evil)}`));
            assert.notEqual(res.status, 500, `cursor-инъекция (${evil}) не роняет`);
        }
        const reg = await dbOne<{ m: string | null }>(`select to_regclass('public.wa_chats') as m`);
        assert.equal(reg?.m, 'wa_chats', 'таблица wa_chats цела после cursor-инъекции');
    });

    it('list limit: отрицательный → clamp к 1; гигантский → clamp к 100', async () => {
        const neg = await dashboardFetch(authList('?limit=-5'));
        assert.equal(neg.status, 200);
        const negBody = (await neg.json()) as ListResponse;
        assert.equal(negBody.items.length, 1, 'negative limit клампится к 1');

        const huge = await dashboardFetch(authList('?limit=999999999'));
        assert.equal(huge.status, 200);
        const hugeBody = (await huge.json()) as ListResponse;
        assert.ok(hugeBody.items.length <= 100, 'гигантский limit клампится к 100');
    });

    it('list paused: флаг == (paused_at is not null) в БД, строки не размножены', async () => {
        await seedList();
        try {
            const res = await dashboardFetch(authList('?limit=100'));
            assert.equal(res.status, 200);
            const body = (await res.json()) as ListResponse;

            const mine = body.items.filter((c) => [LIST_NUL, LIST_F1, LIST_F2].includes(c.phone));
            // Аддитивная колонка — scalar-проекция: ни одна строка не должна задвоиться.
            assert.equal(
                new Set(mine.map((c) => c.phone)).size,
                mine.length,
                'paused-проекция не размножила строки',
            );

            const db = await dbQuery<{ wa_phone: string; paused: boolean }>(
                `select wa_phone, paused_at is not null as paused
                 from wa_chats where wa_phone = any($1)`,
                [[LIST_NUL, LIST_F1, LIST_F2]],
            );
            const dbFlag = new Map(db.map((r) => [r.wa_phone, r.paused]));
            for (const item of mine) {
                assert.equal(
                    item.paused,
                    dbFlag.get(item.phone),
                    `paused для ${item.phone} == факт БД`,
                );
            }
            assert.equal(dbFlag.get(LIST_F2), true, 'F2 реально на паузе (иначе проба не бьёт)');
        } finally {
            await cleanupList();
        }
    });

    it('list keyset: чат без last_message_at не теряется под пагинацией (сверка с БД)', async () => {
        await seedList();
        try {
            // F1/F2 датированы 2099 → идут первыми; NUL c NULL last_message_at
            // обязан быть где-то в выдаче. Проходим keyset до конца и собираем phone.
            const seen: string[] = [];
            let cursor: string | null = null;
            for (let page = 0; page < 500; page++) {
                const q = cursor ? `?limit=1&cursor=${encodeURIComponent(cursor)}` : '?limit=1';
                const res = await dashboardFetch(authList(q));
                assert.equal(res.status, 200);
                const body = (await res.json()) as ListResponse;
                if (body.items.length === 0) {
                    break;
                }
                for (const it of body.items) {
                    seen.push(it.phone);
                }
                cursor = body.nextCursor;
                if (cursor === null) {
                    break;
                }
            }

            assert.equal(new Set(seen).size, seen.length, 'keyset не дублирует строки');
            assert.ok(seen.includes(LIST_F1), 'F1 (2099) присутствует в пагинации');
            assert.ok(seen.includes(LIST_F2), 'F2 (2099) присутствует в пагинации');

            // Факт БД: NUL существует и виден на одной полной странице.
            const full = await dashboardFetch(authList('?limit=100'));
            const fullBody = (await full.json()) as ListResponse;
            assert.ok(
                fullBody.items.some((c) => c.phone === LIST_NUL),
                'NUL виден на полной странице (limit=100)',
            );
            const exists = await dbOne<{ n: string }>(
                `select wa_phone as n from wa_chats where wa_phone = $1`,
                [LIST_NUL],
            );
            assert.equal(exists?.n, LIST_NUL, 'NUL реально есть в БД');

            // Дыра: под keyset-пагинацией NUL (last_message_at IS NULL) выпадает —
            // WHERE отсекает NULL при непустом курсоре, order by nulls last прячет их в хвост.
            assert.ok(
                seen.includes(LIST_NUL),
                'чат без сообщений не должен теряться под keyset-пагинацией',
            );
        } finally {
            await cleanupList();
        }
    });
});
