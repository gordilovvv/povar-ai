// Attack-приёмка: mediaGetHandler (GET /media/:id) — content-disposition / nosniff / отказы.
// Медиа реально грузим в WhatsApp (uploadWhatsappMedia), строки wa_messages сеем под E2E_mg_atk.
// Поход в WA считаем шпионом поверх globalThis.fetch (делегирует в настоящий fetch) —
// «404/401 без WA» доказываем счётчиком, не словами. Чистим строго свои строки.
//
// Векторы: auth (нет/битый/чужой секрет/протухший/orphan) → 401, WA не дёрнут;
//          id не из wa_messages → 404 без WA; SQL-мета / LIKE-мета / traversal / %00 / пробелы /
//          сверхдлинный → 400|404, wa_messages цела, WA не дёрнут;
//          документ любого принятого WA mime (pdf, text/plain с <script>) → attachment + nosniff;
//          image/webp и video/mp4 с HTML-байтами → inline, но nosniff и content-type от WA;
//          svg / html / xhtml под любым объявленным типом — WA отвергает или сниффит в text/plain,
//          ручка отдаёт attachment (вектор закрыт на стороне WA + регекс, фиксируем);
//          параллельные GET одного id → все 200, одинаковые байты, строк в wa_messages не прибавилось.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ulid } from 'ulid';
import { pool as dashboardPool } from '#Dashboard/Db/Pool.js';
import { signJwt } from '#Dashboard/Lib/Jwt.js';
import { dashboardFetch } from '#Dashboard/Router.js';
import { uploadWhatsappMedia } from '#Platforms/Whatsapp/index.js';
import {
    closePool,
    dbOne,
    measure,
    seedDashboardUser,
    signAuthToken,
    withClient,
} from './helpers/e2e.ts';

const TAG = 'E2E_mg_atk';
const DASH_PHONE = `${TAG}_user`;
const CHAT = `${TAG}_chat`;

const HTML = Buffer.from('<html><body><script>alert(document.cookie)</script></body></html>');
// Минимальный валидный PDF — WA принимает application/pdf только с PDF-сигнатурой.
const PDF = Buffer.from(
    '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF',
);

let token = '';
let pdfId = '';
let textId = '';
let webpId = '';
let videoId = '';

const realFetch = globalThis.fetch;
let waCalls: string[] = [];

async function cleanup(): Promise<void> {
    await withClient(async (client) => {
        await client.query(`delete from wa_messages where wa_chat_phone = $1`, [CHAT]);
        await client.query(`delete from wa_chats where wa_phone = $1`, [CHAT]);
        await client.query(`delete from dashboard_users where phone_number = $1`, [DASH_PHONE]);
    });
}

function media(rawId: string, auth: string | null = token): Promise<Response> {
    const headers: Record<string, string> = {};
    if (auth !== null) {
        headers.authorization = `Bearer ${auth}`;
    }
    return dashboardFetch(new Request(`http://dashboard/media/${rawId}`, { headers }));
}

async function seedRows(): Promise<number> {
    const row = await dbOne<{ n: number }>(
        `select count(*)::int as n from wa_messages where wa_chat_phone = $1`,
        [CHAT],
    );
    return Number(row?.n ?? 0);
}

async function tryUpload(type: string, body: Buffer): Promise<string | null> {
    try {
        return await uploadWhatsappMedia(new Blob([body], { type }));
    } catch (error) {
        if (error instanceof Error && error.message.includes('(#100)')) {
            return null;
        }
        throw error;
    }
}

