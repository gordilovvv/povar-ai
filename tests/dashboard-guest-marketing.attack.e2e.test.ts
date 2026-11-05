// Adversary e2e для guestPostMarketingHandler (+ инъекция в фильтр GET /guests?marketing).
// Контракт (из задачи):
//   auth: нет/битый/протухший/чужая подпись/alg none/удалённый юзер → 401, статус в БД не менялся;
//   кривой id в path (SQL-мета, %, гигантский) → 400/404, чужой гость не тронут, таблицы целы;
//   кривой body (не JSON, пусто, не объект, blocked_by_user, не строка, SQL в значении) → 400, статус не менялся;
//   гость blocked_by_user → 409, статус не меняется;
//   гонка: N параллельных toggle одного id → все 200, строка одна, в БД одно из присланных значений;
//   гонка с блокировкой гостем (бот ставит blocked_by_user) → в БД всегда blocked_by_user, хендлер не перезатирает;
//   GET /guests?marketing=<инъекция> → 200, фильтр не применён (как без него), таблица цела.
//   всё под e2e_atk_gm_* и чистится.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ulid } from 'ulid';
import { pool as dashboardPool } from '#Dashboard/Db/Pool.js';
import { signJwt } from '#Dashboard/Lib/Jwt.js';
import { dashboardFetch } from '#Dashboard/Router.js';
import { closePool, dbOne, seedDashboardUser, signAuthToken, withClient } from './helpers/e2e.ts';

const DASH_PHONE = 'E2E_atk_gm_user';
const GHOST_PHONE = 'E2E_atk_gm_ghost';
const RUN = Date.now().toString(36);
const AUTH = { id: ulid(), phone: `e2e_atk_gm_auth_${RUN}` };
const BLOCKED = { id: ulid(), phone: `e2e_atk_gm_blocked_${RUN}` };
const RACE = { id: ulid(), phone: `e2e_atk_gm_race_${RUN}` };
const GUEST_IDS = [AUTH.id, BLOCKED.id, RACE.id];
const PARALLEL = 10;

let token = '';

function jwtSecret(): string {
    const s = process.env.JWT_SECRET;
    if (!s) throw new Error('JWT_SECRET missing');
    return s;
}

function post(
    path: string,
    body: string | null,
    auth: string | null = `Bearer ${token}`,
): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (auth !== null) headers.authorization = auth;
    return dashboardFetch(
        new Request(`http://dashboard${path}`, { method: 'POST', headers, body }),
    );
}

const marketingPath = (id: string) => `/guests/${id}/marketing`;
const json = (marketing: unknown) => JSON.stringify({ marketing });

async function guestRow(id: string) {
    return dbOne<{ marketing: string | null; n: number }>(
        `select (select marketing from guests where id = $1) as marketing,
                (select count(*)::int from guests where id = $1) as n`,
        [id],
    );
}

async function cleanup(): Promise<void> {
    await withClient(async (client) => {
        await client.query(`delete from guests where id = any($1)`, [GUEST_IDS]);
        await client.query(`delete from dashboard_users where phone_number = any($1)`, [
            [DASH_PHONE, GHOST_PHONE],
        ]);
    });
}

