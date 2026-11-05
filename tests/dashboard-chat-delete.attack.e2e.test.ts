// Adversary e2e для chatPostDeleteHandler.
// Контракт (из задачи):
//   auth: нет/битый/протухший/чужая подпись/alg none/удалённый юзер → 401, ничего не удалено;
//   кривой phone в path (SQL-мета, %, url-encoded, гигантский, control) → 400/404, чужое не удалено, таблицы целы;
//   busy (need_processed|processing) → 409, чат/сообщения/гость нетронуты;
//   гонка: N параллельных delete одного phone → ровно один 200, остальные 404, нет 500, гость disabled ровно раз;
//   гонка delete и вставки сообщения → {200, чат и сообщения ушли} или {409, всё цело}; нет 500;
//   сообщение закоммичено, пока delete ждёт замок (старый снапшот) → FK → 409, всё цело.
//   party_guestlist, wa_marketing_sends, профиль гостя не трогаем; всё под e2e_atk_cd_* и чистится.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { PoolClient } from 'pg';
import { ulid } from 'ulid';
import { insertOutgoingMessage } from '#Dashboard/Db/Chats.js';
import { pool as dashboardPool } from '#Dashboard/Db/Pool.js';
import { signJwt } from '#Dashboard/Lib/Jwt.js';
import { dashboardFetch } from '#Dashboard/Router.js';
import { closePool, dbOne, seedDashboardUser, signAuthToken, withClient } from './helpers/e2e.ts';

const DASH_PHONE = 'E2E_atk_cd_user';
const GHOST_PHONE = 'E2E_atk_cd_ghost';
const RUN = Date.now().toString(36);
const PARTY_ID = `e2e_atk_cd_party_${RUN}`;
const AUTH = { phone: `e2e_atk_cd_auth_${RUN}`, guestId: ulid() };
const BUSY = { phone: `e2e_atk_cd_busy_${RUN}`, guestId: ulid() };
const RACE = { phone: `e2e_atk_cd_race_${RUN}`, guestId: ulid() };
const FK = { phone: `e2e_atk_cd_fk_${RUN}`, guestId: ulid() };
const CHATS = [AUTH, BUSY, RACE, FK];
const PHONES = CHATS.map((c) => c.phone);
const GUEST_IDS = CHATS.map((c) => c.guestId);
const MESSAGES_PER_CHAT = 3;

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

const deletePath = (phone: string) => `/chats/${phone}/delete`;

interface Rows {
    chats: number;
    messages: number;
    guests: number;
    guestlist: number;
    sends: number;
    marketing: string | null;
}

async function rows(phone: string): Promise<Rows> {
    const row = await dbOne<Rows>(
        `select
            (select count(*)::int from wa_chats where wa_phone = $1) as chats,
            (select count(*)::int from wa_messages where wa_chat_phone = $1) as messages,
            (select count(*)::int from guests where wa_phone = $1) as guests,
            (select count(*)::int from party_guestlist gl join guests g on g.id = gl.guest_id where g.wa_phone = $1) as guestlist,
            (select count(*)::int from wa_marketing_sends where wa_phone = $1) as sends,
            (select marketing from guests where wa_phone = $1) as marketing`,
        [phone],
    );
    assert.ok(row);
    return row;
}

const full = (messages = MESSAGES_PER_CHAT, marketing = 'enabled'): Rows => ({
    chats: 1,
    messages,
    guests: 1,
    guestlist: 1,
    sends: 1,
    marketing,
});
const gone = (marketing = 'disabled'): Rows => ({
    chats: 0,
    messages: 0,
    guests: 1,
    guestlist: 1,
    sends: 1,
    marketing,
});

async function insertMessage(
    client: PoolClient,
    phone: string,
    workerStatus: string | null,
): Promise<void> {
    await client.query(
        `insert into wa_messages (id, wa_message_id, wa_chat_phone, text, owner, status, worker_status, concurrency_version, sent_at)
         values ($1, $2, $3, 'hi', 'guest', 'delivered', $4, 0, now())`,
        [ulid(), `wamid.e2e_atk_cd_${ulid()}`, phone, workerStatus],
    );
}

