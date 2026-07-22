// Задача модуля (authLoginHandler + authRefreshHandler):
//   вход  → POST /auth/login {phone,password}; POST /auth/refresh {refreshToken}
//   выход → { accessToken, refreshToken }; access = JWT (sub=ADMIN_PHONE, exp ~15м),
//           refresh = opaque, одноразовый; на refresh — ротация (старый гаснет)
//   бюджет → login ≤ 200ms (scrypt), refresh ≤ 50ms (ориентир, только measure)
//   негатив → неверный phone/password → 401; кривой body → 400 (основное — в .attack)
//
// Auth без БД: единственный админ в env (ADMIN_PHONE + ADMIN_PASSWORD_HASH).
// DEV_PASSWORD — плейнтекст, чей scrypt-хэш лежит в .env.dev как ADMIN_PASSWORD_HASH.

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { pool as dashboardPool } from '#Dashboard/Db/Pool.js';
import { verifyJwt } from '#Dashboard/Lib/Jwt.js';
import { dashboardFetch } from '#Dashboard/Router.js';
import { measure } from './helpers/e2e.ts';

const DEV_PASSWORD = 'SemaAI2026@';
const ADMIN_PHONE = process.env.ADMIN_PHONE ?? '';
const JWT_SECRET = process.env.JWT_SECRET ?? '';
const ACCESS_TTL_SEC = 15 * 60;

interface TokenPair {
    accessToken: string;
    refreshToken: string;
}

async function login(body: unknown): Promise<Response> {
    const { result } = await measure('POST /auth/login', () =>
        dashboardFetch(
            new Request('http://dashboard/auth/login', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            }),
        ),
    );
    return result;
}

async function refresh(body: unknown): Promise<Response> {
    const { result } = await measure('POST /auth/refresh', () =>
        dashboardFetch(
            new Request('http://dashboard/auth/refresh', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            }),
        ),
    );
    return result;
}

function assertPair(pair: TokenPair, label: string): void {
    assert.ok(
        typeof pair.accessToken === 'string' && pair.accessToken.length > 0,
        `${label}: accessToken непустая строка`,
    );
    assert.ok(
        typeof pair.refreshToken === 'string' && pair.refreshToken.length > 0,
        `${label}: refreshToken непустая строка`,
    );
}

describe('e2e: dashboard auth (login + refresh)', () => {
    after(async () => {
        await dashboardPool.end();
    });

    it('окружение теста готово (ADMIN_PHONE и JWT_SECRET заданы)', () => {
        assert.ok(ADMIN_PHONE.length > 0, 'ADMIN_PHONE задан в .env.dev');
        assert.ok(JWT_SECRET.length > 0, 'JWT_SECRET задан в .env.dev');
    });

    it('верный phone+password → 200 и валидная пара; access = JWT sub=ADMIN_PHONE, exp ~15м', async () => {
        const res = await login({ phone: ADMIN_PHONE, password: DEV_PASSWORD });
        assert.equal(res.status, 200, 'верные креды → 200');
        const pair = (await res.json()) as TokenPair;
        assertPair(pair, 'login');

        const payload = verifyJwt(pair.accessToken, JWT_SECRET);
        assert.ok(payload, 'access token проходит verifyJwt');
        assert.equal(payload?.sub, ADMIN_PHONE, 'sub = ADMIN_PHONE');
        const nowSec = Math.floor(Date.now() / 1000);
        assert.ok(
            payload && payload.exp > nowSec && payload.exp <= nowSec + ACCESS_TTL_SEC + 5,
            'exp в пределах ~15 минут',
        );
    });

    it('неверный password → 401', async () => {
        const res = await login({ phone: ADMIN_PHONE, password: 'wrong-password' });
        assert.equal(res.status, 401);
    });

    it('неверный phone (верный password) → 401', async () => {
        const res = await login({ phone: '+70000000000', password: DEV_PASSWORD });
        assert.equal(res.status, 401);
    });

    it('кривой body (нет password) → 400', async () => {
        const res = await login({ phone: ADMIN_PHONE });
        assert.equal(res.status, 400);
    });

    it('refresh: валидный refresh → 200 новая пара; access снова валиден', async () => {
        const loginRes = await login({ phone: ADMIN_PHONE, password: DEV_PASSWORD });
        const first = (await loginRes.json()) as TokenPair;

        const res = await refresh({ refreshToken: first.refreshToken });
        assert.equal(res.status, 200, 'валидный refresh → 200');
        const next = (await res.json()) as TokenPair;
        assertPair(next, 'refresh');

        assert.notEqual(next.refreshToken, first.refreshToken, 'ротация: новый refresh отличается');
        const payload = verifyJwt(next.accessToken, JWT_SECRET);
        assert.ok(payload, 'новый access валиден');
        assert.equal(payload?.sub, ADMIN_PHONE, 'sub нового access = ADMIN_PHONE');
    });

    it('ротация: старый refresh после использования → 401, новый работает (цепочка)', async () => {
        const loginRes = await login({ phone: ADMIN_PHONE, password: DEV_PASSWORD });
        const first = (await loginRes.json()) as TokenPair;

        const rot1 = await refresh({ refreshToken: first.refreshToken });
        assert.equal(rot1.status, 200);
        const second = (await rot1.json()) as TokenPair;

        // старый refresh больше не валиден (одноразовый + ротация)
        const reuse = await refresh({ refreshToken: first.refreshToken });
        assert.equal(reuse.status, 401, 'повторное использование старого refresh → 401');

        // новый refresh крутится дальше
        const rot2 = await refresh({ refreshToken: second.refreshToken });
        assert.equal(rot2.status, 200, 'новый refresh продолжает цепочку');
        const third = (await rot2.json()) as TokenPair;
        assertPair(third, 'refresh-chain');
        assert.notEqual(third.refreshToken, second.refreshToken, 'снова ротация');
    });

    it('refresh неизвестным токеном → 401', async () => {
        const res = await refresh({ refreshToken: 'totally-unknown-token' });
        assert.equal(res.status, 401);
    });
});
