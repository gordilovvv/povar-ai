// Задача модуля (guestPostMarketingHandler):
//   вход  → POST /guests/:id/marketing  body { marketing: 'enabled' | 'disabled' } (Bearer JWT, гейт withAuthorization)
//   выход → 200 { id, marketing }; guests.marketing = body.marketing; идемпотентно (повтор с тем же → 200)
//   бюджет → сеть/БД не меряем, только measure()
//   негатив → гость blocked_by_user → 409, статус не меняется; гостя нет → 404;
//             body без marketing / blocked_by_user / не JSON → 400

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ulid } from 'ulid';
import { pool as dashboardPool } from '#Dashboard/Db/Pool.js';
import { dashboardFetch } from '#Dashboard/Router.js';
import {
    closePool,
    dbOne,
    measure,
    seedDashboardUser,
    signAuthToken,
    withClient,
} from './helpers/e2e.ts';

const DASH_PHONE = 'E2E_guestmarketing_user';
const RUN = Date.now().toString(36);
const GUESTS = {
    enabled: { id: ulid(), phone: `e2e_gm_enabled_${RUN}`, marketing: 'enabled' },
    blocked: { id: ulid(), phone: `e2e_gm_blocked_${RUN}`, marketing: 'blocked_by_user' },
    noPhone: { id: ulid(), phone: null, marketing: 'disabled' },
} as const;
const GUEST_IDS = Object.values(GUESTS).map((g) => g.id);

let token = '';

async function postMarketing(id: string, body: unknown, raw = false): Promise<Response> {
    const { result } = await measure(`POST /guests/${id}/marketing`, () =>
        dashboardFetch(
            new Request(`http://dashboard/guests/${id}/marketing`, {
                method: 'POST',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                body: raw ? String(body) : JSON.stringify(body),
            }),
        ),
    );
    return result;
}

async function dbMarketing(id: string) {
    const row = await dbOne<{ marketing: string }>(`select marketing from guests where id = $1`, [
        id,
    ]);
    return row?.marketing ?? null;
}

async function cleanup(): Promise<void> {
    await withClient(async (client) => {
        await client.query(`delete from guests where id = any($1)`, [GUEST_IDS]);
        await client.query(`delete from dashboard_users where phone_number = $1`, [DASH_PHONE]);
    });
}

describe('e2e: dashboard guest marketing', () => {
    before(async () => {
        await cleanup();
        const userId = await seedDashboardUser(DASH_PHONE);
        token = signAuthToken(userId);
        await withClient(async (client) => {
            for (const g of Object.values(GUESTS)) {
                await client.query(
                    `insert into guests (id, wa_phone, first_name, marketing) values ($1, $2, 'E2E', $3)`,
                    [g.id, g.phone, g.marketing],
                );
            }
        });
    });

    after(async () => {
        await cleanup();
        await closePool();
        await dashboardPool.end();
    });

    it('e2e: guest marketing — enabled → disabled → enabled, идемпотентный повтор, факт в БД', async () => {
        const { id } = GUESTS.enabled;

        let res = await postMarketing(id, { marketing: 'disabled' });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { id, marketing: 'disabled' });
        assert.equal(await dbMarketing(id), 'disabled');

        res = await postMarketing(id, { marketing: 'disabled' });
        assert.equal(res.status, 200, 'повтор с тем же значением → 200');
        assert.equal(await dbMarketing(id), 'disabled');

        res = await postMarketing(id, { marketing: 'enabled' });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { id, marketing: 'enabled' });
        assert.equal(await dbMarketing(id), 'enabled');
    });

    it('e2e: guest marketing — гость без номера управляется по id', async () => {
        const { id } = GUESTS.noPhone;
        const res = await postMarketing(id, { marketing: 'enabled' });
        assert.equal(res.status, 200);
        assert.equal(await dbMarketing(id), 'enabled');
    });

    it('e2e: guest marketing — blocked_by_user → 409, статус не меняется', async () => {
        const { id } = GUESTS.blocked;
        assert.equal((await postMarketing(id, { marketing: 'enabled' })).status, 409);
        assert.equal((await postMarketing(id, { marketing: 'disabled' })).status, 409);
        assert.equal(await dbMarketing(id), 'blocked_by_user');
    });

    it('e2e: guest marketing — кривой body → 400, статус не меняется', async () => {
        const { id } = GUESTS.enabled;
        assert.equal((await postMarketing(id, { marketing: 'blocked_by_user' })).status, 400);
        assert.equal((await postMarketing(id, { marketing: true })).status, 400);
        assert.equal((await postMarketing(id, {})).status, 400);
        assert.equal((await postMarketing(id, '{not json', true)).status, 400);
        assert.equal(await dbMarketing(id), 'enabled');
    });

    it('e2e: guest marketing — несуществующий гость → 404', async () => {
        const res = await postMarketing(ulid(), { marketing: 'disabled' });
        assert.equal(res.status, 404);
    });
});
