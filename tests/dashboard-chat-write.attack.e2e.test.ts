// Attack-приёмка: chatSendMessageHandler (POST /chats/:phone/messages)
//                  chatSetPauseHandler   (PUT  /chats/:phone/pause)
// Каждая проба бьёт напрямую в dashboardFetch и сверяется с фактом в БД (dbOne/dbQuery).
// WhatsApp мокаем через globalThis.fetch на graph.facebook.com — реальный WA дёргать нельзя.
// Чистим строго свои строки с префиксом E2E_atk_cw.
//
// Векторы: auth (нет/протухший/orphan токен) → 401 без отправки/записи;
//          IDOR/инъекция в :phone → 404, таблицы целы, verbatim-текст как значение;
//          кривой body (нет texts, [], пустой элемент, не массив, битый JSON, paused не bool,
//                       details пробелы) → 400 с ранним return, WA не дёрнут, в БД пусто;
//          несуществующий чат → 404 без WA/записи;
//          консистентность WA↔БД при частичном сбое отправки;
//          гонки: параллельный pause (single-row), параллельные send (нет крашей/дублей сверх N).

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

const DASH_PHONE = 'E2E_atk_cw_user';
const SEND_CHAT = 'E2E_atk_cw_send';
const PAUSE_CHAT = 'E2E_atk_cw_pause';
const NOWRITE_CHAT = 'E2E_atk_cw_nowrite';
const FAIL_CHAT = 'E2E_atk_cw_fail';
const RACE_CHAT = 'E2E_atk_cw_race';
const MISSING = 'E2E_atk_cw_missing';
const ALL_CHATS = [SEND_CHAT, PAUSE_CHAT, NOWRITE_CHAT, FAIL_CHAT, RACE_CHAT];

const OLD_SENT = '2020-01-01T00:00:00.000Z';

let token = '';
let userId = '';

const realFetch = globalThis.fetch;
// Тела, на которых мок WhatsApp вернёт не-200 (симуляция отказа отправки конкретного баббла).
const waFailBodies = new Set<string>();
const waCalls: { to: string; body: string; ok: boolean }[] = [];

function installWaStub(): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('graph.facebook.com')) {
            const payload = JSON.parse(String(init?.body)) as {
                to: string;
                text?: { body: string };
            };
            const body = payload.text?.body ?? '';
            if (waFailBodies.has(body)) {
                waCalls.push({ to: payload.to, body, ok: false });
                return new Response('rejected', { status: 400 });
            }
            waCalls.push({ to: payload.to, body, ok: true });
            return Response.json({
                messaging_product: 'whatsapp',
                messages: [{ id: `wamid.E2E_${ulid()}` }],
            });
        }
        return realFetch(input, init);
    }) as typeof fetch;
}

async function cleanup(): Promise<void> {
    await withClient(async (client) => {
        await client.query(`delete from wa_messages where wa_chat_phone = any($1)`, [ALL_CHATS]);
        await client.query(`delete from wa_chats where wa_phone = any($1)`, [ALL_CHATS]);
        await client.query(`delete from dashboard_users where phone_number = $1`, [DASH_PHONE]);
    });
}

async function seed(): Promise<void> {
    await withClient(async (client) => {
        await client.query(
            `insert into wa_chats (wa_phone, last_sent_message_at) values ($1, $2)`,
            [SEND_CHAT, toDateTime(new Date(OLD_SENT))],
        );
        await client.query(
            `insert into wa_chats (wa_phone, last_sent_message_at) values ($1, $2)`,
            [NOWRITE_CHAT, toDateTime(new Date(OLD_SENT))],
        );
        await client.query(`insert into wa_chats (wa_phone) values ($1)`, [PAUSE_CHAT]);
        await client.query(`insert into wa_chats (wa_phone) values ($1)`, [FAIL_CHAT]);
        await client.query(`insert into wa_chats (wa_phone) values ($1)`, [RACE_CHAT]);
    });
}

