// Задача модуля (chatsGetListHandler, query-параметр phone):
//   вход  → GET /chats?phone=<строка любого вида>&limit&cursor
//           заголовок authorization: Bearer <access JWT>
//   выход → полный валидный номер (libphonenumber) → точный матч wa_phone (E.164 без «+»);
//           частичные цифры → поиск по вхождению; пагинация сохраняется
//   бюджет → сеть/БД жёстко не меряем, только measure()
//   негатив → phone без цифр (мусор/пусто) → 400; ввод-инъекции — в .attack

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { pool as dashboardPool } from '#Dashboard/Db/Pool.js';
import { dashboardFetch } from '#Dashboard/Router.js';
import { toDateTime } from '#Lib/Fmt.js';
import {
    closePool,
    dbOne,
    measure,
    seedDashboardUser,
    signAuthToken,
    withClient,
} from './helpers/e2e.ts';

const DASH_PHONE = 'E2E_chatsearch_user';
// Валидные RU-номера (libphonenumber isValid) с кодом 999 — в проде гости UAE, коллизий нет.
const CHAT_A = '79990000123';
const CHAT_B = '79990000124';
const OTHER_CHAT = 'E2E_cs_other';
const LAST_AT = '2030-04-01T10:00:00.000Z';

interface ListResponse {
    items: { phone: string }[];
    nextCursor: string | null;
}

let token = '';

async function getChats(query: string): Promise<Response> {
    const { result } = await measure(`GET /chats${query}`, () =>
        dashboardFetch(
            new Request(`http://dashboard/chats${query}`, {
                headers: { authorization: `Bearer ${token}` },
            }),
        ),
    );
    return result;
}

async function cleanup(): Promise<void> {
    await withClient(async (client) => {
        await client.query(`delete from wa_chats where wa_phone = any($1)`, [
            [CHAT_A, CHAT_B, OTHER_CHAT],
        ]);
        await client.query(`delete from dashboard_users where phone_number = $1`, [DASH_PHONE]);
    });
}

describe('e2e: dashboard chatsGetList — фильтр phone', () => {
    before(async () => {
        await cleanup();
        const userId = await seedDashboardUser(DASH_PHONE);
        token = signAuthToken(userId);
        await withClient(async (client) => {
            for (const phone of [CHAT_A, CHAT_B, OTHER_CHAT]) {
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

    it('полный номер в любом формате («+7 (999) 000-01-23») → точный матч одного чата', async () => {
        const res = await getChats(`?phone=${encodeURIComponent('+7 (999) 000-01-23')}`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as ListResponse;
        assert.equal(body.items.length, 1);
        assert.equal(body.items[0]?.phone, CHAT_A);
        // Сверка с фактом БД: найденный телефон реально лежит в wa_chats как есть.
        const row = await dbOne<{ wa_phone: string }>(
            `select wa_phone from wa_chats where wa_phone = $1`,
            [CHAT_A],
        );
        assert.equal(row?.wa_phone, CHAT_A);
    });

    it('полный номер без «+» и без форматирования → тот же точный матч', async () => {
        const res = await getChats(`?phone=${CHAT_A}`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as ListResponse;
        assert.deepEqual(
            body.items.map((i) => i.phone),
            [CHAT_A],
        );
    });

    it('частичные цифры («999-000-012») → вхождение, оба чата, сосед не попадает', async () => {
        const res = await getChats(`?phone=${encodeURIComponent('999-000-012')}`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as ListResponse;
        const phones = body.items.map((i) => i.phone).sort();
        assert.deepEqual(phones, [CHAT_A, CHAT_B]);
    });

    it('частичные цифры + limit=1 → пагинация живёт: две страницы по курсору без пересечений', async () => {
        const first = await getChats(`?phone=999000012&limit=1`);
        assert.equal(first.status, 200);
        const page1 = (await first.json()) as ListResponse;
        assert.equal(page1.items.length, 1);
        assert.ok(page1.nextCursor, 'nextCursor есть при полной странице');

        const second = await getChats(
            `?phone=999000012&limit=1&cursor=${encodeURIComponent(page1.nextCursor ?? '')}`,
        );
        assert.equal(second.status, 200);
        const page2 = (await second.json()) as ListResponse;
        assert.equal(page2.items.length, 1);
        const all = [page1.items[0]?.phone, page2.items[0]?.phone].sort();
        assert.deepEqual(all, [CHAT_A, CHAT_B]);
    });

    it('цифры, которых нет ни в одном номере → 200 и пустой список', async () => {
        const res = await getChats(`?phone=00000009999999`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as ListResponse;
        assert.deepEqual(body.items, []);
        assert.equal(body.nextCursor, null);
    });

    it('phone без единой цифры (мусор) → 400', async () => {
        const res = await getChats(`?phone=abc`);
        assert.equal(res.status, 400);
    });

    it('пустой ?phone= → 200 без фильтра (как будто параметра нет)', async () => {
        const res = await getChats(`?phone=`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as ListResponse;
        const phones = body.items.map((i) => i.phone);
        assert.ok(phones.includes(OTHER_CHAT), 'нецифровой чат в списке → фильтр не применён');
    });

    it('без параметра phone список работает как раньше (фильтра нет)', async () => {
        const res = await getChats('?limit=100');
        assert.equal(res.status, 200);
        const body = (await res.json()) as ListResponse;
        const phones = body.items.map((i) => i.phone);
        assert.ok(phones.includes(OTHER_CHAT), 'нефильтрованный список содержит нецифровой чат');
    });
});
