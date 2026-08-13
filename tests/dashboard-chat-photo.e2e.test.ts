// Задача модуля (chatSendPhotoHandler + mediaGetHandler):
//   вход  → POST /chats/:phone/photo  multipart: photo: File (image/jpeg|png|webp, ≤5 МБ),
//           caption: string (опц., ≤1024 символа)   (Bearer JWT, гейт withAuthorization)
//           GET  /media/:id
//   выход → photo: { mediaId }; upload в WA media + отправка type=image, одна строка в wa_messages
//                  (owner='sema', status='sent', media_type='image', media_id из ответа WA,
//                  text = подпись или null), last_sent_message_at = greatest(старого, now)
//           media: байты медиа с content-type от WA, только для media_id из нашей переписки
//   бюджет → сеть/БД жёстко не меряем, только measure()
//   негатив → чат не найден → 404; media_id не из переписки или истёк в WA → 404;
//             кривой ввод (нет файла, не image, >5 МБ, пустой файл, битая подпись) → 400 (в .attack)

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

const DASH_PHONE = 'E2E_chatphoto_user';
const SEND_CHAT = 'E2E_cp_send';
const MISSING_CHAT = 'E2E_cp_missing';
const OLD_SENT = '2020-01-01T00:00:00.000Z';

// Настоящий однопиксельный PNG: mime проверяется по типу File, но байты гоняем не синтетические.
const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
);

let token = '';
const realFetch = globalThis.fetch;
const uploads: { mimeType: string }[] = [];
const sends: { to: string; mediaId: string; caption: string | null }[] = [];

function installWaStub(): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

        if (url.includes('lookaside.e2e')) {
            return new Response(PNG_BYTES, { headers: { 'content-type': 'image/png' } });
        }
        if (!url.includes('graph.facebook.com')) {
            return realFetch(input, init);
        }

        if (url.endsWith('/media')) {
            const form = init?.body as FormData;
            uploads.push({ mimeType: String(form.get('type')) });
            return Response.json({ id: `MEDIA_E2E_${ulid()}` });
        }
        if (url.endsWith('/messages')) {
            const payload = JSON.parse(String(init?.body)) as {
                to: string;
                image?: { id: string; caption?: string };
            };
            sends.push({
                to: payload.to,
                mediaId: payload.image?.id ?? '',
                caption: payload.image?.caption ?? null,
            });
            return Response.json({
                messaging_product: 'whatsapp',
                messages: [{ id: `wamid.E2E_${ulid()}` }],
            });
        }

        const mediaId = url.slice(url.lastIndexOf('/') + 1);
        return Response.json({ url: `https://lookaside.e2e/${mediaId}`, mime_type: 'image/png' });
    }) as typeof fetch;
}

async function cleanup(): Promise<void> {
    await withClient(async (client) => {
        await client.query(`delete from wa_messages where wa_chat_phone = any($1)`, [
            [SEND_CHAT, MISSING_CHAT],
        ]);
        await client.query(`delete from wa_chats where wa_phone = any($1)`, [
            [SEND_CHAT, MISSING_CHAT],
        ]);
        await client.query(`delete from dashboard_users where phone_number = $1`, [DASH_PHONE]);
    });
}

function photoForm(mimeType: string, caption?: string): FormData {
    const form = new FormData();
    form.append('photo', new File([PNG_BYTES], 'photo', { type: mimeType }));
    if (caption !== undefined) {
        form.append('caption', caption);
    }
    return form;
}

async function sendPhoto(phone: string, form: FormData): Promise<Response> {
    const { result } = await measure(`POST /chats/${phone}/photo`, () =>
        dashboardFetch(
            new Request(`http://dashboard/chats/${encodeURIComponent(phone)}/photo`, {
                method: 'POST',
                headers: { authorization: `Bearer ${token}` },
                body: form,
            }),
        ),
    );
    return result;
}

async function getMedia(mediaId: string): Promise<Response> {
    const { result } = await measure(`GET /media/${mediaId}`, () =>
        dashboardFetch(
            new Request(`http://dashboard/media/${encodeURIComponent(mediaId)}`, {
                headers: { authorization: `Bearer ${token}` },
            }),
        ),
    );
    return result;
}

