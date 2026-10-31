// Adversary e2e для chatsPostPauseOffHandler.
// Контракт (из задачи):
//   auth: нет/битый/протухший/чужая подпись/удалённый юзер → 401 и НИ ОДНА пауза не снята (БД);
//   маршрут не конфликтует с /chats/:phone/*: GET /chats/pause, POST /chats/pause/photo,
//     PUT /chats/pause/off, GET /chats/pause/off — не снимают паузы;
//   параллельные вызовы: сумма affectedCount = числу бывших на паузе, паузы сняты, pause_alerted_at цел.
//   ВНИМАНИЕ: снимает паузу и с реальных чатов (согласовано пользователем).

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { pool as dashboardPool } from '#Dashboard/Db/Pool.js';
import { signJwt } from '#Dashboard/Lib/Jwt.js';
import { dashboardFetch } from '#Dashboard/Router.js';
import { toDateTime } from '#Lib/Fmt.js';
import {
    closePool,
    dbOne,
    dbQuery,
    seedDashboardUser,
    signAuthToken,
    withClient,
} from './helpers/e2e.ts';

const DASH_PHONE = 'E2E_atk_po_user';
const GHOST_PHONE = 'E2E_atk_po_ghost';
const PAUSED = Array.from({ length: 20 }, (_, i) => `E2E_atk_po_${i}`);
const ALERTED_AT = toDateTime(new Date('2026-01-01T00:00:00.000Z'));

let token = '';

function jwtSecret(): string {
    const s = process.env.JWT_SECRET;
    if (!s) throw new Error('JWT_SECRET missing');
    return s;
}

async function call(
    method: string,
    path: string,
    auth: string | null = `Bearer ${token}`,
): Promise<Response> {
    const headers: Record<string, string> = {};
    if (auth !== null) headers.authorization = auth;
    return dashboardFetch(new Request(`http://dashboard${path}`, { method, headers }));
}

async function ownPausedCount(): Promise<number> {
    const row = await dbOne<{ n: string }>(
        `select count(*) n from wa_chats where wa_phone = any($1) and paused_at is not null and pause_details = 'e2e atk'`,
        [PAUSED],
    );
    return Number(row?.n);
}

async function cleanup(): Promise<void> {
    await withClient(async (client) => {
        await client.query(`delete from wa_chats where wa_phone = any($1)`, [PAUSED]);
        await client.query(`delete from dashboard_users where phone_number = any($1)`, [
            [DASH_PHONE, GHOST_PHONE],
        ]);
    });
}

async function seedPaused(): Promise<void> {
    await withClient(async (client) => {
        await client.query(`delete from wa_chats where wa_phone = any($1)`, [PAUSED]);
        for (const phone of PAUSED) {
            await client.query(
                `insert into wa_chats (wa_phone, paused_at, pause_details, pause_alerted_at)
                 values ($1, now(), 'e2e atk', $2)`,
                [phone, ALERTED_AT],
            );
        }
    });
}

describe('attack: dashboard chatsPostPauseOff', () => {
    before(async () => {
        await cleanup();
        token = signAuthToken(await seedDashboardUser(DASH_PHONE));
    });

    beforeEach(seedPaused);

    after(async () => {
        await cleanup();
        await closePool();
        await dashboardPool.end();
    });

    it('auth: любой невалидный токен → 401, ни одна пауза не снята', async () => {
        const id = await seedDashboardUser(DASH_PHONE);
        const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
            'base64url',
        );
        const body = Buffer.from(JSON.stringify({ sub: id, exp: 9_999_999_999 })).toString(
            'base64url',
        );
        const ghostId = await seedDashboardUser(GHOST_PHONE);
        const ghostToken = signAuthToken(ghostId);
        await withClient((c) => c.query(`delete from dashboard_users where id = $1`, [ghostId]));

        const auths: (string | null)[] = [
            null,
            `Basic ${token}`,
            'Bearer ',
            'Bearer a.b.c',
            `Bearer ${signAuthToken(id, -10)}`,
            `Bearer ${signJwt({ sub: id, exp: Math.floor(Date.now() / 1000) + 3600 }, `${jwtSecret()}x`)}`,
            `Bearer ${header}.${body}.`,
            `Bearer ${ghostToken}`,
        ];
        for (const auth of auths) {
            const res = await call('POST', '/chats/pause/off', auth);
            assert.equal(res.status, 401, `[${auth}] → 401`);
            assert.equal(await ownPausedCount(), PAUSED.length, `[${auth}]: паузы на месте`);
        }
    });

    it('route: соседние /chats/pause* маршруты не снимают паузы', async () => {
        for (const [method, path] of [
            ['GET', '/chats/pause'],
            ['GET', '/chats/pause/off'],
            ['PUT', '/chats/pause/off'],
            ['DELETE', '/chats/pause/off'],
            ['POST', '/chats/pause/off/x'],
            ['POST', '/chats/pause'],
            ['POST', '/chats/pause/photo'],
            ['POST', '/chats/pause/messages'],
        ]) {
            const res = await call(method, path);
            assert.notEqual(res.status, 500, `${method} ${path} не 500`);
            await res.body?.cancel();
            assert.equal(
                await ownPausedCount(),
                PAUSED.length,
                `${method} ${path}: паузы на месте`,
            );
        }
    });

    it('race: 8 параллельных POST → сумма affectedCount = числу пауз, двойного счёта нет', async () => {
        const pausedBefore = Number(
            (
                await dbOne<{ n: string }>(
                    `select count(*) n from wa_chats where paused_at is not null`,
                )
            )?.n,
        );
        const results = await Promise.allSettled(
            Array.from({ length: 8 }, () => call('POST', '/chats/pause/off')),
        );
        let sum = 0;
        for (const r of results) {
            assert.equal(r.status, 'fulfilled');
            if (r.status !== 'fulfilled') continue;
            assert.equal(r.value.status, 200);
            sum += ((await r.value.json()) as { affectedCount: number }).affectedCount;
        }
        assert.equal(sum, pausedBefore, 'сумма affectedCount = бывшим на паузе');
        const own = await dbQuery<{
            paused_at: unknown;
            pause_details: unknown;
            pause_alerted_at: Date;
        }>(
            `select paused_at, pause_details, pause_alerted_at from wa_chats where wa_phone = any($1)`,
            [PAUSED],
        );
        assert.equal(own.length, PAUSED.length, 'строки не удалены');
        for (const c of own) {
            assert.equal(c.paused_at, null);
            assert.equal(c.pause_details, null);
            assert.equal(toDateTime(c.pause_alerted_at), ALERTED_AT, 'pause_alerted_at цел');
        }
    });
});
