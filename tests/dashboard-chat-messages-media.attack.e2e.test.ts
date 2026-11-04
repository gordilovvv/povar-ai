// Attack-приёмка: chatGetMessagesHandler (GET /chats/:phone/messages) — медиа гостя в выдаче,
//                  insertIncomingWaMessage (src/Db/WaMessages.ts) — запись media_type/media_id.
// Хендлер бьём через dashboardFetch, storage — напрямую клиентом pg (процесс вебхука не поднимаем).
// Каждая проба сверяется с фактом в БД (dbOne/dbQuery). Чистим строго свои строки E2E_atk_cm.
//
// Векторы: owner вне enum в БД → fail-fast 500 только на этом чате (контракт 'user'|'bot'|'marketing'
//          гарантирует zod-парс, соседние чаты не задеты, rogue-строка в ответ не течёт);
//          медиа всех входящих типов через реальный insertIncomingWaMessage → отдаётся как в БД;
//          инъекция в media_id/caption → значение, не SQL, таблица цела;
//          auth на чат с медиа (протухший/чужой sub) → 401, mediaId не течёт;
//          storage: без медиа → null; повтор wa_message_id → 23505, строка не перезатёрта;
//                   пауза → skipped; гонка одного wa_message_id → ровно одна строка;
//                   чат отсутствует → строки нет.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ulid } from 'ulid';
import { pool as dashboardPool } from '#Dashboard/Db/Pool.js';
import { signJwt } from '#Dashboard/Lib/Jwt.js';
import { dashboardFetch } from '#Dashboard/Router.js';
import { insertIncomingWaMessage } from '#Db/WaMessages.js';
import { toDateTime } from '#Lib/Fmt.js';
import {
    closePool,
    dbOne,
    dbQuery,
    seedDashboardUser,
    signAuthToken,
    withClient,
} from './helpers/e2e.ts';

const DASH_PHONE = 'E2E_atk_cm_user';
const CHAT = 'E2E_atk_cm_chat';
const PAUSED_CHAT = 'E2E_atk_cm_paused';
const RACE_CHAT = 'E2E_atk_cm_race';
const ROGUE_CHAT = 'E2E_atk_cm_rogue';
const MISSING_CHAT = 'E2E_atk_cm_missing';
const ALL_CHATS = [CHAT, PAUSED_CHAT, RACE_CHAT, ROGUE_CHAT];
const WA_PREFIX = 'wamid.E2E_atk_cm_';

const MEDIA_TYPES = ['image', 'video', 'audio', 'document', 'sticker'] as const;
const EVIL_MEDIA_ID = `E2E_atk_cm_evil'; drop table wa_messages; --`;
const EVIL_CAPTION = `caption'; delete from wa_messages; --`;

let token = '';
let userId = '';

interface MessageItem {
    id: string;
    text: string | null;
    owner?: string;
    status: string | null;
    sentAt: string | null;
    mediaType: string | null;
    mediaId: string | null;
}

interface MessagesResponse {
    items: MessageItem[];
    nextCursor: string | null;
}

async function cleanup(): Promise<void> {
    await withClient(async (client) => {
        await client.query(
            `delete from wa_messages where wa_chat_phone = any($1) or wa_message_id like $2`,
            [[...ALL_CHATS, MISSING_CHAT], `${WA_PREFIX}%`],
        );
        await client.query(`delete from wa_chats where wa_phone = any($1)`, [ALL_CHATS]);
        await client.query(`delete from dashboard_users where phone_number = $1`, [DASH_PHONE]);
    });
}

async function seed(): Promise<void> {
    await withClient(async (client) => {
        await client.query(`insert into wa_chats (wa_phone) values ($1), ($2), ($3)`, [
            CHAT,
            RACE_CHAT,
            ROGUE_CHAT,
        ]);
        await client.query(
            `insert into wa_chats (wa_phone, paused_at, pause_details) values ($1, $2, 'e2e')`,
            [PAUSED_CHAT, toDateTime(new Date('2031-06-01T09:00:00.000Z'))],
        );
    });
}

function req(path: string, headers: Record<string, string> = {}): Request {
    return new Request(`http://dashboard${path}`, { headers });
}

function messages(phone: string, query = '?limit=100', bearer = token): Promise<Response> {
    return dashboardFetch(
        req(`/chats/${encodeURIComponent(phone)}/messages${query}`, {
            authorization: `Bearer ${bearer}`,
        }),
    );
}

function incoming(
    phone: string,
    waMessageId: string,
    media?: { media_type: string; media_id: string; text?: string | null },
) {
    return withClient((client) =>
        insertIncomingWaMessage(client, {
            id: ulid(),
            wa_message_id: waMessageId,
            wa_chat_phone: phone,
            text: media?.text ?? (media ? null : 'plain text'),
            owner: 'guest',
            status: 'delivered',
            concurrency_version: 0,
            sent_at: new Date(),
            ...(media ? { media_type: media.media_type, media_id: media.media_id } : {}),
        }),
    );
}

