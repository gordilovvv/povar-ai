// Adversary-приёмка chatsGetListHandler (GET /chats).
// Негатив из задачи: auth → 401; кривой cursor → 400; limit клампится [1..100];
// SQL-мета в cursor/limit не роняет и не протаскивает SQL (таблицы целы).
// IDOR неприменим по дизайну (все dashboard-юзеры видят все чаты) — не проверяем.
// Ручка read-only — гонок/идемпотентности нет.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ulid } from 'ulid';
import { pool as dashboardPool } from '#Dashboard/Db/Pool.js';
import { dashboardFetch } from '#Dashboard/Router.js';
import { toDateTime } from '#Lib/Fmt.js';
import { closePool, dbOne, seedDashboardUser, signAuthToken, withClient } from './helpers/e2e.ts';

const DASH_PHONE = 'E2E_attack_user';
const CHAT_PHONE = 'E2E_atk01';

let token = '';

async function cleanup(): Promise<void> {
    await withClient(async (client) => {
        await client.query(`delete from wa_messages where wa_chat_phone = $1`, [CHAT_PHONE]);
        await client.query(`delete from wa_chats where wa_phone = $1`, [CHAT_PHONE]);
        await client.query(`delete from guests where wa_phone = $1`, [CHAT_PHONE]);
        await client.query(`delete from dashboard_users where phone_number = $1`, [DASH_PHONE]);
    });
}

function req(query: string, headers: Record<string, string>): Request {
    return new Request(`http://dashboard/chats?${query}`, { headers });
}

function authed(query: string, tok = token): Request {
    return req(query, { authorization: `Bearer ${tok}` });
}

async function tablesIntact(): Promise<void> {
    const row = await dbOne<{ a: string | null; b: string | null; c: string | null }>(
        `select to_regclass('public.wa_chats')::text as a,
                to_regclass('public.wa_messages')::text as b,
                to_regclass('public.dashboard_users')::text as c`,
    );
    assert.equal(row?.a, 'wa_chats', 'wa_chats цела');
    assert.equal(row?.b, 'wa_messages', 'wa_messages цела');
    assert.equal(row?.c, 'dashboard_users', 'dashboard_users цела');
}

describe('attack: dashboard chatsGetListHandler', () => {
    before(async () => {
        await cleanup();
        const userId = await seedDashboardUser(DASH_PHONE);
        token = signAuthToken(userId);
        await withClient(async (client) => {
            const guestId = ulid();
            await client.query(
                `insert into guests (id, wa_phone, first_name, last_name) values ($1, $2, 'Atk', 'User')`,
                [guestId, CHAT_PHONE],
            );
            await client.query(
                `insert into wa_chats (wa_phone, guest_id, last_received_message_at) values ($1, $2, $3)`,
                [CHAT_PHONE, guestId, toDateTime(new Date('2031-01-01T10:00:00.000Z'))],
            );
        });
    });

    after(async () => {
        await cleanup();
        await closePool();
        await dashboardPool.end();
    });

    // ── AUTH ──────────────────────────────────────────────────────────────
    it('без заголовка authorization → 401', async () => {
        const res = await dashboardFetch(req('limit=5', {}));
        assert.equal(res.status, 401);
    });

    it('не-Bearer схема (Basic) → 401', async () => {
        const res = await dashboardFetch(req('limit=5', { authorization: 'Basic Zm9vOmJhcg==' }));
        assert.equal(res.status, 401);
    });

    it('битая подпись → 401', async () => {
        const parts = token.split('.');
        const tampered = `${parts[0]}.${parts[1]}.${parts[2]}deadbeef`;
        const res = await dashboardFetch(authed('limit=5', tampered));
        assert.equal(res.status, 401);
    });

    it('протухший токен → 401', async () => {
        const userId = await seedDashboardUser(DASH_PHONE);
        const expired = signAuthToken(userId, -60);
        const res = await dashboardFetch(authed('limit=5', expired));
        assert.equal(res.status, 401);
    });

    it('alg:none подделка → 401', async () => {
        const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
            'base64url',
        );
        const body = Buffer.from(
            JSON.stringify({ sub: ulid(), exp: Math.floor(Date.now() / 1000) + 3600 }),
        ).toString('base64url');
        const forged = `${header}.${body}.`;
        const res = await dashboardFetch(authed('limit=5', forged));
        assert.equal(res.status, 401);
    });

    it('валидный токен на несуществующего dashboard-юзера → 401', async () => {
        const ghost = signAuthToken(ulid());
        const res = await dashboardFetch(authed('limit=5', ghost));
        assert.equal(res.status, 401);
    });

    // ── КРИВОЙ CURSOR ─────────────────────────────────────────────────────
    it('мусорный cursor без сепаратора → 400', async () => {
        const res = await dashboardFetch(authed('cursor=garbage'));
        assert.equal(res.status, 400);
    });

    it('cursor только сепаратор → 400', async () => {
        const res = await dashboardFetch(authed(`cursor=${encodeURIComponent('|')}`));
        assert.equal(res.status, 400);
    });

    it('cursor ISO без phone → 400', async () => {
        const res = await dashboardFetch(
            authed(`cursor=${encodeURIComponent('2031-01-01T10:00:00.000Z|')}`),
        );
        assert.equal(res.status, 400);
    });

    it('cursor: phone без валидного ISO → 400', async () => {
        const res = await dashboardFetch(
            authed(`cursor=${encodeURIComponent('not-a-date|E2E_atk01')}`),
        );
        assert.equal(res.status, 400);
    });

    // Regex ISO_UTC пропускает несуществующую дату (месяц 13, час 99);
    // ::timestamptz в SQL кидает → должно быть 400, а не 500.
    it('cursor с невалидной календарной датой (проходит regex) → 400, не 500', async () => {
        const res = await dashboardFetch(
            authed(`cursor=${encodeURIComponent('2030-13-45T99:99:99.999Z|E2E_atk01')}`),
        );
        assert.equal(res.status, 400, `ожидали 400, получили ${res.status}`);
        await tablesIntact();
    });

    // ── LIMIT ─────────────────────────────────────────────────────────────
    it('отрицательный / 0 / гигантский / нечисловой limit → 200, не падает', async () => {
        for (const limit of ['-5', '0', '999999999', 'abc', '1e9', '1.5']) {
            const res = await dashboardFetch(authed(`limit=${encodeURIComponent(limit)}`));
            assert.equal(res.status, 200, `limit=${limit} должен клампиться, не падать`);
            const json = (await res.json()) as { items: unknown[] };
            assert.ok(Array.isArray(json.items), `limit=${limit}: items массив`);
            assert.ok(json.items.length <= 100, `limit=${limit}: не больше MAX_LIMIT`);
        }
    });

    // ── ИНЪЕКЦИИ ──────────────────────────────────────────────────────────
    it('SQL-мета в phone-части cursor не роняет и не протаскивает SQL', async () => {
        const evil = "2031-01-01T10:00:00.000Z|' or '1'='1; drop table wa_chats;--";
        const res = await dashboardFetch(authed(`cursor=${encodeURIComponent(evil)}`));
        // валидный ISO + непустой phone → 200; phone уходит значением через %L
        assert.equal(res.status, 200, `ожидали 200, получили ${res.status}`);
        await tablesIntact();
    });

    it('SQL-мета в limit не роняет, таблицы целы', async () => {
        const res = await dashboardFetch(
            authed(`limit=${encodeURIComponent('1; drop table wa_chats;--')}`),
        );
        assert.equal(res.status, 200);
        await tablesIntact();
    });
});