function send(phone: string, body: unknown, auth: string | null = token): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (auth !== null) {
        headers.authorization = `Bearer ${auth}`;
    }
    return dashboardFetch(
        new Request(`http://dashboard/chats/${encodeURIComponent(phone)}/messages`, {
            method: 'POST',
            headers,
            body: typeof body === 'string' ? body : JSON.stringify(body),
        }),
    );
}

function setPause(phone: string, body: unknown, auth: string | null = token): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (auth !== null) {
        headers.authorization = `Bearer ${auth}`;
    }
    return dashboardFetch(
        new Request(`http://dashboard/chats/${encodeURIComponent(phone)}/pause`, {
            method: 'PUT',
            headers,
            body: typeof body === 'string' ? body : JSON.stringify(body),
        }),
    );
}

async function msgCount(phone: string): Promise<number> {
    const row = await dbOne<{ n: string }>(
        `select count(*)::int as n from wa_messages where wa_chat_phone = $1`,
        [phone],
    );
    return Number(row?.n ?? 0);
}

describe('attack: dashboard chatSendMessage + chatSetPause', () => {
    before(async () => {
        await cleanup();
        userId = await seedDashboardUser(DASH_PHONE);
        token = signAuthToken(userId);
        await seed();
        installWaStub();
    });

    after(async () => {
        globalThis.fetch = realFetch;
        await cleanup();
        await closePool();
        await dashboardPool.end();
    });

    // ---------- AUTH ----------

    it('send: без токена → 401, WA не дёрнут, в БД пусто', async () => {
        waCalls.length = 0;
        const res = await send(NOWRITE_CHAT, { texts: ['hi'] }, null);
        assert.equal(res.status, 401);
        assert.equal(waCalls.length, 0, 'без авторизации WA не вызывается');
        assert.equal(await msgCount(NOWRITE_CHAT), 0, 'ничего не записано');
    });

    it('send: протухший токен → 401, WA не дёрнут', async () => {
        waCalls.length = 0;
        const expired = signAuthToken(userId, -60);
        const res = await send(NOWRITE_CHAT, { texts: ['hi'] }, expired);
        assert.equal(res.status, 401);
        assert.equal(waCalls.length, 0);
        assert.equal(await msgCount(NOWRITE_CHAT), 0);
    });

    it('send: валидная подпись на удалённого юзера → 401', async () => {
        waCalls.length = 0;
        const orphan = signJwt(
            { sub: ulid(), exp: Math.floor(Date.now() / 1000) + 3600 },
            process.env.JWT_SECRET ?? '',
        );
        const res = await send(NOWRITE_CHAT, { texts: ['hi'] }, orphan);
        assert.equal(res.status, 401);
        assert.equal(waCalls.length, 0);
        assert.equal(await msgCount(NOWRITE_CHAT), 0);
    });

    it('pause: без токена → 401, состояние чата не менялось', async () => {
        const res = await setPause(NOWRITE_CHAT, { paused: true, details: 'x' }, null);
        assert.equal(res.status, 401);
        const row = await dbOne<{ paused_at: string | null }>(
            `select paused_at from wa_chats where wa_phone = $1`,
            [NOWRITE_CHAT],
        );
        assert.equal(row?.paused_at, null, 'без токена pause не применён');
    });

    // ---------- IDOR / ИНЪЕКЦИЯ В :phone ----------

    it('send: инъекция в :phone → 404, таблицы целы, WA не дёрнут, в БД пусто', async () => {
        waCalls.length = 0;
        const evil = `${SEND_CHAT}'); drop table wa_messages; --`;
        const res = await send(evil, { texts: ['hi'] });
        assert.notEqual(res.status, 500, 'инъекция не роняет хендлер');
        assert.equal(res.status, 404, 'evil phone — значение, не SQL → чата нет → 404');
        assert.equal(waCalls.length, 0, 'на 404 WA не вызывался');
        const reg = await dbOne<{ m: string | null }>(
            `select to_regclass('public.wa_messages') as m`,
        );
        assert.equal(reg?.m, 'wa_messages', 'таблица wa_messages цела');
    });

    it('pause: инъекция в :phone → 404, таблица цела', async () => {
        const evil = `${PAUSE_CHAT}'; drop table wa_chats; --`;
        const res = await setPause(evil, { paused: true });
        assert.notEqual(res.status, 500);
        assert.equal(res.status, 404);
        const reg = await dbOne<{ m: string | null }>(`select to_regclass('public.wa_chats') as m`);
        assert.equal(reg?.m, 'wa_chats', 'таблица wa_chats цела');
    });

    it('send: сверхдлинный phone (>512) → 400, WA не дёрнут', async () => {
        waCalls.length = 0;
        const res = await send('a'.repeat(600), { texts: ['hi'] });
        assert.notEqual(res.status, 500);
        assert.equal(res.status, 400, 'phone длиннее лимита → badRequest');
        assert.equal(waCalls.length, 0);
    });

    it('send: SQL-мета в text уходит как значение — verbatim, таблица цела', async () => {
        waCalls.length = 0;
        const evil = `x'); drop table wa_messages; -- ё —`;
        const before = await msgCount(SEND_CHAT);
        const res = await send(SEND_CHAT, { texts: [evil] });
        assert.equal(res.status, 200);
        const rows = await dbQuery<{ text: string }>(
            `select text from wa_messages where wa_chat_phone = $1 order by id desc limit 1`,
            [SEND_CHAT],
        );
        assert.equal(
            rows[0]?.text,
            evil,
            'SQL-мета сохранена как значение, verbatim (ё/— не режутся)',
        );
        assert.equal(await msgCount(SEND_CHAT), before + 1, 'ровно одна новая строка');
        const reg = await dbOne<{ m: string | null }>(
            `select to_regclass('public.wa_messages') as m`,
        );
        assert.equal(reg?.m, 'wa_messages', 'таблица цела');
    });

    // ---------- КРИВОЙ BODY: ранний return, WA не дёрнут, в БД пусто ----------

    it('send: битый body → 400, WA не дёрнут, в БД пусто (ранний return)', async () => {
        const badBodies: unknown[] = [
            {}, // нет texts
            { texts: [] }, // пустой массив
            { texts: ['ok', ''] }, // пустая строка в элементе
            { texts: 'not-array' }, // texts не массив
            { texts: [123] }, // элемент не строка
            { texts: null }, // texts null
            '{bad json', // невалидный JSON
        ];
        for (const body of badBodies) {
            waCalls.length = 0;
            const res = await send(NOWRITE_CHAT, body);
            assert.equal(res.status, 400, `body=${JSON.stringify(body)} → 400`);
            assert.equal(waCalls.length, 0, `body=${JSON.stringify(body)} → WA не дёрнут`);
        }
        assert.equal(await msgCount(NOWRITE_CHAT), 0, 'ни одна кривая проба не записала строку');
        const chat = await dbOne<{ last_sent_message_at: string }>(
            `select last_sent_message_at from wa_chats where wa_phone = $1`,
            [NOWRITE_CHAT],
        );
        assert.equal(
            new Date(chat?.last_sent_message_at ?? 0).getTime(),
            new Date(OLD_SENT).getTime(),
            'last_sent_message_at не сдвинут кривым вводом',
        );
    });

    it('pause: paused не boolean / details из пробелов → 400, состояние не менялось', async () => {
        const badBodies: unknown[] = [
            { paused: 'true' },
            { paused: 1 },
            {},
            { paused: true, details: '   ' },
            { paused: true, details: '' },
        ];
        for (const body of badBodies) {
            const res = await setPause(NOWRITE_CHAT, body);
            assert.equal(res.status, 400, `body=${JSON.stringify(body)} → 400`);
        }
        const row = await dbOne<{ paused_at: string | null; pause_details: string | null }>(
            `select paused_at, pause_details from wa_chats where wa_phone = $1`,
            [NOWRITE_CHAT],
        );
        assert.equal(row?.paused_at, null, 'кривой pause не выставил paused_at');
        assert.equal(row?.pause_details, null, 'кривой pause не записал details');
    });

    it('send: несуществующий чат → 404, WA не дёрнут, строк нет', async () => {
        waCalls.length = 0;
        const res = await send(MISSING, { texts: ['hi'] });
        assert.equal(res.status, 404);
        assert.equal(waCalls.length, 0, 'на 404 WA не вызывался');
        assert.equal(await msgCount(MISSING), 0);
    });

    // ---------- КОНСИСТЕНТНОСТЬ WA ↔ БД ----------

    it('send: WA отдал баббл, но упал на следующем — доставленное должно быть записано', async () => {
        waCalls.length = 0;
        waFailBodies.clear();
        waFailBodies.add('BAD');
        // 'ok' уйдёт в WA (200), 'BAD' — отказ WA → хендлер падает.
        const res = await send(FAIL_CHAT, { texts: ['ok', 'BAD'] });
        waFailBodies.clear();

        const deliveredOk = waCalls.filter((c) => c.ok).map((c) => c.body);
        const persisted = await dbQuery<{ text: string }>(
            `select text from wa_messages where wa_chat_phone = $1`,
            [FAIL_CHAT],
        );
        // Инвариант: любой баббл, реально доставленный в WhatsApp (200), обязан быть в БД —
        // иначе админ доставил гостю сообщение, которого нет ни в истории, ни в last_sent.
        assert.ok(deliveredOk.includes('ok'), 'предпосылка: "ok" доставлен в WA');
        assert.equal(
            persisted.length,
            deliveredOk.length,
            `доставлено в WA ${deliveredOk.length}, записано ${persisted.length} — доставленное без записи (res=${res.status})`,
        );
    });

    // ---------- ГОНКИ ----------

    it('race: параллельный pause(true) с разными details → одна строка, на паузе', async () => {
        const results = await Promise.allSettled([
            setPause(RACE_CHAT, { paused: true, details: 'a' }),
            setPause(RACE_CHAT, { paused: true, details: 'b' }),
            setPause(RACE_CHAT, { paused: true, details: 'c' }),
        ]);
        for (const r of results) {
            assert.equal(r.status, 'fulfilled');
            if (r.status === 'fulfilled') {
                assert.equal(r.value.status, 200);
            }
        }
        const rows = await dbQuery<{ paused_at: string | null; pause_details: string | null }>(
            `select paused_at, pause_details from wa_chats where wa_phone = $1`,
            [RACE_CHAT],
        );
        assert.equal(rows.length, 1, 'чат — одна строка, апдейт не наплодил дублей');
        assert.ok(rows[0]?.paused_at !== null, 'после гонки чат на паузе');
        assert.ok(
            ['a', 'b', 'c'].includes(rows[0]?.pause_details ?? ''),
            'победил ровно один details',
        );
    });

    it('race: два параллельных одинаковых send(N=2) → 4 строки, без крашей/дублей сверх N', async () => {
        waCalls.length = 0;
        const before = await msgCount(RACE_CHAT);
        const results = await Promise.allSettled([
            send(RACE_CHAT, { texts: ['r1', 'r2'] }),
            send(RACE_CHAT, { texts: ['r1', 'r2'] }),
        ]);
        for (const r of results) {
            assert.equal(r.status, 'fulfilled');
            if (r.status === 'fulfilled') {
                assert.equal(r.value.status, 200, 'параллельный send не падает на unique/FK');
            }
        }
        assert.equal(
            await msgCount(RACE_CHAT),
            before + 4,
            'два distinct POST по 2 баббла = ровно 4 строки (нет дублей сверх ожидаемого)',
        );
        const dup = await dbOne<{ n: string }>(
            `select count(*)::int as n from (
                select wa_message_id from wa_messages where wa_chat_phone = $1
                group by wa_message_id having count(*) > 1
             ) d`,
            [RACE_CHAT],
        );
        assert.equal(Number(dup?.n ?? 0), 0, 'нет дублей по wa_message_id');
    });
});
