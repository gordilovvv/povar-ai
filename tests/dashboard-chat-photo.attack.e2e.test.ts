// Attack-приёмка: chatSendPhotoHandler (POST /chats/:phone/photo, одно фото за запрос)
//                  mediaGetHandler     (GET  /media/:id)
// Каждая проба бьёт в dashboardFetch и сверяется с фактом в БД (dbOne/dbQuery), не с ответом ручки.
// WhatsApp мокаем на globalThis.fetch (graph.facebook.com + lookaside) — реальный WA дёргать нельзя.
// Чистим строго свои строки с префиксом E2E_atk_cp.
//
// Векторы: auth (нет/битый/протухший/orphan токен) → 401 без WA и записи;
//          инъекция в :phone и в :id → 404/400, таблицы целы, значение не SQL;
//          кривой ввод (нет photo, photo строкой, не-image mime, >5МБ, пустой файл,
//                       caption не строкой/пустой/>1024, json/urlencoded/битый multipart) → 400;
//          несколько полей photo → ровно один upload/send/строка;
//          падение WA (upload / send) → 500 без строки в БД;
//          media вне переписки / исчезнувшее в WA → 404;
//          гонки: параллельные POST — по строке на запрос, last_sent не откатывается назад.

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
    measure,
    seedDashboardUser,
    signAuthToken,
    withClient,
} from './helpers/e2e.ts';

const DASH_PHONE = 'E2E_atk_cp_user';
const SEND_CHAT = 'E2E_atk_cp_send';
const NOWRITE_CHAT = 'E2E_atk_cp_nowrite';
const FAIL_CHAT = 'E2E_atk_cp_fail';
const RACE_CHAT = 'E2E_atk_cp_race';
const FUTURE_CHAT = 'E2E_atk_cp_future';
const MISSING_CHAT = 'E2E_atk_cp_missing';
const ALL_CHATS = [SEND_CHAT, NOWRITE_CHAT, FAIL_CHAT, RACE_CHAT, FUTURE_CHAT];

const OLD_SENT = '2020-01-01T00:00:00.000Z';
const FUTURE_SENT = '2099-01-01T00:00:00.000Z';
const STORED_MEDIA_ID = 'MEDIA_E2E_atk_cp_stored';

const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
);

let token = '';
let userId = '';

const realFetch = globalThis.fetch;

const wa = {
    uploadStatus: 200,
    sendStatus: 200,
    metaStatus: 200,
    metaBody: null as unknown,
    fileStatus: 200,
};

const uploads: { mimeType: string; size: number }[] = [];
const sends: { to: string; mediaId: string; caption: string | null }[] = [];
const metaCalls: string[] = [];

function resetWa(): void {
    wa.uploadStatus = 200;
    wa.sendStatus = 200;
    wa.metaStatus = 200;
    wa.metaBody = null;
    wa.fileStatus = 200;
    uploads.length = 0;
    sends.length = 0;
    metaCalls.length = 0;
}

function installWaStub(): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

        if (url.includes('lookaside.e2e')) {
            if (wa.fileStatus !== 200) {
                return new Response('gone', { status: wa.fileStatus });
            }
            return new Response(PNG_BYTES, { headers: { 'content-type': 'image/png' } });
        }
        if (!url.includes('graph.facebook.com')) {
            return realFetch(input, init);
        }

        if (url.endsWith('/media')) {
            const form = init?.body as FormData;
            const file = form.get('file');
            uploads.push({
                mimeType: String(form.get('type')),
                size: file instanceof Blob ? file.size : -1,
            });
            if (wa.uploadStatus !== 200) {
                return new Response('upload rejected', { status: wa.uploadStatus });
            }
            return Response.json({ id: `MEDIA_E2E_atk_${ulid()}` });
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
            if (wa.sendStatus !== 200) {
                return new Response('send rejected', { status: wa.sendStatus });
            }
            return Response.json({
                messaging_product: 'whatsapp',
                messages: [{ id: `wamid.E2E_atk_${ulid()}` }],
            });
        }

        const mediaId = url.slice(url.lastIndexOf('/') + 1);
        metaCalls.push(mediaId);
        if (wa.metaStatus !== 200) {
            return Response.json(wa.metaBody ?? { error: {} }, { status: wa.metaStatus });
        }
        return Response.json({ url: `https://lookaside.e2e/${mediaId}`, mime_type: 'image/png' });
    }) as typeof fetch;
}