describe('attack: dashboard mediaGet', () => {
    before(async () => {
        await cleanup();
        token = signAuthToken(await seedDashboardUser(DASH_PHONE));
        [pdfId, textId, webpId, videoId] = await Promise.all([
            uploadWhatsappMedia(new Blob([PDF], { type: 'application/pdf' })),
            uploadWhatsappMedia(new Blob([HTML], { type: 'text/plain' })),
            uploadWhatsappMedia(new Blob([HTML], { type: 'image/webp' })),
            uploadWhatsappMedia(new Blob([HTML], { type: 'video/mp4' })),
        ]);
        await withClient(async (client) => {
            await client.query(`insert into wa_chats (wa_phone) values ($1)`, [CHAT]);
            await client.query(
                `insert into wa_messages (id, wa_chat_phone, text, owner, status, sent_at, media_type, media_id)
                 values ($1, $2, null, 'guest', 'delivered', now(), 'document', $3),
                        ($4, $2, null, 'guest', 'delivered', now(), 'document', $5),
                        ($6, $2, null, 'guest', 'delivered', now(), 'image', $7),
                        ($8, $2, null, 'guest', 'delivered', now(), 'video', $9)`,
                [ulid(), CHAT, pdfId, ulid(), textId, ulid(), webpId, ulid(), videoId],
            );
        });
        const seeded = await dbOne<{ n: number }>(
            `select count(*)::int as n from wa_messages where wa_chat_phone = $1 and media_id = any($2)`,
            [CHAT, [pdfId, textId, webpId, videoId]],
        );
        assert.equal(Number(seeded?.n), 4, 'в БД 4 строки с нашими media_id');

        globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
            const url =
                typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            // Метаданные — graph.facebook.com, сам файл — lookaside.fbsbx.com.
            if (url.includes('facebook.com') || url.includes('fbsbx.com')) {
                waCalls.push(url);
            }
            return realFetch(input, init);
        }) as typeof fetch;
    });

    after(async () => {
        globalThis.fetch = realFetch;
        await cleanup();
        await closePool();
        await dashboardPool.end();
    });

    it('auth: нет / битый / чужой секрет / протухший / orphan токен → 401, WA не дёрнут', async () => {
        const orphan = signAuthToken(ulid());
        const foreign = signJwt(
            { sub: 'x', exp: Math.floor(Date.now() / 1000) + 3600 },
            'not-the-secret',
        );
        const cases: [string, string | null][] = [
            ['нет токена', null],
            ['мусор', 'not.a.jwt'],
            ['чужой секрет', foreign],
            ['протухший', signAuthToken(ulid(), -10)],
            ['orphan sub', orphan],
        ];
        for (const [label, auth] of cases) {
            waCalls = [];
            const res = await media(pdfId, auth);
            assert.equal(res.status, 401, `${label}: 401`);
            assert.equal(res.headers.get('content-disposition'), null, `${label}: нет disposition`);
            assert.equal(res.headers.get('cache-control'), 'no-store', `${label}: no-store`);
            assert.deepEqual(await res.json(), { error: 'unauthorized' }, `${label}: байтов нет`);
            assert.equal(waCalls.length, 0, `${label}: WA не дёрнут`);
        }
    });

    it('id не из wa_messages → 404, WA не дёрнут', async () => {
        waCalls = [];
        const res = await media(`${TAG}_unknown_${ulid()}`);
        assert.equal(res.status, 404);
        assert.equal(waCalls.length, 0, 'на чужой id в WA не ходим');
        const row = await dbOne(`select 1 from wa_messages where media_id like $1`, [
            `${TAG}_unknown_%`,
        ]);
        assert.equal(row, null, 'строки с таким media_id в БД нет (а то 404 — не доказательство)');
    });

    it('инъекция / LIKE-мета / traversal / %00 / пробелы / сверхдлинный → 400|404, таблица цела, WA не дёрнут', async () => {
        const before = await seedRows();
        const raw: [string, string][] = [
            ['sql quote', encodeURIComponent(`${pdfId}' or '1'='1`)],
            ['drop table', encodeURIComponent(`x'; drop table wa_messages; --`)],
            ['like %', encodeURIComponent(`${pdfId.slice(0, 4)}%`)],
            ['like _', encodeURIComponent(`${pdfId.slice(0, -1)}_`)],
            ['like % raw', `${pdfId.slice(0, 4)}%25`],
            ['traversal', encodeURIComponent('../../auth/login')],
            ['traversal raw', '%2e%2e%2f%2e%2e%2fchats'],
            ['null byte', `${pdfId}%00`],
            ['tab', `${pdfId}%09`],
            ['crlf', `${pdfId}%0d%0a`],
            ['spaces', '%20%20%20'],
            ['unicode', encodeURIComponent('🔥'.repeat(10))],
            ['long', 'm'.repeat(600)],
            ['pdf id, pct-encoded digit', `%3${pdfId.slice(0, 1)}${pdfId.slice(1)}`],
        ];
        for (const [label, id] of raw) {
            waCalls = [];
            const res = await media(id);
            assert.ok(
                res.status === 400 || res.status === 404,
                `${label}: ${res.status} ∉ {400,404}`,
            );
            assert.equal(res.headers.get('content-disposition'), null, `${label}: медиа не отдано`);
            assert.equal(waCalls.length, 0, `${label}: WA не дёрнут`);
        }
        const table = await dbOne<{ ok: string | null }>(
            `select to_regclass('public.wa_messages')::text as ok`,
        );
        assert.equal(table?.ok, 'wa_messages', 'таблица на месте');
        assert.equal(await seedRows(), before, 'строк не прибавилось и не убавилось');
    });

    it('документ: application/pdf и text/plain с <script> → attachment, nosniff, content-type от WA', async () => {
        for (const [label, id, mime, bytes] of [
            ['pdf', pdfId, 'application/pdf', PDF],
            ['text/plain', textId, 'text/plain', HTML],
        ] as const) {
            waCalls = [];
            const { result: res } = await measure(`media ${label}`, () => media(id));
            assert.equal(res.status, 200, `${label}: 200`);
            assert.equal(res.headers.get('content-type'), mime, `${label}: content-type`);
            assert.equal(
                res.headers.get('content-disposition'),
                'attachment',
                `${label}: attachment`,
            );
            assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `${label}: nosniff`);
            assert.equal(res.headers.get('cache-control'), 'no-store', `${label}: no-store`);
            assert.ok(
                Buffer.from(await res.arrayBuffer()).equals(bytes),
                `${label}: байты как загружены`,
            );
            assert.ok(waCalls.length >= 2, `${label}: метаданные + файл из WA`);
        }
    });

    it('image/webp и video/mp4 с HTML-байтами → inline, но nosniff и content-type не text/html', async () => {
        for (const [label, id, mime] of [
            ['webp', webpId, 'image/webp'],
            ['mp4', videoId, 'video/mp4'],
        ] as const) {
            const { result: res } = await measure(`media ${label}`, () => media(id));
            assert.equal(res.status, 200, `${label}: 200`);
            assert.equal(res.headers.get('content-type'), mime, `${label}: mime от WA, не sniff`);
            assert.equal(res.headers.get('content-disposition'), 'inline', `${label}: inline`);
            assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `${label}: nosniff`);
            assert.ok(
                Buffer.from(await res.arrayBuffer()).equals(HTML),
                `${label}: байты как загружены`,
            );
        }
    });

    it('svg / html / xhtml под любым объявленным типом: WA отвергает или переименовывает в text/plain → attachment, не inline', async () => {
        const SVG_SCRIPT = Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        );
        const SVG_XML = Buffer.from(
            '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
        );
        const uploads: [string, Buffer][] = [
            ['image/svg+xml', SVG_SCRIPT],
            ['image/svg+xml', SVG_XML],
            ['image/SVG+xml', Buffer.from('<svg/>')],
            ['text/html', HTML],
            ['text/html; charset=utf-8', HTML],
            ['application/xhtml+xml', HTML],
        ];
        const ids = await Promise.all(uploads.map(([type, body]) => tryUpload(type, body)));
        const accepted = ids.filter((id): id is string => id !== null);
        console.log(`[e2e] WA принял ${accepted.length} из ${uploads.length} опасных upload`);

        await withClient(async (client) => {
            for (const id of accepted) {
                await client.query(
                    `insert into wa_messages (id, wa_chat_phone, text, owner, status, sent_at, media_type, media_id)
                     values ($1, $2, null, 'guest', 'delivered', now(), 'document', $3)`,
                    [ulid(), CHAT, id],
                );
            }
        });
        for (const id of accepted) {
            const stored = await dbOne<{ media_id: string }>(
                `select media_id from wa_messages where wa_chat_phone = $1 and media_id = $2`,
                [CHAT, id],
            );
            assert.equal(stored?.media_id, id, 'строка посеяна');
            const { result: res } = await measure(`media hostile ${id}`, () => media(id));
            assert.equal(res.status, 200, `${id}: 200`);
            console.log(`[e2e] hostile ${id} → WA mime ${res.headers.get('content-type')}`);
            assert.equal(res.headers.get('content-disposition'), 'attachment', `${id}: attachment`);
            assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `${id}: nosniff`);
        }
    });

    it('race: 6 параллельных GET одного id → все 200 attachment, одинаковые байты, строк не прибавилось', async () => {
        const before = await seedRows();
        const settled = await Promise.allSettled(Array.from({ length: 6 }, () => media(textId)));
        for (const s of settled) {
            assert.equal(s.status, 'fulfilled');
            const res = s.value;
            assert.equal(res.status, 200);
            assert.equal(res.headers.get('content-disposition'), 'attachment');
            assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
            assert.ok(Buffer.from(await res.arrayBuffer()).equals(HTML));
        }
        assert.equal(await seedRows(), before, 'GET ничего не пишет');
    });
});
