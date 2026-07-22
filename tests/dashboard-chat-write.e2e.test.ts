// Задача модуля (chatSendMessageHandler + chatSetPauseHandler):
//   вход  → POST /chats/:phone/messages  body { texts: string[] }  (Bearer JWT, гейт withAuthorization)
//           PUT  /chats/:phone/pause      body { paused: boolean, details?: string }
//   выход → send:  { sent: n }; для каждого texts[i] строка в wa_messages
//                   (owner='sema', status='sent', text ВЕРБАТИМ, wa_message_id из ответа WA),
//                   last_sent_message_at = greatest(старого, now)
//           pause: { paused }; paused=true → paused_at=now, pause_details;
//                   paused=false → paused_at/pause_details = null
//   бюджет → сеть/БД жёстко не меряем, только measure()
//   негатив → нет/битый токен → 401; несуществующий чат → 404; кривой body → 400 (в .attack)

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ulid } from 'ulid';
import { pool as dashboardPool } from '#Dashboard/Db/Pool.js';
import { dashboardFetch } from '#Dashboard/Router.js';
import { toDateTime } from '#Lib/Fmt.js';
import {
    closePool,
    dbOne,
    dbQuery,
    measure,
    seedDashboardUser,
    signAuthToken,
    withClient,
} from './helpers/e2e.ts';

const DASH_PHONE = 'E2E_chatwrite_user';
const SEND_CHAT = 'E2E_cw_send';
const PAUSE_CHAT = 'E2E_cw_pause';
const OLD_SENT = '2020-01-01T00:00:00.000Z';

let token = '';
const realFetch = globalThis.fetch;
const waCalls: { to: string; body: string }[] = [];

function installWaStub(): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('graph.facebook.com')) {
            const payload = JSON.parse(String(init?.body)) as {
                to: string;
                text?: { body: string };
            };
            waCalls.push({ to: payload.to, body: payload.text?.body ?? '' });
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
        await client.query(`delete from wa_messages where wa_chat_phone = any($1)`, [
            [SEND_CHAT, PAUSE_CHAT],
        ]);
        await client.query(`delete from wa_chats where wa_phone = any($1)`, [
            [SEND_CHAT, PAUSE_CHAT],
        ]);
        await client.query(`delete from dashboard_users where phone_number = $1`, [DASH_PHONE]);
    });
}

async function seed(): Promise<void> {
    await withClient(async (client) => {
        await client.query(
            `insert into wa_chats (wa_phone, last_sent_message_at) values ($1, $2)`,
            [SEND_CHAT, toDateTime(new Date(OLD_SENT))],
        );
        await client.query(`insert into wa_chats (wa_phone) values ($1)`, [PAUSE_CHAT]);
    });
}

async function send(phone: string, body: unknown): Promise<Response> {
    const { result } = await measure(`POST /chats/${phone}/messages`, () =>
        dashboardFetch(
            new Request(`http://dashboard/chats/${encodeURIComponent(phone)}/messages`, {
                method: 'POST',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                body: JSON.stringify(body),
            }),
        ),
    );
    return result;
}

async function setPause(phone: string, body: unknown): Promise<Response> {
    const { result } = await measure(`PUT /chats/${phone}/pause`, () =>
        dashboardFetch(
            new Request(`http://dashboard/chats/${encodeURIComponent(phone)}/pause`, {
                method: 'PUT',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                body: JSON.stringify(body),
            }),
        ),
    );
    return result;
}

