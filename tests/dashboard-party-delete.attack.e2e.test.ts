// Adversary e2e для partyPostDeleteHandler.
// Контракт (из задачи):
//   auth: нет/битый/протухший/чужая подпись/alg none/удалённый юзер → 401, ничего не удалено;
//   кривой id в path (SQL-мета, %, url-encoded, гигантский) → не 500, чужое/своё не удалено, таблицы целы;
//   гонка: N параллельных delete одного id → ровно один 200, остальные 404, нет 500;
//   гонка delete и вставки гостя в guest-лист → либо 200 и гостя нет, либо 409 и всё цело; нет 500.
//   бэк смотрит на прод: ≤3 вечеринки, всё под e2e_atk_pd_* и чистится.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { PoolClient } from 'pg';
import { pool as dashboardPool } from '#Dashboard/Db/Pool.js';
import { signJwt } from '#Dashboard/Lib/Jwt.js';
import { dashboardFetch } from '#Dashboard/Router.js';
import { closePool, dbOne, seedDashboardUser, signAuthToken, withClient } from './helpers/e2e.ts';

const DASH_PHONE = 'E2E_atk_pd_user';
const GHOST_PHONE = 'E2E_atk_pd_ghost';
const RUN = Date.now().toString(36);
const AUTH_ID = `e2e_atk_pd_auth_${RUN}`;
const RACE_ID = `e2e_atk_pd_race_${RUN}`;
const GL_ID = `e2e_atk_pd_gl_${RUN}`;
const OWN_IDS = [AUTH_ID, RACE_ID, GL_ID];
const GUEST_ID = `e2e_atk_pd_guest_${RUN}`;
const WA_PHONE = `e2e_atk_pd_phone_${RUN}`;
const FULL = { party: 1, time: 1, tables: 1, sends: 1 };
const GONE = { party: 0, time: 0, tables: 0, sends: 0 };

let token = '';

function jwtSecret(): string {
    const s = process.env.JWT_SECRET;
    if (!s) throw new Error('JWT_SECRET missing');
    return s;
}

function postDelete(path: string, auth: string | null = `Bearer ${token}`): Promise<Response> {
    const headers: Record<string, string> = {};
    if (auth !== null) headers.authorization = auth;
    return dashboardFetch(new Request(`http://dashboard${path}`, { method: 'POST', headers }));
}

const deletePath = (id: string) => `/party/${id}/delete`;

async function countRows(id: string): Promise<Record<string, number>> {
    const row = await dbOne<Record<string, number>>(
        `select
            (select count(*)::int from party where id = $1) as party,
            (select count(*)::int from party_time where party_id = $1) as time,
            (select count(*)::int from party_tables where party_id = $1) as tables,
            (select count(*)::int from wa_marketing_sends where party_id = $1) as sends`,
        [id],
    );
    assert.ok(row);
    return row;
}

const guestlistCount = async (id: string) =>
    Number(
        (
            await dbOne<{ c: number }>(
                `select count(*)::int c from party_guestlist where party_id = $1`,
                [id],
            )
        )?.c,
    );

async function seedParty(client: PoolClient, id: string): Promise<void> {
    await client.query(
        `insert into party (id, type, name, price, location) values ($1, 'owned', 'E2E atk delete', 0, 'E2E')`,
        [id],
    );
    await client.query(
        `insert into party_time (party_id, party_start_at, party_end_at)
         values ($1, '2026-12-01T18:00:00Z', '2026-12-02T02:00:00Z')`,
        [id],
    );
    await client.query(`insert into party_tables (party_id, map) values ($1, 'e2e')`, [id]);
    await client.query(
        `insert into wa_marketing_sends (party_id, wa_phone, sent_at) values ($1, $2, now())`,
        [id, WA_PHONE],
    );
}

async function cleanup(): Promise<void> {
    await withClient(async (client) => {
        await client.query(`delete from party_guestlist where party_id = any($1)`, [OWN_IDS]);
        await client.query(`delete from guests where id = $1`, [GUEST_ID]);
        await client.query(`delete from wa_marketing_sends where party_id = any($1)`, [OWN_IDS]);
        await client.query(`delete from party_tables where party_id = any($1)`, [OWN_IDS]);
        await client.query(`delete from party_time where party_id = any($1)`, [OWN_IDS]);
        await client.query(`delete from party where id = any($1)`, [OWN_IDS]);
        await client.query(`delete from dashboard_users where phone_number = any($1)`, [
            [DASH_PHONE, GHOST_PHONE],
        ]);
    });
}