async function seedChat(client: PoolClient, chat: { phone: string; guestId: string }) {
    await client.query(
        `insert into guests (id, wa_phone, first_name, marketing) values ($1, $2, 'E2E', 'enabled')
         on conflict (id) do nothing`,
        [chat.guestId, chat.phone],
    );
    await client.query(
        `insert into party_guestlist (party_id, guest_id) values ($1, $2) on conflict do nothing`,
        [PARTY_ID, chat.guestId],
    );
    await client.query(
        `insert into wa_marketing_sends (party_id, wa_phone, sent_at)
         select $1, $2, now() where not exists (select 1 from wa_marketing_sends where party_id = $1 and wa_phone = $2)`,
        [PARTY_ID, chat.phone],
    );
    await client.query(`update guests set marketing = 'enabled' where id = $1`, [chat.guestId]);
    await client.query(`insert into wa_chats (wa_phone, guest_id) values ($1, $2)`, [
        chat.phone,
        chat.guestId,
    ]);
    // реальный микс: ответ бота лежит с worker_status null (insertOutgoingMessage его не ставит)
    await insertMessage(client, chat.phone, 'processed');
    await insertMessage(client, chat.phone, 'skipped');
    await insertOutgoingMessage(client, {
        id: ulid(),
        waMessageId: `wamid.e2e_atk_cd_${ulid()}`,
        phone: chat.phone,
        text: 'bot reply',
        sentAt: new Date(),
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
        await client.query(`delete from dashboard_users where phone_number = any($1)`, [
            [DASH_PHONE, GHOST_PHONE],
        ]);
    });
}

async function tablesIntact(): Promise<void> {
    for (const t of [
        'wa_chats',
        'wa_messages',
        'guests',
        'party_guestlist',
        'wa_marketing_sends',
    ]) {
        assert.equal(
            (await dbOne<{ t: string }>(`select to_regclass($1)::text t`, [`public.${t}`]))?.t,
            t,
            `таблица ${t} цела`,
        );
    }
}

