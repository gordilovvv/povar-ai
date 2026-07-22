// Задача модуля (chatGetHandler + chatGetMessagesHandler):
//   вход  → GET /chats/:phone ; GET /chats/:phone/messages?limit&cursor
//           заголовок authorization: Bearer <access JWT> (гейт withAuthorization)
//   выход → chat: { phone, userName, lastMessageAt, lastUserMessageAt, lastBotMessageAt, pausedAt, pauseDetails }
//           messages: { id, text, owner: 'user'|'bot', status, sentAt }[], nextCursor
//           messages по id desc (ULID), keyset по id; owner: guest→user, sema→bot
//           chats list (GET /chats): item.paused = (paused_at is not null)
//   бюджет → сеть/БД жёстко не меряем (ориентир p95 ≤ 150ms), только measure()
//   негатив → нет/битый токен → 401; несуществующий чат → 404 (chat), 200 [] (messages);
//             пустой phone → 400 (в .attack)

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

const DASH_PHONE = 'E2E_chatget_user';
const CHAT_PHONE = 'E2E_cg_0001';
const EMPTY_CHAT = 'E2E_cg_empty';
const PAUSED_CHAT = 'E2E_cg_paused';
const PAUSED_AT = '2030-03-01T09:00:00.000Z';
const PAUSE_DETAILS = 'гость просит скидку';

const LAST_RECEIVED = '2030-03-01T10:00:05.000Z';
const LAST_SENT = '2030-03-01T10:00:09.000Z';

// Сообщения: id = ulid(ts) по возрастанию → в выдаче (id desc) новейшее первым.
const MESSAGES = [
    { at: '2030-03-01T10:00:00.000Z', owner: 'guest', status: 'delivered', text: 'привет' },
    { at: '2030-03-01T10:00:03.000Z', owner: 'sema', status: 'read', text: 'здравствуй' },
    { at: '2030-03-01T10:00:05.000Z', owner: 'guest', status: 'read', text: 'как дела' },
    { at: '2030-03-01T10:00:09.000Z', owner: 'sema', status: 'sent', text: 'отлично' },
];
const IDS = MESSAGES.map((m) => ulid(new Date(m.at).getTime()));
const ORDER_DESC = [...IDS].reverse();

async function cleanup(): Promise<void> {
    await withClient(async (client) => {
        await client.query(`delete from wa_messages where wa_chat_phone = any($1)`, [
            [CHAT_PHONE, EMPTY_CHAT, PAUSED_CHAT],
        ]);
        await client.query(`delete from wa_chats where wa_phone = any($1)`, [
            [CHAT_PHONE, EMPTY_CHAT, PAUSED_CHAT],
        ]);
        await client.query(`delete from guests where wa_phone = any($1)`, [
            [CHAT_PHONE, EMPTY_CHAT, PAUSED_CHAT],
        ]);
        await client.query(`delete from dashboard_users where phone_number = $1`, [DASH_PHONE]);
    });
}

