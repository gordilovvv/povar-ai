// Задача модуля (chatPostDeleteHandler):
//   вход  → POST /chats/:phone/delete (Bearer JWT, гейт withAuthorization)
//   выход → 200 { phone }; wa_messages и wa_chats по телефону удалены, guests.marketing enabled→disabled;
//           party_guestlist, wa_marketing_sends, профиль гостя не тронуты
//   бюджет → сеть/БД не меряем, только measure()
//   негатив → у чата есть wa_messages с worker_status need_processed|processing → 409, ничего не удалено;
//             чата нет → 404; повтор после 200 → 404; гость blocked_by_user остаётся blocked_by_user

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ulid } from 'ulid';
import { pool as dashboardPool } from '#Dashboard/Db/Pool.js';
import { dashboardFetch } from '#Dashboard/Router.js';
import {
    closePool,
    dbOne,
    dbQuery,
    measure,
    seedDashboardUser,
    signAuthToken,
    withClient,
} from './helpers/e2e.ts';

const DASH_PHONE = 'E2E_chatdelete_user';
const RUN = Date.now().toString(36);
const PARTY_ID = `e2e_cd_party_${RUN}`;
const CHATS = {
    plain: { phone: `e2e_cd_plain_${RUN}`, guestId: ulid(), marketing: 'enabled' },
    blocked: { phone: `e2e_cd_blocked_${RUN}`, guestId: ulid(), marketing: 'blocked_by_user' },
    busy: { phone: `e2e_cd_busy_${RUN}`, guestId: ulid(), marketing: 'enabled' },
    orphan: { phone: `e2e_cd_orphan_${RUN}`, guestId: null, marketing: null },
} as const;
const PHONES = Object.values(CHATS).map((c) => c.phone);
const GUEST_IDS = Object.values(CHATS).flatMap((c) => (c.guestId ? [c.guestId] : []));

let token = '';

async function postDelete(phone: string): Promise<Response> {
    const { result } = await measure(`POST /chats/${phone}/delete`, () =>
        dashboardFetch(
            new Request(`http://dashboard/chats/${phone}/delete`, {
                method: 'POST',
                headers: { authorization: `Bearer ${token}` },
            }),
        ),
    );
    return result;
}

async function countRows(phone: string) {
    const [row] = await dbQuery<Record<string, number>>(
        `select
            (select count(*)::int from wa_chats where wa_phone = $1) as chats,
            (select count(*)::int from wa_messages where wa_chat_phone = $1) as messages,
            (select count(*)::int from guests where wa_phone = $1) as guests,
            (select count(*)::int from party_guestlist g join guests on guests.id = g.guest_id where guests.wa_phone = $1) as guestlist,
            (select count(*)::int from wa_marketing_sends where wa_phone = $1) as sends`,
        [phone],
    );
    return row;
}

async function guestMarketing(phone: string) {
    const row = await dbOne<{ marketing: string }>(
        `select marketing from guests where wa_phone = $1`,
        [phone],
    );
    return row?.marketing ?? null;
}

async function seed(): Promise<void> {
    await withClient(async (client) => {
        await client.query(
            `insert into party (id, type, name, price, location) values ($1, 'owned', 'E2E chat delete', 0, 'E2E')`,
            [PARTY_ID],
        );
        for (const chat of Object.values(CHATS)) {
            if (chat.guestId) {
                await client.query(
                    `insert into guests (id, wa_phone, first_name, marketing) values ($1, $2, 'E2E', $3)`,
                    [chat.guestId, chat.phone, chat.marketing],
                );
                await client.query(
                    `insert into party_guestlist (party_id, guest_id) values ($1, $2)`,
                    [PARTY_ID, chat.guestId],
                );
                await client.query(
                    `insert into wa_marketing_sends (party_id, wa_phone, sent_at) values ($1, $2, now())`,
                    [PARTY_ID, chat.phone],
                );
            }
            await client.query(`insert into wa_chats (wa_phone, guest_id) values ($1, $2)`, [
                chat.phone,
                chat.guestId,
            ]);
            // Реальный микс: входящие с worker_status и ответ бота, у которого worker_status null
            for (const [owner, workerStatus] of [
                ['guest', 'processed'],
                ['sema', null],
                ['guest', 'skipped'],
            ]) {
                await client.query(
                    `insert into wa_messages (id, wa_message_id, wa_chat_phone, text, owner, status, worker_status, concurrency_version, sent_at)
                     values ($1, $2, $3, 'hi', $4, 'delivered', $5, 0, now())`,
                    [ulid(), `wamid.e2e_cd_${ulid()}`, chat.phone, owner, workerStatus],
                );
            }
        }
        await client.query(
            `insert into wa_messages (id, wa_message_id, wa_chat_phone, text, owner, status, worker_status, concurrency_version, sent_at)
             values ($1, $2, $3, 'in work', 'guest', 'delivered', 'need_processed', 0, now())`,
            [ulid(), `wamid.e2e_cd_${ulid()}`, CHATS.busy.phone],
        );
    });
}