describe('attack: dashboard chatPostDelete', () => {
    before(async () => {
        await cleanup();
        token = signAuthToken(await seedDashboardUser(DASH_PHONE));
        await withClient(async (client) => {
            await client.query(
                `insert into party (id, type, name, price, location) values ($1, 'owned', 'E2E atk chat delete', 0, 'E2E')`,
                [PARTY_ID],
            );
            await seedChat(client, AUTH);
            await seedChat(client, BUSY);
        });
    });

    after(async () => {
        await cleanup();
        await closePool();
        await dashboardPool.end();
    });

    it('auth: любой невалидный токен → 401, ничего не удалено, гость enabled', async () => {
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
            const res = await postDelete(deletePath(AUTH.phone), auth);
            assert.equal(res.status, 401, `[${auth}] → 401`);
            assert.deepEqual(await rows(AUTH.phone), full(), `[${auth}]: ничего не удалено`);
        }
    });

    it('inject: кривой phone в path → 400/404, чужой чат цел, таблицы целы', async () => {
        const paths = [
            deletePath(
                `${AUTH.phone}'; delete from wa_chats where wa_phone like 'e2e_atk_cd_%'; --`,
            ),
            deletePath(`' or '1'='1`),
            deletePath(`' or wa_phone like 'e2e_atk_cd_%' or '`),
            deletePath(`') or true; --`),
            deletePath('e2e_atk_cd_%'),
            deletePath('%'),
            deletePath('_'),
            deletePath('%25'),
            deletePath('%27'),
            deletePath('%00'),
            deletePath('%0a'),
            deletePath(encodeURIComponent(`${AUTH.phone}'`)),
            deletePath(encodeURIComponent(AUTH.phone).replace('e', '%65')),
            deletePath(`${AUTH.phone}%20`),
            deletePath(`%20${AUTH.phone}`),
            deletePath(AUTH.phone.toUpperCase()),
            deletePath('$1'),
            deletePath('%L'),
            deletePath('%1$L'),
            deletePath('%2$L'),
            deletePath('\\'),
            deletePath('"'),
            deletePath('null'),
            deletePath('a'.repeat(5000)),
            '/chats//delete',
            `/chats/${AUTH.phone}/x/delete`,
        ];
        for (const path of paths) {
            const res = await postDelete(path);
            assert.ok(
                [400, 404].includes(res.status),
                `${path.slice(0, 120)} → 400/404, получили ${res.status}`,
            );
            assert.deepEqual(await rows(AUTH.phone), full(), `${path.slice(0, 120)}: цело`);
        }
        await tablesIntact();
    });

    it('input: control-символы и пустой phone → 400 (не 404, не 500)', async () => {
        for (const phone of ['%09', '%7f', ' ', '%20', '%01']) {
            const res = await postDelete(deletePath(phone));
            assert.ok(
                [400, 404].includes(res.status),
                `[${phone}] → 400/404, получили ${res.status}`,
            );
        }
        const res = await dashboardFetch(
            new Request(`http://dashboard/chats/${encodeURIComponent(AUTH.phone)}/delete`, {
                method: 'GET',
                headers: { authorization: `Bearer ${token}` },
            }),
        );
        assert.equal(res.status, 404, 'GET на delete-роут не существует');
        assert.deepEqual(await rows(AUTH.phone), full());
    });

    it('busy: processing / need_processed → 409, ничего не удалено, гость enabled', async () => {
        await withClient((c) => insertMessage(c, BUSY.phone, 'processing'));
        const before = await rows(BUSY.phone);
        assert.deepEqual(before, full(MESSAGES_PER_CHAT + 1));

        const results = await Promise.allSettled(
            Array.from({ length: 5 }, () => postDelete(deletePath(BUSY.phone))),
        );
        for (const r of results) {
            assert.equal(r.status, 'fulfilled');
            assert.equal(r.status === 'fulfilled' ? r.value.status : -1, 409);
        }
        assert.deepEqual(await rows(BUSY.phone), before, 'busy: ни одной строки не ушло');
        assert.equal(
            (
                await dbOne<{ s: string }>(
                    `select worker_status s from wa_messages where wa_chat_phone = $1 and worker_status = 'processing'`,
                    [BUSY.phone],
                )
            )?.s,
            'processing',
            'сообщение воркера на месте',
        );
    });

    it('plain: обычный чат (гость + ответ бота с worker_status null) удаляется → 200, гость disabled', async () => {
        const res = await postDelete(deletePath(AUTH.phone));
        assert.equal(res.status, 200, 'processed/skipped/null — воркер их не держит');
        assert.deepEqual(await rows(AUTH.phone), gone());
        await withClient((c) => seedChat(c, AUTH));
    });

    it('race: 10 параллельных delete одного phone → ровно один 200, остальные 404, нет 500', async () => {
        await withClient((c) => seedChat(c, RACE));
        const results = await Promise.allSettled(
            Array.from({ length: 10 }, () => postDelete(deletePath(RACE.phone))),
        );
        const statuses = results.map((r) => (r.status === 'fulfilled' ? r.value.status : -1));
        assert.equal(statuses.filter((s) => s === 200).length, 1, `ровно один 200: ${statuses}`);
        assert.equal(statuses.filter((s) => s === 404).length, 9, `остальные 404: ${statuses}`);
        assert.deepEqual(await rows(RACE.phone), gone());
        assert.deepEqual(await rows(AUTH.phone), full(), 'соседний чат цел');
    });

    it('race: сообщение коммитится, пока delete ждёт замок на wa_chats (старый снапшот) → 409, всё цело', {
        timeout: 20_000,
    }, async () => {
        await withClient((c) => seedChat(c, FK));
        let res: Response | null = null;
        await withClient(async (locker) => {
            await locker.query('begin');
            await locker.query(`select 1 from wa_chats where wa_phone = $1 for key share`, [
                FK.phone,
            ]);
            const pending = postDelete(deletePath(FK.phone));
            await waitForBlocked();
            try {
                await withClient((c) => insertMessage(c, FK.phone, 'processed'));
            } finally {
                await locker.query('commit');
            }
            res = await pending;
        });
        assert.equal(res?.status, 409, 'сообщение закоммичено до конца statement-а → 409');
        assert.deepEqual(
            await rows(FK.phone),
            full(MESSAGES_PER_CHAT + 1),
            'ничего не удалено, гость enabled',
        );
    });

    it('race: параллельно delete и вставка сообщения → {200, чат ушёл} или {409, всё цело}; нет 500', async () => {
        for (let i = 0; i < 8; i++) {
            if ((await rows(FK.phone)).chats === 0) {
                await withClient((c) => seedChat(c, FK));
            }
            const before = await rows(FK.phone);
            const [del, ins] = await Promise.allSettled([
                postDelete(deletePath(FK.phone)),
                withClient((c) => insertMessage(c, FK.phone, 'processed')),
            ]);
            assert.equal(del.status, 'fulfilled');
            const status = del.status === 'fulfilled' ? del.value.status : -1;
            const after = await rows(FK.phone);
            if (status === 200) {
                assert.deepEqual(
                    after,
                    gone(),
                    `#${i}: 200 → чат и сообщения ушли, гость disabled`,
                );
            } else {
                assert.equal(status, 409, `#${i}: иначе только 409, получили ${status}`);
                assert.equal(ins.status, 'fulfilled', `#${i}: при 409 вставка прошла`);
                assert.deepEqual(
                    after,
                    { ...before, messages: before.messages + 1 },
                    `#${i}: 409 → всё цело, гость enabled`,
                );
            }
        }
    });
});

async function waitForBlocked(): Promise<void> {
    for (let i = 0; i < 100; i++) {
        const row = await dbOne<{ c: number }>(
            `select count(*)::int c from pg_stat_activity
             where wait_event_type = 'Lock' and query like '%delete from wa_chats%' and query like $1`,
            [`%${RUN}%`],
        );
        if (Number(row?.c) > 0) return;
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('delete не встал на замок');
}