async function tablesIntact(): Promise<void> {
    for (const t of [
        'party',
        'party_time',
        'party_tables',
        'wa_marketing_sends',
        'party_guestlist',
    ]) {
        assert.equal(
            (await dbOne<{ t: string }>(`select to_regclass($1)::text t`, [`public.${t}`]))?.t,
            t,
            `таблица ${t} цела`,
        );
    }
}

describe('attack: dashboard partyPostDelete', () => {
    before(async () => {
        await cleanup();
        token = signAuthToken(await seedDashboardUser(DASH_PHONE));
        await withClient(async (client) => {
            await seedParty(client, AUTH_ID);
            await client.query(`insert into guests (id, first_name) values ($1, 'E2E')`, [
                GUEST_ID,
            ]);
        });
    });

    after(async () => {
        await cleanup();
        await closePool();
        await dashboardPool.end();
    });

    it('auth: любой невалидный токен → 401, ничего не удалено', async () => {
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
            `Bearer ${signAuthToken(id, -10)}`,
            `Bearer ${signJwt({ sub: id, exp: Math.floor(Date.now() / 1000) + 3600 }, `${jwtSecret()}x`)}`,
            `Bearer ${noneHeader}.${noneBody}.`,
            `Bearer ${ghostToken}`,
        ]) {
            const res = await postDelete(deletePath(AUTH_ID), auth);
            assert.equal(res.status, 401, `[${auth}] → 401`);
            assert.deepEqual(await countRows(AUTH_ID), FULL, `[${auth}]: ничего не удалено`);
        }
    });

    it('inject: кривой id в path → не 500, ничего не удалено, таблицы целы', async () => {
        const paths = [
            deletePath(`${AUTH_ID}'; delete from party where id like 'e2e_atk_pd_%'; --`),
            deletePath(`' or '1'='1`),
            deletePath(`' or id like 'e2e_atk_pd_%' or '`),
            deletePath('e2e_atk_pd_%'),
            deletePath('%'),
            deletePath('%25'),
            deletePath('%27'),
            deletePath('%00'),
            deletePath('%0a'),
            deletePath(encodeURIComponent(`${AUTH_ID}'`)),
            deletePath(encodeURIComponent(AUTH_ID).replace('e', '%65')),
            deletePath(`${AUTH_ID}%20`),
            deletePath(`%20${AUTH_ID}`),
            deletePath(`${AUTH_ID.toUpperCase()}`),
            deletePath('$1'),
            deletePath('%L'),
            deletePath('%1$L'),
            deletePath('\\'),
            deletePath('"'),
            deletePath('a'.repeat(5000)),
            '/party//delete',
            `/party/${AUTH_ID}/x/delete`,
        ];
        for (const path of paths) {
            const res = await postDelete(path);
            assert.ok(
                [400, 404].includes(res.status),
                `${path.slice(0, 120)} → 400/404, получили ${res.status}`,
            );
            assert.deepEqual(await countRows(AUTH_ID), FULL, `${path.slice(0, 120)}: цело`);
        }
        await tablesIntact();
    });

    it('race: 10 параллельных delete одного id → ровно один 200, остальные 404, всё удалено', async () => {
        await withClient((c) => seedParty(c, RACE_ID));
        const results = await Promise.allSettled(
            Array.from({ length: 10 }, () => postDelete(deletePath(RACE_ID))),
        );
        const statuses = results.map((r) => (r.status === 'fulfilled' ? r.value.status : -1));
        assert.equal(statuses.filter((s) => s === 200).length, 1, `ровно один 200: ${statuses}`);
        assert.equal(statuses.filter((s) => s === 404).length, 9, `остальные 404: ${statuses}`);
        assert.deepEqual(await countRows(RACE_ID), GONE);
        assert.deepEqual(await countRows(AUTH_ID), FULL, 'соседняя вечеринка цела');
    });

    it('race: гость коммитится, пока delete ждёт замок на party (старый снапшот) → 409, всё цело', {
        timeout: 20_000,
    }, async () => {
        await withClient((c) => seedParty(c, GL_ID));
        let res: Response | null = null;
        await withClient(async (locker) => {
            await locker.query('begin');
            await locker.query(`select 1 from party where id = $1 for key share`, [GL_ID]);
            const pending = postDelete(deletePath(GL_ID));
            await waitForBlocked();
            try {
                await withClient((c) =>
                    c.query(
                        `insert into party_guestlist (party_id, guest_id, joined_at) values ($1, $2, now())`,
                        [GL_ID, GUEST_ID],
                    ),
                );
            } finally {
                await locker.query('commit');
            }
            res = await pending;
        });
        assert.equal(res?.status, 409, 'гость закоммичен до конца statement-а → 409');
        assert.deepEqual(await countRows(GL_ID), FULL, 'ничего не удалено');
        assert.equal(await guestlistCount(GL_ID), 1);
        await withClient((c) =>
            c.query(`delete from party_guestlist where party_id = $1`, [GL_ID]),
        );
    });

    it('race: незакоммиченная вставка гостя держит party, delete ждёт → коммит → 409; откат → 200', {
        timeout: 20_000,
    }, async () => {
        for (const outcome of ['commit', 'rollback'] as const) {
            if ((await countRows(GL_ID)).party === 0) {
                await withClient((c) => seedParty(c, GL_ID));
            }
            await withClient(async (guest) => {
                await guest.query('begin');
                await guest.query(
                    `insert into party_guestlist (party_id, guest_id, joined_at) values ($1, $2, now())`,
                    [GL_ID, GUEST_ID],
                );
                const pending = postDelete(deletePath(GL_ID));
                try {
                    await waitForBlocked();
                } finally {
                    await guest.query(outcome);
                }
                const res = await pending;
                if (outcome === 'commit') {
                    assert.equal(res.status, 409, 'commit гостя → 409');
                    assert.deepEqual(await countRows(GL_ID), FULL);
                    assert.equal(await guestlistCount(GL_ID), 1);
                } else {
                    assert.equal(res.status, 200, 'rollback гостя → 200');
                    assert.deepEqual(await countRows(GL_ID), GONE);
                    assert.equal(await guestlistCount(GL_ID), 0);
                }
            });
            await withClient((c) =>
                c.query(`delete from party_guestlist where party_id = $1`, [GL_ID]),
            );
        }
    });

    it('race: параллельно delete и вставки гостя → только {200, гостя нет} или {409, всё цело}; нет 500', async () => {
        for (let i = 0; i < 8; i++) {
            if ((await countRows(GL_ID)).party === 0) {
                await withClient((c) => seedParty(c, GL_ID));
            }
            const [del, ins] = await Promise.allSettled([
                postDelete(deletePath(GL_ID)),
                withClient((c) =>
                    c.query(
                        `insert into party_guestlist (party_id, guest_id, joined_at) values ($1, $2, now())`,
                        [GL_ID, GUEST_ID],
                    ),
                ),
            ]);
            assert.equal(del.status, 'fulfilled');
            const status = del.status === 'fulfilled' ? del.value.status : -1;
            const gl = await guestlistCount(GL_ID);
            if (status === 200) {
                assert.equal(
                    ins.status,
                    'rejected',
                    `#${i}: delete прошёл — вставка обязана упасть`,
                );
                assert.deepEqual(await countRows(GL_ID), GONE, `#${i}`);
                assert.equal(gl, 0, `#${i}`);
            } else {
                assert.equal(status, 409, `#${i}: иначе только 409, получили ${status}`);
                assert.equal(ins.status, 'fulfilled', `#${i}`);
                assert.deepEqual(await countRows(GL_ID), FULL, `#${i}`);
                assert.equal(gl, 1, `#${i}`);
            }
            await withClient((c) =>
                c.query(`delete from party_guestlist where party_id = $1`, [GL_ID]),
            );
        }
    });
});

async function waitForBlocked(): Promise<void> {
    for (let i = 0; i < 100; i++) {
        const row = await dbOne<{ c: number }>(
            `select count(*)::int c from pg_stat_activity
             where wait_event_type = 'Lock' and query like '%delete from party where id = %'
               and query like $1`,
            [`%${RUN}%`],
        );
        if (Number(row?.c) > 0) return;
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('delete не встал на замок');
}