describe('attack: dashboard guestPostMarketing', () => {
    before(async () => {
        await cleanup();
        token = signAuthToken(await seedDashboardUser(DASH_PHONE));
        await withClient(async (client) => {
            for (const [g, marketing] of [
                [AUTH, 'enabled'],
                [BLOCKED, 'blocked_by_user'],
                [RACE, 'enabled'],
            ] as const) {
                await client.query(
                    `insert into guests (id, wa_phone, first_name, marketing) values ($1, $2, 'E2E', $3)`,
                    [g.id, g.phone, marketing],
                );
            }
        });
    });

    after(async () => {
        await cleanup();
        await closePool();
        await dashboardPool.end();
    });

    it('auth: любой невалидный токен → 401, статус в БД не менялся', async () => {
        const id = await seedDashboardUser(DASH_PHONE);
        const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
            'base64url',
        );
        const noneBody = Buffer.from(JSON.stringify({ sub: id, exp: 9_999_999_999 })).toString(
            'base64url',
        );
        const ghostId = await seedDashboardUser(GHOST_PHONE);
        const ghostToken = signAuthToken(ghostId);
        await withClient((c) => c.query(`delete from dashboard_users where id = $1`, [ghostId]));
        for (const auth of [
            null,
            '',
            'Bearer ',
            `Basic ${token}`,
            `bearer ${token}`,
            'Bearer a.b.c',
            `Bearer ${token}.`,
            `Bearer ${signAuthToken(id, -10)}`,
            `Bearer ${signJwt({ sub: id, exp: Math.floor(Date.now() / 1000) + 3600 }, `${jwtSecret()}x`)}`,
            `Bearer ${noneHeader}.${noneBody}.`,
            `Bearer ${ghostToken}`,
        ]) {
            const res = await post(marketingPath(AUTH.id), json('disabled'), auth);
            assert.equal(res.status, 401, `[${auth}] → 401`);
            assert.deepEqual(await guestRow(AUTH.id), { marketing: 'enabled', n: 1 });
        }
    });

    it('inject: кривой id в path → 400/404, чужой гость не тронут, таблица цела', async () => {
        const paths = [
            marketingPath(`${AUTH.id}' or '1'='1`),
            marketingPath(`' or id like 'e2e_atk_gm_%' or '`),
            marketingPath(`${AUTH.id}'; update guests set marketing='disabled'; --`),
            marketingPath('%'),
            marketingPath('%25'),
            marketingPath('%27'),
            marketingPath('%00'),
            marketingPath(`${AUTH.id}%20`),
            marketingPath(AUTH.id.toLowerCase()),
            marketingPath('$1'),
            marketingPath('%L'),
            marketingPath('%1$L'),
            marketingPath('\\'),
            marketingPath('"'),
            marketingPath('null'),
            marketingPath('a'.repeat(5000)),
            '/guests//marketing',
            `/guests/${AUTH.id}/x/marketing`,
        ];
        for (const path of paths) {
            const res = await post(path, json('disabled'));
            assert.ok(
                [400, 404].includes(res.status),
                `${path.slice(0, 120)} → 400/404, получили ${res.status}`,
            );
            assert.deepEqual(await guestRow(AUTH.id), { marketing: 'enabled', n: 1 });
        }
        assert.equal(
            (await dbOne<{ t: string }>(`select to_regclass('public.guests')::text t`))?.t,
            'guests',
        );
        assert.equal(
            Number(
                (
                    await dbOne<{ n: number }>(
                        `select count(*)::int n from guests where id = any($1) and marketing = 'disabled'`,
                        [GUEST_IDS],
                    )
                )?.n,
            ),
            0,
            'ни один сид не переведён в disabled',
        );
    });

    it('input: кривой body → 400, статус не менялся', async () => {
        const bodies: (string | null)[] = [
            null,
            '',
            '{',
            'null',
            '"enabled"',
            '[]',
            '["enabled"]',
            '{}',
            json('blocked_by_user'),
            json('Enabled'),
            json(' enabled'),
            json(['enabled']),
            json({ value: 'enabled' }),
            json(true),
            json(1),
            json(null),
            json(`enabled' or '1'='1`),
            json("disabled'; update guests set marketing='disabled'; --"),
            JSON.stringify({ Marketing: 'disabled' }),
            JSON.stringify({ marketing: 'disabled', id: BLOCKED.id }).replace('disabled', 'x'),
            `{"marketing":"disabled","marketing":"blocked_by_user"}`,
        ];
        for (const body of bodies) {
            const res = await post(marketingPath(AUTH.id), body);
            assert.equal(res.status, 400, `[${body}] → 400, получили ${res.status}`);
            assert.deepEqual(await guestRow(AUTH.id), { marketing: 'enabled', n: 1 }, `[${body}]`);
        }
        // лишние поля не дают доступа к чужому id из body
        const res = await post(
            marketingPath(AUTH.id),
            JSON.stringify({ marketing: 'enabled', id: BLOCKED.id, wa_phone: BLOCKED.phone }),
        );
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { id: AUTH.id, marketing: 'enabled' });
        assert.deepEqual(await guestRow(BLOCKED.id), { marketing: 'blocked_by_user', n: 1 });
    });

    it('blocked_by_user: 5 параллельных enabled/disabled → все 409, статус не менялся', async () => {
        const results = await Promise.allSettled(
            Array.from({ length: 5 }, (_, i) =>
                post(marketingPath(BLOCKED.id), json(i % 2 ? 'enabled' : 'disabled')),
            ),
        );
        for (const r of results) {
            assert.equal(r.status, 'fulfilled');
            assert.equal(r.status === 'fulfilled' ? r.value.status : -1, 409);
        }
        assert.deepEqual(await guestRow(BLOCKED.id), { marketing: 'blocked_by_user', n: 1 });
    });

    it('race: 10 параллельных toggle одного id → все 200, строка одна, в БД одно из присланных', async () => {
        const sent = Array.from({ length: PARALLEL }, (_, i) => (i % 2 ? 'enabled' : 'disabled'));
        const results = await Promise.allSettled(
            sent.map((m) => post(marketingPath(RACE.id), json(m))),
        );
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            assert.equal(r?.status, 'fulfilled', `#${i}`);
            const res = r?.status === 'fulfilled' ? r.value : null;
            assert.equal(res?.status, 200, `#${i} → 200`);
            assert.deepEqual(
                await res?.json(),
                { id: RACE.id, marketing: sent[i] },
                `#${i}: ответ = своё значение`,
            );
        }
        const row = await guestRow(RACE.id);
        assert.equal(row?.n, 1, 'строка одна');
        assert.ok(
            ['enabled', 'disabled'].includes(row?.marketing ?? ''),
            `в БД: ${row?.marketing}`,
        );
    });

    it('race: гость блокирует рассылку параллельно с dashboard → blocked_by_user не перезатирается', async () => {
        for (let i = 0; i < 8; i++) {
            await withClient((c) =>
                c.query(`update guests set marketing = 'enabled' where id = $1`, [RACE.id]),
            );
            const [dash, bot] = await Promise.allSettled([
                post(marketingPath(RACE.id), json('disabled')),
                withClient((c) =>
                    c.query(`update guests set marketing = 'blocked_by_user' where id = $1`, [
                        RACE.id,
                    ]),
                ),
            ]);
            assert.equal(bot.status, 'fulfilled', `#${i}`);
            assert.equal(dash.status, 'fulfilled', `#${i}`);
            const status = dash.status === 'fulfilled' ? dash.value.status : -1;
            assert.ok(
                [200, 409].includes(status),
                `#${i}: 200 (успел раньше) или 409, получили ${status}`,
            );
            assert.deepEqual(
                await guestRow(RACE.id),
                { marketing: 'blocked_by_user', n: 1 },
                `#${i}: блок гостя побеждает`,
            );
        }
    });

    it('GET /guests?marketing=<инъекция> → 200, фильтр не применён, таблица цела', async () => {
        const get = (query: string) =>
            dashboardFetch(
                new Request(`http://dashboard/guests?${query}`, {
                    headers: { authorization: `Bearer ${token}` },
                }),
            );
        const baseline = (await (await get('limit=5')).json()) as { id: string }[];
        for (const q of [
            `marketing=${encodeURIComponent(`enabled' or '1'='1`)}`,
            `marketing=${encodeURIComponent(`'; drop table guests; --`)}`,
            `marketing=%25`,
            `marketing=%27`,
            `marketing=%00`,
            `marketing=enabled&marketing=disabled`,
            `marketing=ENABLED`,
            `marketing=${encodeURIComponent(' enabled')}`,
            `marketing=${'a'.repeat(5000)}`,
            `marketing=`,
            `lastId=${encodeURIComponent(`' or '1'='1`)}&limit=5`,
            `lastId=%25&limit=5`,
            `limit=-1`,
            `limit=99999999999999999999`,
            `limit=1e3`,
        ]) {
            const res = await get(
                `${q}${q.startsWith('limit') || q.includes('limit=') ? '' : '&limit=5'}`,
            );
            assert.equal(res.status, 200, `[${q}] → 200`);
            const items = (await res.json()) as { id: string; marketing: string | null }[];
            assert.ok(Array.isArray(items), `[${q}] массив`);
            assert.ok(items.length <= 100, `[${q}] limit клампится`);
            if (q.startsWith('marketing=')) {
                assert.deepEqual(
                    items.map((g) => g.id),
                    baseline.map((g) => g.id),
                    `[${q}] невалидный фильтр = без фильтра`,
                );
            }
        }
        assert.equal(
            (await dbOne<{ t: string }>(`select to_regclass('public.guests')::text t`))?.t,
            'guests',
        );
        assert.deepEqual(await guestRow(AUTH.id), { marketing: 'enabled', n: 1 });
    });
});