async function cleanup(): Promise<void> {
    await withClient(async (client) => {
        await client.query(`delete from wa_messages where wa_chat_phone = any($1)`, [PHONES]);
        await client.query(`delete from wa_chats where wa_phone = any($1)`, [PHONES]);
        await client.query(`delete from wa_marketing_sends where party_id = $1`, [PARTY_ID]);
        await client.query(`delete from party_guestlist where party_id = $1`, [PARTY_ID]);
        await client.query(`delete from party where id = $1`, [PARTY_ID]);
        await client.query(`delete from guests where id = any($1)`, [GUEST_IDS]);
        await client.query(`delete from dashboard_users where phone_number = $1`, [DASH_PHONE]);
    });
}

describe('e2e: dashboard chat delete', () => {
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

    it('e2e: chat delete — чат и сообщения удалены, гость disabled, guestlist/sends/профиль на месте', async () => {
        const { phone } = CHATS.plain;
        assert.deepEqual(await countRows(phone), {
            chats: 1,
            messages: 3,
            guests: 1,
            guestlist: 1,
            sends: 1,
        });

        const res = await postDelete(phone);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { phone });

        assert.deepEqual(
            await countRows(phone),
            { chats: 0, messages: 0, guests: 1, guestlist: 1, sends: 1 },
            'ушли только чат и сообщения',
        );
        assert.equal(await guestMarketing(phone), 'disabled', 'enabled → disabled');
    });

    it('e2e: chat delete — повтор после удаления → 404, ничего не меняется', async () => {
        const { phone } = CHATS.plain;
        const res = await postDelete(phone);
        assert.equal(res.status, 404);
        assert.equal(await guestMarketing(phone), 'disabled');
    });

    it('e2e: chat delete — гость blocked_by_user остаётся blocked_by_user', async () => {
        const { phone } = CHATS.blocked;
        const res = await postDelete(phone);
        assert.equal(res.status, 200);
        assert.equal((await countRows(phone))?.chats, 0);
        assert.equal(
            await guestMarketing(phone),
            'blocked_by_user',
            'blocked_by_user не перезаписан',
        );
    });

    it('e2e: chat delete — чат без гостя удаляется, гостей не трогает', async () => {
        const { phone } = CHATS.orphan;
        const res = await postDelete(phone);
        assert.equal(res.status, 200);
        assert.deepEqual(await countRows(phone), {
            chats: 0,
            messages: 0,
            guests: 0,
            guestlist: 0,
            sends: 0,
        });
    });

    it('e2e: chat delete — сообщение в работе у воркера → 409, ничего не удалено, гость enabled', async () => {
        const { phone } = CHATS.busy;
        const res = await postDelete(phone);
        assert.equal(res.status, 409);
        assert.deepEqual(await countRows(phone), {
            chats: 1,
            messages: 4,
            guests: 1,
            guestlist: 1,
            sends: 1,
        });
        assert.equal(await guestMarketing(phone), 'enabled', 'при 409 рассылка не отключена');

        await withClient((client) =>
            client.query(
                `update wa_messages set worker_status = 'processing' where wa_chat_phone = $1 and worker_status = 'need_processed'`,
                [phone],
            ),
        );
        assert.equal((await postDelete(phone)).status, 409, 'processing тоже занят');

        await withClient((client) =>
            client.query(
                `update wa_messages set worker_status = 'processed' where wa_chat_phone = $1`,
                [phone],
            ),
        );
        assert.equal((await postDelete(phone)).status, 200, 'воркер отпустил → удаляется');
        assert.equal((await countRows(phone))?.messages, 0);
    });

    it('e2e: chat delete — несуществующий чат → 404', async () => {
        const res = await postDelete(`e2e_cd_missing_${RUN}`);
        assert.equal(res.status, 404);
    });
});
