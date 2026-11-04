// e2e: mediaGetHandler (GET /media/:id) — заголовки отдачи. Медиа реально грузим в WhatsApp
// через uploadWhatsappMedia, строки wa_messages сеем сами под E2E_mg. Сеть WA бюджетом не меряем.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ulid } from 'ulid';
import { pool as dashboardPool } from '#Dashboard/Db/Pool.js';
import { dashboardFetch } from '#Dashboard/Router.js';
import { uploadWhatsappMedia } from '#Platforms/Whatsapp/index.js';
import { closePool, measure, seedDashboardUser, signAuthToken, withClient } from './helpers/e2e.ts';

const DASH_PHONE = 'E2E_mg_user';
const CHAT = 'E2E_mg_chat';

// 1x1 PNG
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64',
);

let token = '';
let imageId = '';
let documentId = '';

async function cleanup(): Promise<void> {
    await withClient(async (client) => {
        await client.query(`delete from wa_messages where wa_chat_phone = $1`, [CHAT]);
        await client.query(`delete from wa_chats where wa_phone = $1`, [CHAT]);
        await client.query(`delete from dashboard_users where phone_number = $1`, [DASH_PHONE]);
    });
}

function media(id: string): Promise<Response> {
    return dashboardFetch(
        new Request(`http://dashboard/media/${encodeURIComponent(id)}`, {
            headers: { authorization: `Bearer ${token}` },
        }),
    );
}

describe('e2e: media get — content-disposition по mime', () => {
    before(async () => {
        await cleanup();
        token = signAuthToken(await seedDashboardUser(DASH_PHONE));
        [imageId, documentId] = await Promise.all([
            uploadWhatsappMedia(new Blob([PNG], { type: 'image/png' })),
            uploadWhatsappMedia(new Blob(['<script>alert(1)</script>'], { type: 'text/plain' })),
        ]);
        await withClient(async (client) => {
            await client.query(`insert into wa_chats (wa_phone) values ($1)`, [CHAT]);
            await client.query(
                `insert into wa_messages (id, wa_chat_phone, text, owner, status, sent_at, media_type, media_id)
                 values ($1, $2, null, 'guest', 'delivered', now(), 'image', $3),
                        ($4, $2, null, 'guest', 'delivered', now(), 'document', $5)`,
                [ulid(), CHAT, imageId, ulid(), documentId],
            );
        });
    });

    after(async () => {
        await cleanup();
        await closePool();
        await dashboardPool.end();
    });

    it('image → inline, nosniff, байты как загружены', async () => {
        const { result: res } = await measure('media image', () => media(imageId));
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'image/png');
        assert.equal(res.headers.get('content-disposition'), 'inline');
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(res.headers.get('cache-control'), 'no-store');
        assert.ok(Buffer.from(await res.arrayBuffer()).equals(PNG));
    });

    it('document → attachment, nosniff', async () => {
        const { result: res } = await measure('media document', () => media(documentId));
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-disposition'), 'attachment');
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    });
});
