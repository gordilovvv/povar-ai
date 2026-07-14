// Задача модуля (chatsGetListHandler):
//   вход  → GET /chats?limit&cursor, заголовок authorization: Bearer <access JWT>
//   выход → { items: { phone, userName, lastMessageText, lastMessageAt }[], nextCursor },
//           сортировка по lastMessageAt desc, keyset-пагинация по (lastMessageAt, phone)
//   бюджет → сеть/БД жёстко не меряем (p95 ≤ 150ms — ориентир), только measure()
//   негатив → без токена / протухший / чужой юзер → 401; кривой cursor → 400 (в .attack)

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ulid } from 'ulid';
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

const DASH_PHONE = 'E2E_dashboard_user';

// Чаты в будущем — чтобы сортировались поверх реальных dev-данных детерминированно.
const CHATS = [
    { phone: 'E2E_0001', first: 'Anna', last: 'Ivanova', at: '2030-01-01T10:00:00.000Z' },
    { phone: 'E2E_0002', first: 'Boris', last: 'Petrov', at: '2030-01-02T10:00:00.000Z' },
    { phone: 'E2E_0003', first: null, last: null, at: '2030-01-03T10:00:00.000Z' },
];

const MY_PHONES = new Set(CHATS.map((chat) => chat.phone));
const MY_ORDER = ['E2E_0003', 'E2E_0002', 'E2E_0001'];
const PAGE_CAP = 50;

// Tie-break: три чата с ОДИНАКОВЫМ lastMessageAt (та же секунда/мс) — курсор обязан
// разделить их по вторичному ключу wa_phone, без дублей и пропусков.
const TIE_AT = '2030-06-01T12:00:00.000Z';
const TIE_PHONES = ['E2E_T001', 'E2E_T002', 'E2E_T003'];
const TIE_ORDER = ['E2E_T003', 'E2E_T002', 'E2E_T001'];

// Чистим строго свои строки (не общий префикс), чтобы параллельный attack-файл не затирал.
const OWN_PHONES = [...CHATS.map((chat) => chat.phone), ...TIE_PHONES];

async function cleanup(): Promise<void> {
    await withClient(async (client) => {
        await client.query(`delete from wa_messages where wa_chat_phone = any($1)`, [OWN_PHONES]);
        await client.query(`delete from wa_chats where wa_phone = any($1)`, [OWN_PHONES]);
        await client.query(`delete from guests where wa_phone = any($1)`, [OWN_PHONES]);
        await client.query(`delete from dashboard_users where phone_number = $1`, [DASH_PHONE]);
    });
}

async function seed(): Promise<void> {
    await withClient(async (client) => {
        for (const chat of CHATS) {
            const guestId = ulid();
            await client.query(
                `insert into guests (id, wa_phone, first_name, last_name) values ($1, $2, $3, $4)`,
                [guestId, chat.phone, chat.first, chat.last],
            );
            await client.query(
                `insert into wa_chats (wa_phone, guest_id, last_received_message_at) values ($1, $2, $3)`,
                [chat.phone, guestId, toDateTime(new Date(chat.at))],
            );
            const older = new Date(new Date(chat.at).getTime() - 60_000);
            await client.query(
                `insert into wa_messages (id, wa_chat_phone, text, owner, status, sent_at)
                 values ($1, $2, $3, 'guest', 'delivered', $4)`,
                [ulid(older.getTime()), chat.phone, `old ${chat.phone}`, toDateTime(older)],
            );
            await client.query(
                `insert into wa_messages (id, wa_chat_phone, text, owner, status, sent_at)
                 values ($1, $2, $3, 'guest', 'delivered', $4)`,
                [
                    ulid(new Date(chat.at).getTime()),
                    chat.phone,
                    `new ${chat.phone}`,
                    toDateTime(new Date(chat.at)),
                ],
            );
        }

        for (const phone of TIE_PHONES) {
            const guestId = ulid();
            await client.query(
                `insert into guests (id, wa_phone, first_name, last_name) values ($1, $2, $3, $4)`,
                [guestId, phone, 'Tie', phone],
            );
            await client.query(
                `insert into wa_chats (wa_phone, guest_id, last_received_message_at) values ($1, $2, $3)`,
                [phone, guestId, toDateTime(new Date(TIE_AT))],
            );
            await client.query(
                `insert into wa_messages (id, wa_chat_phone, text, owner, status, sent_at)
                 values ($1, $2, $3, 'guest', 'delivered', $4)`,
                [
                    ulid(new Date(TIE_AT).getTime()),
                    phone,
                    `msg ${phone}`,
                    toDateTime(new Date(TIE_AT)),
                ],
            );
        }
    });
}

interface ChatsResponse {
    items: {
        phone: string;
        userName: string | null;
        lastMessageText: string | null;
        lastMessageAt: string | null;
    }[];
    nextCursor: string | null;
}