describe('e2e: dashboard chatSendPhoto + mediaGet', () => {
    before(async () => {
        await cleanup();
        const userId = await seedDashboardUser(DASH_PHONE);
        token = signAuthToken(userId);
        await withClient(async (client) => {
            await client.query(
                `insert into wa_chats (wa_phone, last_sent_message_at) values ($1, $2)`,
                [SEND_CHAT, toDateTime(new Date(OLD_SENT))],
            );
        });
        installWaStub();
    });

    after(async () => {
        globalThis.fetch = realFetch;
        await cleanup();
        await closePool();
        await dashboardPool.end();
    });

    it('фото с подписью → upload+send в WA, строка с media_id в БД', async () => {
        uploads.length = 0;
        sends.length = 0;
        const caption = 'Первое — ёлка';
        const res = await sendPhoto(SEND_CHAT, photoForm('image/jpeg', caption));
        assert.equal(res.status, 200);
        const body = (await res.json()) as { mediaId: string };
        assert.ok(body.mediaId.startsWith('MEDIA_E2E_'), 'ручка вернула media_id из WA');

        assert.equal(uploads.length, 1, 'ровно одна media-загрузка');
        assert.equal(uploads[0]?.mimeType, 'image/jpeg', 'mime фото уходит в WA как есть');
        assert.equal(sends.length, 1, 'ровно одна отправка');
        assert.equal(sends[0]?.to, SEND_CHAT);
        assert.equal(sends[0]?.mediaId, body.mediaId, 'отправлено то же медиа, что вернула ручка');
        assert.equal(sends[0]?.caption, caption, 'подпись ушла в WA вербатим');

        // Сверка с фактом в БД.
        const rows = await dbQuery<{
            text: string | null;
            owner: string;
            status: string;
            media_type: string | null;
            media_id: string | null;
            wa_message_id: string;
        }>(
            `select text, owner, status, media_type, media_id, wa_message_id from wa_messages
             where wa_chat_phone = $1 order by id asc`,
            [SEND_CHAT],
        );
        assert.equal(rows.length, 1, 'ровно 1 строка, дублей нет');
        assert.equal(rows[0]?.owner, 'sema');
        assert.equal(rows[0]?.status, 'sent');
        assert.equal(rows[0]?.media_type, 'image');
        assert.equal(rows[0]?.media_id, body.mediaId, 'media_id в БД — тот же, что вернула ручка');
        assert.equal(rows[0]?.text, caption, 'подпись легла в text вербатим (ё не срезана)');
        assert.ok(rows[0]?.wa_message_id.startsWith('wamid.E2E_'));

        const chat = await dbOne<{ last_sent_message_at: string }>(
            `select last_sent_message_at from wa_chats where wa_phone = $1`,
            [SEND_CHAT],
        );
        assert.ok(
            new Date(chat?.last_sent_message_at ?? 0).getTime() > new Date(OLD_SENT).getTime(),
            'last_sent_message_at обновлён на now',
        );
    });

    it('фото без подписи → text в БД null, caption в WA не уходит', async () => {
        uploads.length = 0;
        sends.length = 0;
        const res = await sendPhoto(SEND_CHAT, photoForm('image/webp'));
        assert.equal(res.status, 200);
        const body = (await res.json()) as { mediaId: string };

        assert.equal(uploads[0]?.mimeType, 'image/webp');
        assert.equal(sends[0]?.caption, null, 'без подписи поле caption в WA не передаётся');
        const row = await dbOne<{ text: string | null }>(
            `select text from wa_messages where media_id = $1`,
            [body.mediaId],
        );
        assert.equal(row?.text, null, 'text остаётся null');
    });

    it('история чата отдаёт mediaType/mediaId — админке есть что рендерить', async () => {
        const res = await dashboardFetch(
            new Request(`http://dashboard/chats/${SEND_CHAT}/messages`, {
                headers: { authorization: `Bearer ${token}` },
            }),
        );
        assert.equal(res.status, 200);
        const body = (await res.json()) as {
            items: { mediaType: string | null; mediaId: string | null }[];
        };
        assert.equal(body.items.length, 2);
        assert.ok(
            body.items.every((i) => i.mediaType === 'image' && i.mediaId?.startsWith('MEDIA_E2E_')),
            'каждое сообщение отдаёт media_type и media_id',
        );
    });

    it('GET /media/:id → байты фото; чужой media_id → 404', async () => {
        const stored = await dbOne<{ media_id: string }>(
            `select media_id from wa_messages where wa_chat_phone = $1 order by id asc limit 1`,
            [SEND_CHAT],
        );
        const res = await getMedia(stored?.media_id ?? '');
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'image/png');
        const bytes = Buffer.from(await res.arrayBuffer());
        assert.deepEqual(bytes, PNG_BYTES, 'отдан ровно тот файл, что лежит в WA');

        const foreign = await getMedia('MEDIA_E2E_NOT_IN_OUR_CHATS');
        assert.equal(foreign.status, 404, 'media_id вне переписки не отдаётся');
    });

    it('несуществующий чат → 404, WA не дёрнут, строк нет', async () => {
        uploads.length = 0;
        sends.length = 0;
        const res = await sendPhoto(MISSING_CHAT, photoForm('image/png'));
        assert.equal(res.status, 404);
        assert.equal(uploads.length, 0, 'на 404 media не грузится');
        assert.equal(sends.length, 0, 'на 404 WhatsApp не вызывался');
        const row = await dbOne(`select 1 from wa_messages where wa_chat_phone = $1`, [
            MISSING_CHAT,
        ]);
        assert.equal(row, null, 'ничего не записано для несуществующего чата');
    });
});
