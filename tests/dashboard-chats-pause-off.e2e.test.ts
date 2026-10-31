// Задача модуля (chatsPostPauseOffHandler):
//   вход  → POST /chats/pause/off (Bearer JWT, гейт withAuthorization)
//   выход → { affectedCount } = число чатов, которые были на паузе;
//           после — ни одного wa_chats с paused_at not null, pause_details = null,
//           pause_alerted_at не тронут
//   бюджет → сеть/БД не меряем, только measure()
//   негатив → нет/битый токен → 401 (в .attack); повтор → affectedCount 0
//   ВНИМАНИЕ: снимает паузу и с реальных чатов (согласовано пользователем).

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
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

const DASH_PHONE = 'E2E_pauseoff_user';
const PAUSED_CHATS = ['E2E_po_paused_0', 'E2E_po_paused_1'];
const FREE_CHAT = 'E2E_po_free';
const ALL_CHATS = [...PAUSED_CHATS, FREE_CHAT];
const ALERTED_AT = toDateTime(new Date('2026-01-01T00:00:00.000Z'));

let token = '';

async function pauseOff(): Promise<Response> {
    const { result } = await measure('POST /chats/pause/off', () =>
        dashboardFetch(
            new Request('http://dashboard/chats/pause/off', {
                method: 'POST',
                headers: { authorization: `Bearer ${token}` },
            }),
        ),
    );
    return result;
}

async function cleanup(): Promise<void> {
    await withClient(async (client) => {
        await client.query(`delete from wa_chats where wa_phone = any($1)`, [ALL_CHATS]);
        await client.query(`delete from dashboard_users where phone_number = $1`, [DASH_PHONE]);
    });
}

describe('e2e: dashboard chatsPostPauseOff', () => {
    before(async () => {
        await cleanup();
        token = signAuthToken(await seedDashboardUser(DASH_PHONE));
        await withClient(async (client) => {
            for (const phone of PAUSED_CHATS) {
                await client.query(
                    `insert into wa_chats (wa_phone, paused_at, pause_details, pause_alerted_at)
                     values ($1, now(), 'e2e pause', $2)`,
                    [phone, ALERTED_AT],
                );
            }
            await client.query(
                `insert into wa_chats (wa_phone, pause_alerted_at) values ($1, $2)`,
                [FREE_CHAT, ALERTED_AT],
            );
        });
    });

    after(async () => {
        await cleanup();
        await closePool();
        await dashboardPool.end();
    });

    it('e2e: pause off — снимает все паузы, affectedCount = число бывших на паузе', async () => {
        const pausedBefore = await dbOne<{ n: string }>(
            `select count(*) n from wa_chats where paused_at is not null`,
        );
        assert.ok(Number(pausedBefore?.n) >= PAUSED_CHATS.length, 'сид на паузе');

        const res = await pauseOff();
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { affectedCount: Number(pausedBefore?.n) });

        const pausedAfter = await dbOne<{ n: string }>(
            `select count(*) n from wa_chats where paused_at is not null or pause_details is not null`,
        );
        assert.equal(Number(pausedAfter?.n), 0, 'в БД не осталось пауз и деталей');

        const own = await dbQuery<{ wa_phone: string; pause_alerted_at: string | null }>(
            `select wa_phone, pause_alerted_at from wa_chats where wa_phone = any($1) order by wa_phone`,
            [ALL_CHATS],
        );
        assert.equal(own.length, ALL_CHATS.length, 'чаты не удалены и не задублированы');
        for (const chat of own) {
            assert.equal(
                toDateTime(chat.pause_alerted_at ?? ''),
                ALERTED_AT,
                `${chat.wa_phone}: pause_alerted_at не тронут`,
            );
        }
    });

    it('e2e: pause off — повтор без пауз → affectedCount 0', async () => {
        const res = await pauseOff();
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { affectedCount: 0 });
    });
});