async function cleanup(): Promise<void> {
    await withClient(async (client) => {
        await client.query(`delete from wa_messages where wa_chat_phone = any($1)`, [
            [...ALL_CHATS, MISSING_CHAT],
        ]);
        await client.query(`delete from wa_chats where wa_phone = any($1)`, [
            [...ALL_CHATS, MISSING_CHAT],
        ]);
        await client.query(`delete from dashboard_users where phone_number = $1`, [DASH_PHONE]);
    });
}

async function seed(): Promise<void> {
    await withClient(async (client) => {
        for (const phone of [SEND_CHAT, NOWRITE_CHAT, FAIL_CHAT, RACE_CHAT]) {
            await client.query(
                `insert into wa_chats (wa_phone, last_sent_message_at) values ($1, $2)`,
                [phone, toDateTime(new Date(OLD_SENT))],
            );
        }
        await client.query(
            `insert into wa_chats (wa_phone, last_sent_message_at) values ($1, $2)`,
            [FUTURE_CHAT, toDateTime(new Date(FUTURE_SENT))],
        );
        await client.query(
            `insert into wa_messages
                (id, wa_message_id, wa_chat_phone, text, owner, status, sent_at, media_type, media_id)
             values ($1, $2, $3, null, 'sema', 'sent', $4, 'image', $5)`,
            [
                ulid(),
                `wamid.E2E_atk_seed_${ulid()}`,
                SEND_CHAT,
                toDateTime(new Date(OLD_SENT)),
                STORED_MEDIA_ID,
            ],
        );
    });
}

function photoForm(mimeType: string, caption?: string, bytes: Buffer = PNG_BYTES): FormData {
    const form = new FormData();
    form.append('photo', new File([bytes], 'photo.png', { type: mimeType }));
    if (caption !== undefined) {
        form.append('caption', caption);
    }
    return form;
}

function post(
    phone: string,
    body: BodyInit,
    options: { auth?: string | null; contentType?: string } = {},
): Promise<Response> {
    const auth = options.auth === undefined ? token : options.auth;
    const headers: Record<string, string> = {};
    if (auth !== null) {
        headers.authorization = `Bearer ${auth}`;
    }
    if (options.contentType) {
        headers['content-type'] = options.contentType;
    }
    return dashboardFetch(
        new Request(`http://dashboard/chats/${encodeURIComponent(phone)}/photo`, {
            method: 'POST',
            headers,
            body,
        }),
    );
}

function getMedia(mediaId: string, auth: string | null = token): Promise<Response> {
    const headers: Record<string, string> = {};
    if (auth !== null) {
        headers.authorization = `Bearer ${auth}`;
    }
    return dashboardFetch(
        new Request(`http://dashboard/media/${encodeURIComponent(mediaId)}`, { headers }),
    );
}

async function msgCount(phone: string): Promise<number> {
    const row = await dbOne<{ n: number }>(
        `select count(*)::int as n from wa_messages where wa_chat_phone = $1`,
        [phone],
    );
    return Number(row?.n ?? 0);
}

async function lastSent(phone: string): Promise<number> {
    const row = await dbOne<{ last_sent_message_at: string | null }>(
        `select last_sent_message_at from wa_chats where wa_phone = $1`,
        [phone],
    );
    return new Date(`${row?.last_sent_message_at ?? 0}`).getTime();
}