describe('e2e: dashboard chatSendMessage + chatSetPause', () => {
    before(async () => {
        await cleanup();
        const userId = await seedDashboardUser(DASH_PHONE);
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

    it('send: несколько бабблов → WA + строки в БД, текст вербатим (ё и — не режутся)', async () => {
        waCalls.length = 0;
        const texts = ['Привет, ёжик', 'тире — на месте'];
        const res = await send(SEND_CHAT, { texts });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { sent: 2 });

        // WA дёрнут ровно дважды, на нужный номер, тем же текстом.
        assert.equal(waCalls.length, 2, 'WhatsApp вызван по одному разу на баббл');
        assert.deepEqual(
            waCalls.map((c) => c.to),
            [SEND_CHAT, SEND_CHAT],
        );
        assert.deepEqual(
            waCalls.map((c) => c.body),
            texts,
            'в WA ушёл вербатим-текст',
        );

        // Сверка с фактом в БД: две строки, owner/status, текст без нормализации.
        const rows = await dbQuery<{
            text: string;
            owner: string;
            status: string;
            wa_message_id: string;
        }>(
            `select text, owner, status, wa_message_id from wa_messages
             where wa_chat_phone = $1 order by id asc`,
            [SEND_CHAT],
        );
        assert.equal(rows.length, 2, 'ровно 2 строки, дублей нет');
        assert.deepEqual(
            rows.map((r) => r.text),
            texts,
            'текст в БД вербатим — ё и — сохранены',
        );
        assert.ok(rows.every((r) => r.owner === 'sema' && r.status === 'sent'));
        assert.ok(
            rows.every((r) => r.wa_message_id.startsWith('wamid.E2E_')),
            'wa_message_id из ответа WA',
        );

        // last_sent_message_at продвинулся вперёд относительно старого seed-значения.
        const chat = await dbOne<{ last_sent_message_at: string }>(
            `select last_sent_message_at from wa_chats where wa_phone = $1`,
            [SEND_CHAT],
        );
        assert.ok(
            new Date(chat?.last_sent_message_at ?? 0).getTime() > new Date(OLD_SENT).getTime(),
            'last_sent_message_at обновлён на now',
        );
    });

    it('send: несуществующий чат → 404, WA не дёрнут, строк нет', async () => {
        waCalls.length = 0;
        const res = await send('E2E_cw_missing', { texts: ['эй'] });
        assert.equal(res.status, 404);
        assert.equal(waCalls.length, 0, 'на 404 WhatsApp не вызывался');
        const row = await dbOne(`select 1 from wa_messages where wa_chat_phone = $1`, [
            'E2E_cw_missing',
        ]);
        assert.equal(row, null, 'ничего не записано для несуществующего чата');
    });

    it('pause: ставим на паузу и снимаем → paused_at и pause_details в БД', async () => {
        const on = await setPause(PAUSE_CHAT, { paused: true, details: 'админ разбирается' });
        assert.equal(on.status, 200);
        assert.deepEqual(await on.json(), { paused: true });
        let row = await dbOne<{ paused_at: string | null; pause_details: string | null }>(
            `select paused_at, pause_details from wa_chats where wa_phone = $1`,
            [PAUSE_CHAT],
        );
        assert.ok(row?.paused_at !== null, 'paused_at выставлен');
        assert.equal(row?.pause_details, 'админ разбирается');

        const off = await setPause(PAUSE_CHAT, { paused: false });
        assert.equal(off.status, 200);
        assert.deepEqual(await off.json(), { paused: false });
        row = await dbOne(`select paused_at, pause_details from wa_chats where wa_phone = $1`, [
            PAUSE_CHAT,
        ]);
        assert.equal(row?.paused_at, null, 'снят с паузы — paused_at null');
        assert.equal(row?.pause_details, null, 'pause_details очищен');
    });

    it('pause: повторная пауза идемпотентна (без details) → 200, состояние на паузе', async () => {
        await setPause(PAUSE_CHAT, { paused: true, details: 'первый раз' });
        const again = await setPause(PAUSE_CHAT, { paused: true });
        assert.equal(again.status, 200);
        const row = await dbOne<{ paused_at: string | null; pause_details: string | null }>(
            `select paused_at, pause_details from wa_chats where wa_phone = $1`,
            [PAUSE_CHAT],
        );
        assert.ok(row?.paused_at !== null, 'остаётся на паузе');
        assert.equal(row?.pause_details, null, 'без details pause_details перезаписан в null');
    });

    it('pause: несуществующий чат → 404', async () => {
        const res = await setPause('E2E_cw_missing', { paused: false });
        assert.equal(res.status, 404);
    });
});