describe('attack: chat messages media + insertIncomingWaMessage', () => {
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

    // ---------- OWNER ВНЕ ENUM ----------

    it('owner: строка с owner вне enum в БД → fail-fast 500 на этом чате, rogue не течёт, соседний чат живой', async () => {
        const rogueId = ulid();
        await dbQuery(
            `insert into wa_messages (id, wa_chat_phone, text, owner, status, sent_at)
             values ($1, $2, 'rogue', 'system', 'read', now())`,
            [rogueId, ROGUE_CHAT],
        );
        const inDb = await dbOne<{ owner: string }>(`select owner from wa_messages where id = $1`, [
            rogueId,
        ]);
        assert.equal(inDb?.owner, 'system', 'колонка owner без check — rogue-строка реально легла');

        const res = await messages(ROGUE_CHAT);
        assert.equal(
            res.status,
            500,
            'owner вне enum — порча данных, ручка обязана упасть, не выдумать owner',
        );
        const text = await res.text();
        assert.ok(!text.includes(rogueId), 'rogue id не течёт в тело ошибки');
        assert.ok(!text.includes('"owner"'), 'items с полуживым owner не отдаются');

        const neighbour = await messages(CHAT);
        assert.equal(neighbour.status, 200, 'порча в одном чате не роняет соседний');
    });

    // ---------- МЕДИА ЧЕРЕЗ РЕАЛЬНЫЙ STORAGE ----------

    it('media: все входящие типы через insertIncomingWaMessage → mediaType/mediaId == факт БД, owner user', async () => {
        for (const type of MEDIA_TYPES) {
            await incoming(CHAT, `${WA_PREFIX}${type}`, {
                media_type: type,
                media_id: `E2E_atk_cm_${type}_id`,
            });
        }
        const res = await messages(CHAT);
        assert.equal(res.status, 200);
        const body = (await res.json()) as MessagesResponse;

        const dbRows = await dbQuery<{
            id: string;
            media_type: string | null;
            media_id: string | null;
            owner: string;
            text: string | null;
        }>(
            `select id, media_type, media_id, owner, text from wa_messages
             where wa_chat_phone = $1 and wa_message_id like $2`,
            [CHAT, `${WA_PREFIX}%`],
        );
        assert.equal(dbRows.length, MEDIA_TYPES.length, 'по строке на каждый тип медиа');

        for (const row of dbRows) {
            const item = body.items.find((m) => m.id === row.id);
            assert.ok(item, `сообщение ${row.media_type} есть в выдаче`);
            assert.equal(item.mediaType, row.media_type, `mediaType ${row.media_type} == БД`);
            assert.equal(item.mediaId, row.media_id, `mediaId ${row.media_type} == БД`);
            assert.equal(item.owner, 'user', `guest-медиа ${row.media_type} → user`);
            assert.equal(item.text, null, 'медиа без подписи → text null');
            assert.ok(MEDIA_TYPES.includes(row.media_type as (typeof MEDIA_TYPES)[number]));
        }
    });

    it('media: без медиа через insertIncomingWaMessage → media_type/media_id null в БД и в выдаче', async () => {
        const waId = `${WA_PREFIX}plain`;
        await incoming(CHAT, waId);
        const row = await dbOne<{
            id: string;
            media_type: string | null;
            media_id: string | null;
            worker_status: string;
            text: string | null;
        }>(
            `select id, media_type, media_id, worker_status, text from wa_messages where wa_message_id = $1`,
            [waId],
        );
        assert.ok(row, 'строка легла');
        assert.equal(row.media_type, null);
        assert.equal(row.media_id, null);
        assert.equal(row.text, 'plain text');
        assert.equal(row.worker_status, 'need_processed', 'чат не на паузе → need_processed');

        const body = (await (await messages(CHAT)).json()) as MessagesResponse;
        const item = body.items.find((m) => m.id === row.id);
        assert.ok(item);
        assert.equal(item.mediaType, null);
        assert.equal(item.mediaId, null);
    });

    // ---------- ИНЪЕКЦИЯ В МЕДИА-ПОЛЯХ ----------

    it('injection: media_id/caption с SQL-метой → ложатся как значение, отдаются as-is, таблица цела', async () => {
        const waId = `${WA_PREFIX}evil`;
        await incoming(CHAT, waId, {
            media_type: 'image',
            media_id: EVIL_MEDIA_ID,
            text: EVIL_CAPTION,
        });

        const row = await dbOne<{ id: string; media_id: string | null; text: string | null }>(
            `select id, media_id, text from wa_messages where wa_message_id = $1`,
            [waId],
        );
        assert.equal(row?.media_id, EVIL_MEDIA_ID, 'media_id сохранён буквально');
        assert.equal(row?.text, EVIL_CAPTION, 'caption сохранён буквально');

        const reg = await dbOne<{ m: string | null }>(
            `select to_regclass('public.wa_messages') as m`,
        );
        assert.equal(reg?.m, 'wa_messages', 'таблица цела');
        const alive = await dbOne<{ n: string }>(
            `select count(*)::text as n from wa_messages where wa_chat_phone = $1`,
            [CHAT],
        );
        assert.ok(Number(alive?.n) >= 2, 'delete из caption не выполнился');

        const res = await messages(CHAT);
        assert.equal(res.status, 200);
        const body = (await res.json()) as MessagesResponse;
        const item = body.items.find((m) => m.id === row?.id);
        assert.equal(item?.mediaId, EVIL_MEDIA_ID, 'mediaId в ответе == БД');
        assert.equal(item?.text, EVIL_CAPTION, 'text в ответе == БД');
    });

    // ---------- AUTH НА ЧАТ С МЕДИА ----------

    it('auth: протухший / orphan-sub токен → 401, mediaId не течёт', async () => {
        const expired = signAuthToken(userId, -10);
        const orphan = signJwt(
            { sub: ulid(), exp: Math.floor(Date.now() / 1000) + 3600 },
            process.env.JWT_SECRET ?? '',
        );
        for (const bad of [expired, orphan, 'garbage']) {
            const res = await messages(CHAT, '?limit=100', bad);
            assert.equal(res.status, 401);
            const text = await res.text();
            assert.ok(!text.includes('E2E_atk_cm_image_id'), 'mediaId не утёк без авторизации');
        }
    });

    // ---------- STORAGE: ИДЕМПОТЕНТНОСТЬ / ГОНКИ ----------

    it('idempotency: повтор wa_message_id → 23505, первая строка не перезатёрта (count = 1)', async () => {
        const waId = `${WA_PREFIX}dup`;
        await incoming(CHAT, waId, { media_type: 'image', media_id: 'E2E_atk_cm_dup_first' });

        let code: string | undefined;
        try {
            await incoming(CHAT, waId, { media_type: 'video', media_id: 'E2E_atk_cm_dup_second' });
        } catch (error) {
            code = (error as { code?: string }).code;
        }
        assert.equal(code, '23505', 'повтор обязан упасть unique-нарушением, не молча');

        const rows = await dbQuery<{ media_type: string; media_id: string }>(
            `select media_type, media_id from wa_messages where wa_message_id = $1`,
            [waId],
        );
        assert.equal(rows.length, 1, 'ровно одна строка на wa_message_id');
        assert.equal(rows[0]?.media_type, 'image', 'победила первая вставка');
        assert.equal(rows[0]?.media_id, 'E2E_atk_cm_dup_first', 'media_id не перезатёрт');
    });

    it('race: N параллельных вставок одного wa_message_id → ровно одна строка, остальные 23505', async () => {
        const waId = `${WA_PREFIX}race`;
        const N = 6;
        const results = await Promise.allSettled(
            Array.from({ length: N }, (_, i) =>
                incoming(RACE_CHAT, waId, {
                    media_type: 'image',
                    media_id: `E2E_atk_cm_race_${i}`,
                }),
            ),
        );
        const won = results.filter((r) => r.status === 'fulfilled').length;
        const lost = results.filter(
            (r) => r.status === 'rejected' && (r.reason as { code?: string }).code === '23505',
        ).length;
        assert.equal(won, 1, 'победил ровно один');
        assert.equal(lost, N - 1, 'остальные поймали unique-нарушение (не иной сбой)');

        const count = await dbOne<{ n: string }>(
            `select count(*)::text as n from wa_messages where wa_message_id = $1`,
            [waId],
        );
        assert.equal(count?.n, '1', 'дубля в БД нет');
        const chatCount = await dbOne<{ n: string }>(
            `select count(*)::text as n from wa_messages where wa_chat_phone = $1`,
            [RACE_CHAT],
        );
        assert.equal(chatCount?.n, '1', 'в чате ровно одна строка');
    });

    it('paused: чат на паузе → worker_status skipped, медиа всё равно записано', async () => {
        const waId = `${WA_PREFIX}paused`;
        await incoming(PAUSED_CHAT, waId, {
            media_type: 'audio',
            media_id: 'E2E_atk_cm_paused_id',
        });
        const row = await dbOne<{ worker_status: string; media_type: string; media_id: string }>(
            `select worker_status, media_type, media_id from wa_messages where wa_message_id = $1`,
            [waId],
        );
        assert.equal(row?.worker_status, 'skipped');
        assert.equal(row?.media_type, 'audio');
        assert.equal(row?.media_id, 'E2E_atk_cm_paused_id');
    });

    it('missing chat: чат отсутствует → строки нет, без исключения (insert ... select from wa_chats)', async () => {
        const waId = `${WA_PREFIX}missing`;
        await incoming(MISSING_CHAT, waId, {
            media_type: 'image',
            media_id: 'E2E_atk_cm_missing_id',
        });
        const count = await dbOne<{ n: string }>(
            `select count(*)::text as n from wa_messages where wa_message_id = $1`,
            [waId],
        );
        assert.equal(count?.n, '0', 'без wa_chats строка не ложится (FK не нарушается)');
    });
});
