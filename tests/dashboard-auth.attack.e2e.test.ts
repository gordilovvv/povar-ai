// Adversary-приёмка для dashboard auth (login + refresh + защита access-JWT на /chats).
// Каждая проба бьёт по конкретной дыре и ассертит ТОЧНЫЙ ожидаемый статус (401/400),
// а не "не 200" — чтобы зелёный означал реальную защиту, а не промах мимо роута (404).
// Auth без БД: источник правды — in-memory Map refresh-токенов и криптоверификация JWT.

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { pool as dashboardPool } from '#Dashboard/Db/Pool.js';
import { signJwt } from '#Dashboard/Lib/Jwt.js';
import { dashboardFetch } from '#Dashboard/Router.js';

const DEV_PASSWORD = 'SemaAI2026@';
const ADMIN_PHONE = process.env.ADMIN_PHONE ?? '';
const JWT_SECRET = process.env.JWT_SECRET ?? '';

function post(path: string, body: unknown): Promise<Response> {
    return dashboardFetch(
        new Request(`http://dashboard${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: typeof body === 'string' ? body : JSON.stringify(body),
        }),
    );
}

function login(body: unknown): Promise<Response> {
    return post('/auth/login', body);
}

function refresh(body: unknown): Promise<Response> {
    return post('/auth/refresh', body);
}

function getChats(bearer: string | null): Promise<Response> {
    const headers: Record<string, string> = {};
    if (bearer !== null) {
        headers.authorization = `Bearer ${bearer}`;
    }
    return dashboardFetch(new Request('http://dashboard/chats', { method: 'GET', headers }));
}

const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');

async function freshRefreshToken(): Promise<string> {
    const res = await login({ phone: ADMIN_PHONE, password: DEV_PASSWORD });
    assert.equal(res.status, 200, 'предусловие: логин выдал пару');
    const pair = (await res.json()) as { refreshToken: string };
    return pair.refreshToken;
}

function validAccessToken(): string {
    return signJwt({ sub: ADMIN_PHONE, exp: Math.floor(Date.now() / 1000) + 3600 }, JWT_SECRET);
}

describe('attack: dashboard auth', () => {
    // Сажаем dashboard_users с id = ADMIN_PHONE (sub access-JWT). Без этой строки /chats
    // отдаёт 401 ВСЕГДА (и валидному токену) — тогда 401 на подделку ничего не доказывает.
    // С ней валидный токен → 200, значит 401 подделки = именно провал подписи/exp.
    before(async () => {
        await dashboardPool.query(
            `insert into dashboard_users (id, phone_number, created_at)
             values ($1, $1, now()) on conflict (id) do nothing`,
            [ADMIN_PHONE],
        );
    });

    after(async () => {
        await dashboardPool.query(`delete from dashboard_users where id = $1`, [ADMIN_PHONE]);
        await dashboardPool.end();
    });

    it('предусловие: креды окружения заданы', () => {
        assert.ok(ADMIN_PHONE.length > 0 && JWT_SECRET.length > 0, 'ADMIN_PHONE + JWT_SECRET');
    });

    it('sanity: ВАЛИДНЫЙ access (реальный secret, seeded user) проходит /chats → НЕ 401', async () => {
        const res = await getChats(validAccessToken());
        assert.notEqual(res.status, 401, 'валидный токен обязан пройти аутентификацию');
        assert.equal(res.status, 200, 'валидный токен + seeded user → 200');
    });

    // ── LOGIN: кривой ввод и перебор ─────────────────────────────────────────

    it('login: не-JSON тело → 400, пара не выдана', async () => {
        const res = await login('this is not json{');
        assert.equal(res.status, 400);
    });

    it('login: нет обязательного password → 400', async () => {
        const res = await login({ phone: ADMIN_PHONE });
        assert.equal(res.status, 400);
    });

    it('login: password не строка (тип) → 400', async () => {
        const res = await login({ phone: ADMIN_PHONE, password: 123456 });
        assert.equal(res.status, 400);
    });

    it('login: пустой password (min 1) → 400', async () => {
        const res = await login({ phone: ADMIN_PHONE, password: '' });
        assert.equal(res.status, 400);
    });

    it('login: пустое тело {} → 400', async () => {
        const res = await login({});
        assert.equal(res.status, 400);
    });

    it('login: верный password, но phone с ведущим пробелом → 401 (без нормализации)', async () => {
        const res = await login({ phone: ` ${ADMIN_PHONE}`, password: DEV_PASSWORD });
        assert.equal(res.status, 401);
    });

    it('login: SQL-мета в phone уходит как значение → 401, не 500', async () => {
        const res = await login({ phone: `' OR 1=1 --`, password: DEV_PASSWORD });
        assert.equal(res.status, 401);
    });

    it('login: перебор паролей — каждый неверный → 401, пара не выдана', async () => {
        for (const pw of ['admin', 'password', DEV_PASSWORD.toUpperCase(), `${DEV_PASSWORD} `]) {
            const res = await login({ phone: ADMIN_PHONE, password: pw });
            assert.equal(res.status, 401, `пароль "${pw}" не должен подойти`);
        }
    });

    // ── REFRESH: кривой ввод, двойная трата, разделение токенов ───────────────

    it('refresh: неизвестный токен → 401', async () => {
        const res = await refresh({ refreshToken: 'totally-unknown-token' });
        assert.equal(res.status, 401);
    });

    it('refresh: пустой refreshToken → 400', async () => {
        const res = await refresh({ refreshToken: '' });
        assert.equal(res.status, 400);
    });

    it('refresh: refreshToken не строка → 400', async () => {
        const res = await refresh({ refreshToken: 42 });
        assert.equal(res.status, 400);
    });

    it('refresh: access-JWT нельзя предъявить как refresh → 401', async () => {
        const loginRes = await login({ phone: ADMIN_PHONE, password: DEV_PASSWORD });
        const pair = (await loginRes.json()) as { accessToken: string };
        const res = await refresh({ refreshToken: pair.accessToken });
        assert.equal(res.status, 401, 'access-строка не должна проходить как refresh');
    });

    it('refresh: повторная трата (последовательно) → второй раз 401, воскрешения нет', async () => {
        const token = await freshRefreshToken();
        const first = await refresh({ refreshToken: token });
        assert.equal(first.status, 200);
        const reuse = await refresh({ refreshToken: token });
        assert.equal(reuse.status, 401, 'одноразовость: повтор → 401');
        const reuse2 = await refresh({ refreshToken: token });
        assert.equal(reuse2.status, 401, 'нельзя воскресить погашенный');
    });

    it('refresh: ГОНКА одним токеном (allSettled) → ровно один 200, остальные 401', async () => {
        const token = await freshRefreshToken();
        const settled = await Promise.allSettled(
            Array.from({ length: 8 }, () => refresh({ refreshToken: token })),
        );
        const statuses: number[] = [];
        for (const s of settled) {
            assert.equal(s.status, 'fulfilled', 'запрос не должен падать исключением');
            if (s.status === 'fulfilled') {
                statuses.push(s.value.status);
            }
        }
        const wins = statuses.filter((c) => c === 200).length;
        const rejects = statuses.filter((c) => c === 401).length;
        assert.equal(wins, 1, `двойная трата: победитель ровно один (got ${wins})`);
        assert.equal(rejects, statuses.length - 1, 'все проигравшие → 401');
        // токен после гонки мёртв
        const post = await refresh({ refreshToken: token });
        assert.equal(post.status, 401, 'использованный refresh мёртв и после гонки');
    });

    // ── ACCESS-JWT: обход подписи на защищённой /chats ────────────────────────

    it('/chats: без токена → 401', async () => {
        const res = await getChats(null);
        assert.equal(res.status, 401);
    });

    it('/chats: refresh-строка как Bearer не проходит как access → 401', async () => {
        const token = await freshRefreshToken();
        const res = await getChats(token);
        assert.equal(res.status, 401, 'refresh-строка не access');
    });

    it('/chats: alg:none (пустая подпись) → 401', async () => {
        const header = b64url({ alg: 'none', typ: 'JWT' });
        const body = b64url({ sub: ADMIN_PHONE, exp: Math.floor(Date.now() / 1000) + 3600 });
        const res = await getChats(`${header}.${body}.`);
        assert.equal(res.status, 401);
    });

    it('/chats: подпись чужим секретом → 401', async () => {
        const forged = signJwt(
            { sub: ADMIN_PHONE, exp: Math.floor(Date.now() / 1000) + 3600 },
            'evil-secret-not-the-real-one',
        );
        const res = await getChats(forged);
        assert.equal(res.status, 401);
    });

    it('/chats: подмена payload при валидной старой подписи → 401', async () => {
        const good = signJwt(
            { sub: ADMIN_PHONE, exp: Math.floor(Date.now() / 1000) + 3600 },
            JWT_SECRET,
        );
        const [h, , sig] = good.split('.');
        const tamperedBody = b64url({
            sub: 'attacker',
            exp: Math.floor(Date.now() / 1000) + 999999,
        });
        const res = await getChats(`${h}.${tamperedBody}.${sig}`);
        assert.equal(res.status, 401);
    });

    it('/chats: exp в прошлом (валидная подпись) → 401', async () => {
        const expired = signJwt(
            { sub: ADMIN_PHONE, exp: Math.floor(Date.now() / 1000) - 10 },
            JWT_SECRET,
        );
        const res = await getChats(expired);
        assert.equal(res.status, 401);
    });

    it('/chats: лишний сегмент в JWT → 401', async () => {
        const good = signJwt(
            { sub: ADMIN_PHONE, exp: Math.floor(Date.now() / 1000) + 3600 },
            JWT_SECRET,
        );
        const res = await getChats(`${good}.extrasegment`);
        assert.equal(res.status, 401);
    });

    it('/chats: битая подпись (обрезана) → 401', async () => {
        const good = signJwt(
            { sub: ADMIN_PHONE, exp: Math.floor(Date.now() / 1000) + 3600 },
            JWT_SECRET,
        );
        const [h, body] = good.split('.');
        const brokenSig = createHmac('sha256', JWT_SECRET)
            .update(`${h}.${body}`)
            .digest('base64url')
            .slice(0, -4);
        const res = await getChats(`${h}.${body}.${brokenSig}`);
        assert.equal(res.status, 401);
    });
});
