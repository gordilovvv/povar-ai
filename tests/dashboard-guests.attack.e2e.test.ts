// Adversary e2e для guestsGetStatisticHandler + guestsGetListHandler.
// Контракт (из задачи):
//   auth: нет/битый/протухший/чужая подпись/alg:none/удалённый юзер → 401 на ОБЕ ручки, без данных;
//   list: SQL-мета в lastId — значение, не SQL (таблица цела, выдача = факт id > lastId в БД);
//   limit: отрицательный/0/гигантский/дробный/массив → clamp 1..100 или default 30, не 500.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ulid } from 'ulid';
import { pool as dashboardPool } from '#Dashboard/Db/Pool.js';
import { signJwt } from '#Dashboard/Lib/Jwt.js';
import { dashboardFetch } from '#Dashboard/Router.js';
import {
    closePool,
    dbOne,
    dbQuery,
    seedDashboardUser,
    signAuthToken,
    withClient,
} from './helpers/e2e.ts';

const DASH_PHONE = 'E2E_atk_guests_user';
const GHOST_PHONE = 'E2E_atk_guests_ghost';
const GUEST_PHONES = ['E2E_atk_gs_0', 'E2E_atk_gs_1'];
const ROUTES = ['/guests/statistic', '/guests', '/guests?limit=5'];

let token = '';

function jwtSecret(): string {
    const s = process.env.JWT_SECRET;
    if (!s) throw new Error('JWT_SECRET missing');
    return s;
}

async function req(path: string, auth: string | null = `Bearer ${token}`): Promise<Response> {
    const headers: Record<string, string> = {};
    if (auth !== null) headers.authorization = auth;
    return dashboardFetch(new Request(`http://dashboard${path}`, { headers }));
}

async function expect401(auth: string | null): Promise<void> {
    for (const path of ROUTES) {
        const res = await req(path, auth);
        assert.equal(res.status, 401, `${path} [${auth}] → 401`);
        assert.deepEqual(await res.json(), { error: 'unauthorized' }, `${path}: без данных`);
    }
}

async function cleanup(): Promise<void> {
    await withClient(async (client) => {
        await client.query(`delete from guests where wa_phone = any($1)`, [GUEST_PHONES]);
        await client.query(`delete from dashboard_users where phone_number = any($1)`, [
            [DASH_PHONE, GHOST_PHONE],
        ]);
    });
}

describe('attack: dashboard guests', () => {
    before(async () => {
        await cleanup();
        token = signAuthToken(await seedDashboardUser(DASH_PHONE));
        await withClient(async (client) => {
            for (const phone of GUEST_PHONES) {
                await client.query(
                    `insert into guests (id, wa_phone, gender) values ($1, $2, 'male')`,
                    [ulid(), phone],
                );
            }
        });
    });

    after(async () => {
        await cleanup();
        await closePool();
        await dashboardPool.end();
    });

    it('auth: нет заголовка / не Bearer / мусор → 401', async () => {
        await expect401(null);
        await expect401(`Basic ${token}`);
        await expect401(`bearer ${token}`);
        await expect401('Bearer ');
        await expect401('Bearer a.b.c');
        await expect401(`Bearer ${token}.extra`);
    });

    it('auth: протухший / чужая подпись / alg:none / удалённый юзер → 401', async () => {
        const id = await seedDashboardUser(DASH_PHONE);
        await expect401(`Bearer ${signAuthToken(id, -10)}`);
        await expect401(
            `Bearer ${signJwt({ sub: id, exp: Math.floor(Date.now() / 1000) + 3600 }, `${jwtSecret()}x`)}`,
        );
        const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
            'base64url',
        );
        const body = Buffer.from(JSON.stringify({ sub: id, exp: 9_999_999_999 })).toString(
            'base64url',
        );
        await expect401(`Bearer ${header}.${body}.`);

        const ghostId = await seedDashboardUser(GHOST_PHONE);
        const ghostToken = signAuthToken(ghostId);
        await withClient((c) => c.query(`delete from dashboard_users where id = $1`, [ghostId]));
        await expect401(`Bearer ${ghostToken}`);
        await expect401(`Bearer ${signAuthToken(`' or 1=1 --`)}`);
    });

    it('inject: SQL-мета в lastId — значение, выдача = факт id > lastId в БД, таблица цела', async () => {
        const payloads = [
            `' or 1=1 --`,
            `'; drop table guests; --`,
            `%L`,
            `\\'`,
            `0' union select 1,2,3,4,5,6 --`,
        ];
        for (const lastId of payloads) {
            const res = await req(`/guests?limit=100&lastId=${encodeURIComponent(lastId)}`);
            assert.equal(res.status, 200, `${lastId} → 200`);
            const list = (await res.json()) as { id: string }[];
            const dbIds = await dbQuery<{ id: string }>(
                `select id from guests where id > $1 order by id asc limit 100`,
                [lastId],
            );
            assert.deepEqual(
                list.map((g) => g.id),
                dbIds.map((r) => r.id),
                `${lastId}: выдача = факт БД`,
            );
        }
        const reg = await dbOne<{ t: string | null }>(
            `select to_regclass('public.guests')::text t`,
        );
        assert.equal(reg?.t, 'guests', 'таблица guests цела');
    });

    it('input: кривой limit → clamp/default, не 500', async () => {
        const total = Number((await dbOne<{ n: string }>(`select count(*) n from guests`))?.n);
        const cases: [string, number][] = [
            ['limit=-5', 1],
            ['limit=-99999999999999999999', 30],
            ['limit=99999999999999999999', 30],
            ['limit=101', 100],
            ['limit=1.5', 30],
            ['limit=1e2', 30],
            ['limit=', 30],
            ['limit=1&limit=2', 30],
            ['limit=%00', 30],
        ];
        for (const [q, expected] of cases) {
            const res = await req(`/guests?${q}`);
            assert.equal(res.status, 200, `${q} → 200`);
            assert.equal(
                ((await res.json()) as unknown[]).length,
                Math.min(expected, total),
                `${q}`,
            );
        }
    });

    it('input: lastId массивом / пустой / после максимального id → не 500', async () => {
        assert.equal((await req('/guests?lastId=a&lastId=b')).status, 200);
        assert.equal((await req('/guests?lastId=')).status, 200);
        const res = await req(`/guests?lastId=${'z'.repeat(50)}`);
        assert.equal(res.status, 200);
        const dbN = await dbOne<{ n: string }>(`select count(*) n from guests where id > $1`, [
            'z'.repeat(50),
        ]);
        assert.equal(((await res.json()) as unknown[]).length, Math.min(30, Number(dbN?.n)));
    });
});