async function getChats(token: string, query: string): Promise<{ res: ChatsResponse; ms: number }> {
    const { result, ms } = await measure(`GET /chats?${query}`, () =>
        dashboardFetch(
            new Request(`http://dashboard/chats?${query}`, {
                headers: { authorization: `Bearer ${token}` },
            }),
        ),
    );
    assert.equal(result.status, 200, 'happy-path статус 200');
    return { res: (await result.json()) as ChatsResponse, ms };
}

describe('e2e: dashboard chatsGetListHandler', () => {
    let token = '';

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

    it('возвращает чаты по lastMessageAt desc, имя из guests, превью = последнее сообщение', async () => {
        const { res } = await getChats(token, 'limit=100');

        // Относительно своих строк — не считаем, что владеем всей таблицей (параллельные тесты).
        const mine = res.items.filter((item) => MY_PHONES.has(item.phone));
        assert.deepEqual(
            mine.map((item) => item.phone),
            MY_ORDER,
            'мои чаты в порядке lastMessageAt desc',
        );

        const byPhone = new Map(mine.map((item) => [item.phone, item]));
        assert.equal(byPhone.get('E2E_0001')?.userName, 'Anna Ivanova', 'имя склеено из guests');
        assert.equal(byPhone.get('E2E_0003')?.userName, null, 'нет имени → null');
        assert.equal(
            byPhone.get('E2E_0002')?.lastMessageText,
            'new E2E_0002',
            'превью = последнее сообщение чата',
        );
        assert.equal(
            byPhone.get('E2E_0003')?.lastMessageAt,
            '2030-01-03T10:00:00.000Z',
            'lastMessageAt = greatest(sent, received) в ISO',
        );

        // Сверка напрямую с БД, не только с ответом.
        const dbRow = await dbOne<{ last_message_at: string }>(
            `select greatest(last_sent_message_at, last_received_message_at) as last_message_at
             from wa_chats where wa_phone = $1`,
            ['E2E_0003'],
        );
        assert.equal(
            new Date(dbRow?.last_message_at ?? 0).toISOString(),
            byPhone.get('E2E_0003')?.lastMessageAt,
            'ответ совпадает с фактом в БД',
        );
    });

    it('keyset-пагинация: страницы не пересекаются и не дублируют', async () => {
        const seen: string[] = [];
        const mineOrder: string[] = [];
        let cursor: string | null = null;

        for (let page = 0; page < PAGE_CAP; page++) {
            const query = cursor ? `limit=2&cursor=${encodeURIComponent(cursor)}` : 'limit=2';
            const { res }: { res: ChatsResponse } = await getChats(token, query);
            for (const item of res.items) {
                seen.push(item.phone);
                if (MY_PHONES.has(item.phone)) {
                    mineOrder.push(item.phone);
                }
            }
            cursor = res.nextCursor;
            if (cursor === null || mineOrder.length === MY_ORDER.length) {
                break;
            }
        }

        assert.equal(
            new Set(seen).size,
            seen.length,
            'ни один чат не задублирован между страницами',
        );
        assert.deepEqual(
            mineOrder,
            MY_ORDER,
            'keyset выдаёт мои чаты в верном порядке без пропусков',
        );
    });

    it('tie-break: чаты с одинаковым lastMessageAt делятся курсором по phone без дублей/пропусков', async () => {
        // Сначала убедимся, что в БД у всех трёх ДЕЙСТВИТЕЛЬНО один и тот же instant.
        const distinct = await dbOne<{ n: string }>(
            `select count(distinct greatest(last_sent_message_at, last_received_message_at))::text as n
             from wa_chats where wa_phone = any($1)`,
            [TIE_PHONES],
        );
        assert.equal(distinct?.n, '1', 'все три tie-чата имеют одинаковый lastMessageAt в БД');

        const collected: string[] = [];
        const seenAt = new Set<string>();
        let cursor: string | null = null;

        // limit=1 — заставляем курсор проходить ровно через точку равенства ключа.
        for (let page = 0; page < PAGE_CAP; page++) {
            const query = cursor ? `limit=1&cursor=${encodeURIComponent(cursor)}` : 'limit=1';
            const { res }: { res: ChatsResponse } = await getChats(token, query);
            for (const item of res.items) {
                if (TIE_PHONES.includes(item.phone)) {
                    collected.push(item.phone);
                    if (item.lastMessageAt) {
                        seenAt.add(item.lastMessageAt);
                    }
                }
            }
            cursor = res.nextCursor;
            if (cursor === null || collected.length === TIE_ORDER.length) {
                break;
            }
        }

        assert.deepEqual(
            collected,
            TIE_ORDER,
            'три равных по времени чата выданы по одному в порядке phone desc, без дублей/пропусков',
        );
        assert.deepEqual(
            [...seenAt],
            [TIE_AT],
            'у всех трёх один и тот же lastMessageAt (реальный tie, а не разные секунды)',
        );
    });
});