async function seed(): Promise<void> {
    await withClient(async (client) => {
        const guestId = ulid();
        await client.query(
            `insert into guests (id, wa_phone, first_name, last_name) values ($1, $2, 'Anna', 'Ivanova')`,
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
        for (let i = 0; i < MESSAGES.length; i++) {
            const msg = MESSAGES[i];
            await client.query(
                `insert into wa_messages (id, wa_chat_phone, text, owner, status, sent_at)
                 values ($1, $2, $3, $4, $5, $6)`,
                [
                    IDS[i],
                    CHAT_PHONE,
                    msg?.text,
                    msg?.owner,
                    msg?.status,
                    toDateTime(new Date(msg?.at ?? 0)),
                ],
            );
        }

        // Пустой чат (без guest, без сообщений) — для userName=null и messages=[].
        await client.query(`insert into wa_chats (wa_phone) values ($1)`, [EMPTY_CHAT]);

        // Чат на паузе — для pausedAt/pauseDetails в детали и paused=true в списке.
        await client.query(
            `insert into wa_chats (wa_phone, paused_at, pause_details, last_received_message_at)
             values ($1, $2, $3, $4)`,
            [
                PAUSED_CHAT,
                toDateTime(new Date(PAUSED_AT)),
                PAUSE_DETAILS,
                toDateTime(new Date(LAST_RECEIVED)),
            ],
        );
    });
}

interface ChatResponse {
    phone: string;
    userName: string | null;
    lastMessageAt: string | null;
    lastUserMessageAt: string | null;
    lastBotMessageAt: string | null;
    pausedAt: string | null;
    pauseDetails: string | null;
}

interface MessagesResponse {
    items: {
        id: string;
        text: string | null;
        owner: 'user' | 'bot';
        status: string | null;
        sentAt: string | null;
    }[];
    nextCursor: string | null;
}

let token = '';

async function getChat(phone: string): Promise<Response> {
    const { result } = await measure(`GET /chats/${phone}`, () =>
        dashboardFetch(
            new Request(`http://dashboard/chats/${encodeURIComponent(phone)}`, {
                headers: { authorization: `Bearer ${token}` },
            }),
        ),
    );
    return result;
}

async function getMessages(phone: string, query = ''): Promise<Response> {
    const url = `http://dashboard/chats/${encodeURIComponent(phone)}/messages${query}`;
    const { result } = await measure(`GET /chats/${phone}/messages${query}`, () =>
        dashboardFetch(new Request(url, { headers: { authorization: `Bearer ${token}` } })),
    );
    return result;
}

describe('e2e: dashboard chatGet + chatGetMessages', () => {
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

    it('chatGet: имя из guests, три таймстампа (last = greatest, user=received, bot=sent)', async () => {
        const res = await getChat(CHAT_PHONE);
        assert.equal(res.status, 200);
        const chat = (await res.json()) as ChatResponse;

        assert.equal(chat.phone, CHAT_PHONE);
        assert.equal(chat.userName, 'Anna Ivanova', 'имя склеено из guests');
        assert.equal(chat.lastUserMessageAt, LAST_RECEIVED, 'lastUserMessageAt = last_received');
        assert.equal(chat.lastBotMessageAt, LAST_SENT, 'lastBotMessageAt = last_sent');
        assert.equal(chat.lastMessageAt, LAST_SENT, 'lastMessageAt = greatest(sent, received)');
        assert.equal(chat.pausedAt, null, 'не на паузе → pausedAt null');
        assert.equal(chat.pauseDetails, null, 'не на паузе → pauseDetails null');

        // Сверка с БД напрямую.
        const dbRow = await dbOne<{ last_message_at: string }>(
            `select greatest(last_sent_message_at, last_received_message_at) as last_message_at
             from wa_chats where wa_phone = $1`,
            [CHAT_PHONE],
        );
        assert.equal(
            new Date(dbRow?.last_message_at ?? 0).toISOString(),
            chat.lastMessageAt,
            'lastMessageAt совпадает с фактом в БД',
        );
    });

    it('chatGet: пустой чат без guest → userName null, таймстампы null', async () => {
        const res = await getChat(EMPTY_CHAT);
        assert.equal(res.status, 200);
        const chat = (await res.json()) as ChatResponse;
        assert.equal(chat.userName, null);
        assert.equal(chat.lastMessageAt, null);
        assert.equal(chat.lastUserMessageAt, null);
        assert.equal(chat.lastBotMessageAt, null);
    });

    it('chatGet: несуществующий чат → 404', async () => {
        const res = await getChat('E2E_cg_missing');
        assert.equal(res.status, 404);
    });

    it('chatGet: чат на паузе → pausedAt ISO + pauseDetails из БД', async () => {
        const res = await getChat(PAUSED_CHAT);
        assert.equal(res.status, 200);
        const chat = (await res.json()) as ChatResponse;
        assert.equal(chat.pausedAt, PAUSED_AT, 'pausedAt = paused_at в ISO UTC');
        assert.equal(chat.pauseDetails, PAUSE_DETAILS, 'pauseDetails из БД');

        // Сверка с фактом в БД.
        const dbRow = await dbOne<{ paused_at: string; pause_details: string }>(
            `select paused_at, pause_details from wa_chats where wa_phone = $1`,
            [PAUSED_CHAT],
        );
        assert.equal(
            new Date(dbRow?.paused_at ?? 0).toISOString(),
            chat.pausedAt,
            'pausedAt = факт БД',
        );
        assert.equal(dbRow?.pause_details, chat.pauseDetails, 'pauseDetails = факт БД');
    });

    it('chats list: keyset не теряет чат без сообщений; paused = факт БД', async () => {
        const mine = [CHAT_PHONE, PAUSED_CHAT, EMPTY_CHAT];
        const seen = new Set<string>();
        const foundPaused = new Map<string, boolean>();

        let cursor: string | null = null;
        for (let page = 0; page < 500; page++) {
            const q = cursor ? `limit=1&cursor=${encodeURIComponent(cursor)}` : 'limit=1';
            const { result } = await measure(`GET /chats?${q}`, () =>
                dashboardFetch(
                    new Request(`http://dashboard/chats?${q}`, {
                        headers: { authorization: `Bearer ${token}` },
                    }),
                ),
            );
            assert.equal(result.status, 200);
            const body = (await result.json()) as {
                items: { phone: string; paused: boolean }[];
                nextCursor: string | null;
            };
            for (const item of body.items) {
                assert.ok(!seen.has(item.phone), `нет дублей под keyset: ${item.phone}`);
                seen.add(item.phone);
                if (mine.includes(item.phone)) {
                    foundPaused.set(item.phone, item.paused);
                }
            }
            cursor = body.nextCursor;
            if (cursor === null) {
                break;
            }
        }

        // Все мои чаты дошли под пагинацией, включая EMPTY_CHAT (last_message_at is null).
        for (const phone of mine) {
            assert.ok(foundPaused.has(phone), `${phone} не потерян под keyset limit=1`);
        }

        // Флаг paused сверяем с фактом БД (paused_at is not null), не с константами.
        const dbRows = await dbQuery<{ wa_phone: string; paused: boolean }>(
            `select wa_phone, paused_at is not null as paused
             from wa_chats where wa_phone = any($1)`,
            [mine],
        );
        assert.equal(dbRows.length, mine.length, 'все мои чаты есть в БД');
        for (const row of dbRows) {
            assert.equal(
                foundPaused.get(row.wa_phone),
                row.paused,
                `paused ${row.wa_phone} = факт БД`,
            );
        }
        assert.equal(foundPaused.get(PAUSED_CHAT), true, 'паузнутый → paused true');
    });

    it('messages: все сообщения по id desc, owner guest→user / sema→bot, sentAt ISO', async () => {
        const res = await getMessages(CHAT_PHONE, '?limit=100');
        assert.equal(res.status, 200);
        const body = (await res.json()) as MessagesResponse;

        const mine = body.items.filter((m) => IDS.includes(m.id));
        assert.deepEqual(
            mine.map((m) => m.id),
            ORDER_DESC,
            'сообщения в порядке id desc (новейшее первым)',
        );

        const byId = new Map(mine.map((m) => [m.id, m]));
        assert.equal(byId.get(IDS[0] ?? '')?.owner, 'user', 'guest → user');
        assert.equal(byId.get(IDS[1] ?? '')?.owner, 'bot', 'sema → bot');
        assert.equal(byId.get(IDS[0] ?? '')?.text, 'привет', 'text отдаётся as-is');
        assert.equal(byId.get(IDS[3] ?? '')?.status, 'sent', 'status passthrough');
        assert.equal(
            byId.get(IDS[3] ?? '')?.sentAt,
            '2030-03-01T10:00:09.000Z',
            'sentAt в ISO UTC',
        );
        assert.equal(body.nextCursor, null, 'все влезли — nextCursor null');
    });

    it('messages: keyset-пагинация по id — страницы не пересекаются и не дублируют', async () => {
        const seen: string[] = [];
        const mineOrder: string[] = [];
        let cursor: string | null = null;

        for (let page = 0; page < 50; page++) {
            const query = cursor ? `?limit=1&cursor=${encodeURIComponent(cursor)}` : '?limit=1';
            const res = await getMessages(CHAT_PHONE, query);
            assert.equal(res.status, 200);
            const body = (await res.json()) as MessagesResponse;
            for (const item of body.items) {
                seen.push(item.id);
                if (IDS.includes(item.id)) {
                    mineOrder.push(item.id);
                }
            }
            cursor = body.nextCursor;
            if (cursor === null || mineOrder.length === ORDER_DESC.length) {
                break;
            }
        }

        assert.equal(new Set(seen).size, seen.length, 'ни одно сообщение не задублировано');
        assert.deepEqual(
            mineOrder,
            ORDER_DESC,
            'keyset выдаёт все мои сообщения в порядке id desc',
        );
    });

    it('messages: несуществующий чат → 200 с пустым списком', async () => {
        const res = await getMessages('E2E_cg_missing');
        assert.equal(res.status, 200);
        const body = (await res.json()) as MessagesResponse;
        assert.deepEqual(body.items, []);
        assert.equal(body.nextCursor, null);
    });

    it('messages: чат без сообщений → 200 []', async () => {
        const res = await getMessages(EMPTY_CHAT);
        assert.equal(res.status, 200);
        const body = (await res.json()) as MessagesResponse;
        assert.deepEqual(body.items, []);
    });
});