describe('attack: dashboard chatSendPhoto + mediaGet', () => {
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

    it('photo: нет / битый / протухший / orphan токен → 401, WA не дёрнут, в БД пусто', async () => {
        const orphan = signJwt(
            { sub: ulid(), exp: Math.floor(Date.now() / 1000) + 3600 },
            process.env.JWT_SECRET ?? '',
        );
        const wrongSecret = signJwt(
            { sub: userId, exp: Math.floor(Date.now() / 1000) + 3600 },
            'not-our-secret',
        );
        const cases: [string, string | null][] = [
            ['без токена', null],
            ['мусор вместо jwt', 'garbage.token.value'],
            ['чужая подпись', wrongSecret],
            ['протухший', signAuthToken(userId, -60)],
            ['удалённый юзер', orphan],
        ];
        for (const [label, auth] of cases) {
            resetWa();
            const res = await post(NOWRITE_CHAT, photoForm('image/png', 'hi'), { auth });
            assert.equal(res.status, 401, `${label} → 401`);
            assert.equal(uploads.length, 0, `${label}: media не грузится`);
            assert.equal(sends.length, 0, `${label}: WA не вызван`);
        }
        assert.equal(await msgCount(NOWRITE_CHAT), 0, 'без авторизации ни одной строки');
        assert.equal(await lastSent(NOWRITE_CHAT), new Date(OLD_SENT).getTime(), 'last_sent цел');
    });

    it('media: нет / протухший / orphan токен → 401, байты не отданы, WA не дёрнут', async () => {
        const orphan = signJwt(
            { sub: ulid(), exp: Math.floor(Date.now() / 1000) + 3600 },
            process.env.JWT_SECRET ?? '',
        );
        for (const auth of [null, signAuthToken(userId, -60), orphan, 'garbage']) {
            resetWa();
            const res = await getMedia(STORED_MEDIA_ID, auth);
            assert.equal(res.status, 401, 'media без валидного токена → 401');
            assert.ok(
                !(res.headers.get('content-type') ?? '').startsWith('image/'),
                'байты медиа не утекают',
            );
            assert.equal(metaCalls.length, 0, 'WA не дёрнут без авторизации');
        }
    });

    // ---------- ИНЪЕКЦИИ / IDOR ----------

    it('photo: инъекция в :phone → 404, таблицы целы, WA не дёрнут', async () => {
        resetWa();
        const evil = `${SEND_CHAT}'); drop table wa_messages; --`;
        const res = await post(evil, photoForm('image/png', 'hi'));
        assert.notEqual(res.status, 500, 'инъекция не роняет хендлер');
        assert.equal(res.status, 404, 'evil phone — значение, не SQL');
        assert.equal(uploads.length, 0, 'на 404 media не грузится');
        assert.equal(sends.length, 0);
        const reg = await dbOne<{ m: string | null; c: string | null }>(
            `select to_regclass('public.wa_messages') as m, to_regclass('public.wa_chats') as c`,
        );
        assert.equal(reg?.m, 'wa_messages', 'таблица wa_messages цела');
        assert.equal(reg?.c, 'wa_chats', 'таблица wa_chats цела');
    });

    it('media: инъекция в :id → 404, таблица цела, WA не дёрнут', async () => {
        resetWa();
        const res = await getMedia(`${STORED_MEDIA_ID}' or '1'='1`);
        assert.notEqual(res.status, 500);
        assert.equal(res.status, 404, 'or 1=1 не открывает чужое медиа');
        assert.equal(metaCalls.length, 0, 'до WA не дошло');

        const dropRes = await getMedia(`x'; drop table wa_messages; --`);
        assert.equal(dropRes.status, 404);
        const reg = await dbOne<{ m: string | null }>(
            `select to_regclass('public.wa_messages') as m`,
        );
        assert.equal(reg?.m, 'wa_messages', 'таблица цела');
    });

    it('photo: сверхдлинный phone (>512) → 400 без WA', async () => {
        resetWa();
        const res = await post('a'.repeat(600), photoForm('image/png'));
        assert.notEqual(res.status, 500);
        assert.equal(res.status, 400);
        assert.equal(uploads.length, 0);
    });

    it('photo: SQL-мета в caption уходит значением, verbatim, ровно одна строка', async () => {
        resetWa();
        const evil = `x'); drop table wa_messages; -- ё —`;
        const before = await msgCount(SEND_CHAT);
        const res = await post(SEND_CHAT, photoForm('image/jpeg', evil));
        assert.equal(res.status, 200);
        const { mediaId } = (await res.json()) as { mediaId: string };
        const row = await dbOne<{
            text: string;
            media_type: string;
            owner: string;
            status: string;
        }>(`select text, media_type, owner, status from wa_messages where media_id = $1`, [
            mediaId,
        ]);
        assert.equal(row?.text, evil, 'подпись легла значением, verbatim');
        assert.equal(row?.media_type, 'image');
        assert.equal(row?.owner, 'sema');
        assert.equal(row?.status, 'sent');
        assert.equal(await msgCount(SEND_CHAT), before + 1, 'ровно одна новая строка');
        const reg = await dbOne<{ m: string | null }>(
            `select to_regclass('public.wa_messages') as m`,
        );
        assert.equal(reg?.m, 'wa_messages');
    });

    // ---------- КРИВОЙ ВВОД ----------

    it('photo: кривая форма → 400, WA не дёрнут, в БД пусто', async () => {
        const bigCaption = 'a'.repeat(1025);
        const noPhoto = new FormData();
        noPhoto.append('caption', 'hi');

        const photoAsString = new FormData();
        photoAsString.append('photo', 'not-a-file');

        const emptyFile = new FormData();
        emptyFile.append('photo', new File([], 'photo.png', { type: 'image/png' }));

        const captionAsFile = photoForm('image/png');
        captionAsFile.append('caption', new File([PNG_BYTES], 'c.txt', { type: 'text/plain' }));

        const cases: [string, FormData][] = [
            ['нет поля photo', noPhoto],
            ['photo строкой', photoAsString],
            ['пустой файл', emptyFile],
            ['mime text/plain', photoForm('text/plain')],
            ['mime application/octet-stream', photoForm('application/octet-stream')],
            ['mime image/gif', photoForm('image/gif')],
            ['mime пустой', photoForm('')],
            ['caption файлом', captionAsFile],
            ['caption пустой строкой', photoForm('image/png', '')],
            ['caption >1024', photoForm('image/png', bigCaption)],
        ];
        for (const [label, form] of cases) {
            resetWa();
            const res = await post(NOWRITE_CHAT, form);
            assert.equal(res.status, 400, `${label} → 400`);
            assert.equal(uploads.length, 0, `${label}: media не грузится`);
            assert.equal(sends.length, 0, `${label}: WA не вызван`);
        }
        assert.equal(await msgCount(NOWRITE_CHAT), 0, 'кривой ввод не оставил строк');
        assert.equal(await lastSent(NOWRITE_CHAT), new Date(OLD_SENT).getTime(), 'last_sent цел');
    });

    it('photo: файл >5 МБ → 400, WA не дёрнут, в БД пусто', async () => {
        resetWa();
        const huge = Buffer.alloc(5 * 1024 * 1024 + 1, 1);
        const { result: res } = await measure('POST photo 5MB+1', () =>
            post(NOWRITE_CHAT, photoForm('image/jpeg', undefined, huge)),
        );
        assert.equal(res.status, 400, 'файл больше лимита отбит');
        assert.equal(uploads.length, 0, 'гигантский файл не улетел в WA');
        assert.equal(await msgCount(NOWRITE_CHAT), 0);
    });

    it('photo: тело не multipart (json / urlencoded / битый multipart / пусто) → 400', async () => {
        const cases: [string, BodyInit, string | undefined][] = [
            ['json', JSON.stringify({ photo: 'x' }), 'application/json'],
            ['urlencoded', 'photo=abc&caption=hi', 'application/x-www-form-urlencoded'],
            ['битый multipart', 'garbage-not-a-part', 'multipart/form-data; boundary=----atk'],
            ['текст без content-type', 'plain body', undefined],
        ];
        for (const [label, body, contentType] of cases) {
            resetWa();
            const res = await post(NOWRITE_CHAT, body, { contentType });
            assert.equal(res.status, 400, `${label} → 400`);
            assert.equal(uploads.length, 0, `${label}: WA не дёрнут`);
        }
        assert.equal(await msgCount(NOWRITE_CHAT), 0);
    });

    it('photo: несуществующий чат → 404, WA не дёрнут, строк нет', async () => {
        resetWa();
        const res = await post(MISSING_CHAT, photoForm('image/png', 'hi'));
        assert.equal(res.status, 404);
        assert.equal(uploads.length, 0);
        assert.equal(sends.length, 0);
        assert.equal(await msgCount(MISSING_CHAT), 0);
    });

    // ---------- НЕСКОЛЬКО ПОЛЕЙ photo ----------

    it('photo: два поля photo → берётся первое, ровно один upload/send/строка', async () => {
        resetWa();
        const before = await msgCount(SEND_CHAT);
        const form = new FormData();
        form.append('photo', new File([PNG_BYTES], 'first.png', { type: 'image/png' }));
        form.append(
            'photo',
            new File([Buffer.alloc(4096, 7)], 'second.jpg', { type: 'image/jpeg' }),
        );
        form.append('caption', 'два поля');
        const res = await post(SEND_CHAT, form);
        assert.equal(res.status, 200);
        const { mediaId } = (await res.json()) as { mediaId: string };

        assert.equal(uploads.length, 1, 'ровно одна загрузка медиа');
        assert.equal(uploads[0]?.mimeType, 'image/png', 'ушло первое поле, не второе');
        assert.equal(uploads[0]?.size, PNG_BYTES.length, 'байты первого файла');
        assert.equal(sends.length, 1, 'ровно одно сообщение в WA');
        assert.equal(sends[0]?.mediaId, mediaId);
        assert.equal(await msgCount(SEND_CHAT), before + 1, 'в БД ровно одна новая строка');
    });

    it('photo: дубли caption → берётся первый, одна строка', async () => {
        resetWa();
        const before = await msgCount(SEND_CHAT);
        const form = photoForm('image/png', 'первый');
        form.append('caption', 'второй');
        const res = await post(SEND_CHAT, form);
        assert.equal(res.status, 200);
        const { mediaId } = (await res.json()) as { mediaId: string };
        const row = await dbOne<{ text: string }>(
            `select text from wa_messages where media_id = $1`,
            [mediaId],
        );
        assert.equal(row?.text, 'первый');
        assert.equal(await msgCount(SEND_CHAT), before + 1);
    });

    // ---------- ПАДЕНИЕ WA ----------

    it('photo: WA завалил upload → 500, ни строки, last_sent не сдвинут', async () => {
        resetWa();
        wa.uploadStatus = 500;
        const res = await post(FAIL_CHAT, photoForm('image/png', 'hi'));
        assert.equal(res.status, 500);
        assert.equal(sends.length, 0, 'без media_id сообщение не отправляется');
        assert.equal(await msgCount(FAIL_CHAT), 0, 'строки нет');
        assert.equal(await lastSent(FAIL_CHAT), new Date(OLD_SENT).getTime());
    });

    it('photo: upload ок, но send завалился → 500 и ни строки в БД', async () => {
        resetWa();
        wa.sendStatus = 500;
        const res = await post(FAIL_CHAT, photoForm('image/png', 'hi'));
        assert.equal(res.status, 500);
        assert.equal(uploads.length, 1);
        assert.equal(await msgCount(FAIL_CHAT), 0, 'недоставленное не записано');
        assert.equal(await lastSent(FAIL_CHAT), new Date(OLD_SENT).getTime());
    });

    it('photo: caption с управляющим символом — либо 400 до WA, либо доставленное записано', async () => {
        for (const char of ['\u0000', '\u0001', '\u001b', '\u007f']) {
            resetWa();
            const before = await msgCount(FAIL_CHAT);
            const res = await post(FAIL_CHAT, photoForm('image/png', `при${char}вет`));
            const rows = await msgCount(FAIL_CHAT);
            if (sends.length === 0) {
                assert.equal(res.status, 400, `U+${char.codePointAt(0)}: отбит до похода в WA`);
                assert.equal(rows, before, `U+${char.codePointAt(0)}: следов в БД нет`);
                continue;
            }
            // Фото уже у гостя: строка обязана быть, иначе история врёт админу.
            assert.equal(
                res.status,
                200,
                `U+${char.codePointAt(0)}: фото ушло в WA, а ручка отвечает ${res.status}`,
            );
            assert.equal(
                rows,
                before + 1,
                `U+${char.codePointAt(0)}: фото доставлено в WA, но строки в wa_messages нет`,
            );
        }
    });

    it('photo: подпись с переносом строки — в БД ровно то, что ушло в WA', async () => {
        resetWa();
        const before = await msgCount(SEND_CHAT);
        const caption = 'строка1\nстрока2\tтаб';
        const res = await post(SEND_CHAT, photoForm('image/png', caption));
        assert.equal(res.status, 200, 'перенос строки и таб — не кривой ввод');
        const { mediaId } = (await res.json()) as { mediaId: string };
        const row = await dbOne<{ text: string }>(
            `select text from wa_messages where media_id = $1`,
            [mediaId],
        );
        // multipart нормализует одиночный \n в \r\n на стороне клиента — сверяем БД с тем, что реально ушло в WA.
        assert.equal(row?.text, sends[0]?.caption, 'в БД лежит ровно та подпись, что ушла гостю');
        assert.equal(row?.text, 'строка1\r\nстрока2\tтаб', 'подпись не обрезана и не вычищена');
        assert.equal(await msgCount(SEND_CHAT), before + 1, 'ровно одна новая строка');
    });

    // ---------- MEDIA ----------

    it('media: id не из переписки → 404 до похода в WA', async () => {
        resetWa();
        const res = await getMedia('MEDIA_E2E_atk_cp_foreign');
        assert.equal(res.status, 404);
        assert.equal(metaCalls.length, 0, 'чужое медиа не проксируется в WA');
    });

    it('media: WA отдал 404 на метаданные / на файл → 404, не 500', async () => {
        resetWa();
        wa.metaStatus = 404;
        const meta = await getMedia(STORED_MEDIA_ID);
        assert.equal(meta.status, 404, 'исчезнувшие метаданные → 404');

        resetWa();
        wa.fileStatus = 404;
        const file = await getMedia(STORED_MEDIA_ID);
        assert.equal(file.status, 404, 'исчезнувший файл → 404');
    });

    it('media: истёкшее медиа (Graph 400 / code 100) → 404, не 500', async () => {
        resetWa();
        wa.metaStatus = 400;
        wa.metaBody = {
            error: {
                message: `Unsupported get request. Object with ID '${STORED_MEDIA_ID}' does not exist`,
                type: 'GraphMethodException',
                code: 100,
                error_subcode: 33,
            },
        };
        const res = await getMedia(STORED_MEDIA_ID);
        assert.equal(res.status, 404, 'протухший media_id в WA → 404 по контракту');
    });

    it('media: прочие отказы WA не маскируются под 404 (fail-fast цел)', async () => {
        const cases: [string, number, unknown][] = [
            ['протухший WA-токен (code 190)', 401, { error: { code: 190, message: 'bad token' } }],
            ['rate limit (code 4)', 429, { error: { code: 4, message: 'too many calls' } }],
            ['не-JSON тело', 500, 'gateway down'],
        ];
        for (const [label, status, body] of cases) {
            resetWa();
            wa.metaStatus = status;
            wa.metaBody = body;
            const res = await getMedia(STORED_MEDIA_ID);
            assert.equal(res.status, 500, `${label}: отказ WA не выдаётся за «медиа нет»`);
        }
    });

    it('media: сверхдлинный id → 400, WA не дёрнут', async () => {
        resetWa();
        const res = await getMedia('m'.repeat(600));
        assert.notEqual(res.status, 500);
        assert.equal(res.status, 400);
        assert.equal(metaCalls.length, 0);
    });

    // ---------- ГОНКИ ----------

    it('race: 3 параллельных POST → 3 строки, 3 разных media_id, дублей нет', async () => {
        resetWa();
        const before = await msgCount(RACE_CHAT);
        const results = await Promise.allSettled([
            post(RACE_CHAT, photoForm('image/png', 'r1')),
            post(RACE_CHAT, photoForm('image/png', 'r2')),
            post(RACE_CHAT, photoForm('image/png', 'r3')),
        ]);
        for (const r of results) {
            assert.equal(r.status, 'fulfilled', 'параллельный POST не падает');
            if (r.status === 'fulfilled') {
                assert.equal(r.value.status, 200);
            }
        }
        assert.equal(
            await msgCount(RACE_CHAT),
            before + 3,
            'ровно 3 строки — ни дублей, ни потерь',
        );
        const distinct = await dbOne<{ n: number; total: number }>(
            `select count(distinct media_id)::int as n, count(*)::int as total
             from wa_messages where wa_chat_phone = $1`,
            [RACE_CHAT],
        );
        assert.equal(Number(distinct?.n), 3, 'у каждой строки свой media_id');
        assert.equal(Number(distinct?.total), 3);
        const dup = await dbOne<{ n: number }>(
            `select count(*)::int as n from (
                select wa_message_id from wa_messages where wa_chat_phone = $1
                group by wa_message_id having count(*) > 1
             ) d`,
            [RACE_CHAT],
        );
        assert.equal(Number(dup?.n ?? 0), 0, 'нет дублей по wa_message_id');
        const chatRows = await dbQuery(`select 1 from wa_chats where wa_phone = $1`, [RACE_CHAT]);
        assert.equal(chatRows.length, 1, 'чат остался одной строкой');
        assert.ok(
            (await lastSent(RACE_CHAT)) > new Date(OLD_SENT).getTime(),
            'last_sent сдвинут вперёд после гонки',
        );
    });

    it('race: last_sent_message_at не откатывается назад (greatest)', async () => {
        resetWa();
        const res = await post(FUTURE_CHAT, photoForm('image/png', 'future'));
        assert.equal(res.status, 200);
        assert.equal(
            await lastSent(FUTURE_CHAT),
            new Date(FUTURE_SENT).getTime(),
            'более свежий last_sent не перезатёрт значением now',
        );
        assert.equal(await msgCount(FUTURE_CHAT), 1, 'строка всё равно записана');
    });
});
