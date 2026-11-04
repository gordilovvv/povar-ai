// Задача модуля (partyPostDeleteHandler):
//   вход  → POST /party/:id/delete (Bearer JWT, гейт withAuthorization)
//   выход → 200 { id }; party, party_time, party_tables, wa_marketing_sends по id удалены
//   бюджет → сеть/БД не меряем, только measure()
//   негатив → гости в party_guestlist → 409, ничего не удалено; id нет → 404
//   бэк смотрит на прод: сеем минимум строк, всё под e2e_pd_* и чистим

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { pool as dashboardPool } from '#Dashboard/Db/Pool.js';
import { dashboardFetch } from '#Dashboard/Router.js';
import {
    closePool,
    dbQuery,
    measure,
    seedDashboardUser,
    signAuthToken,
    withClient,
} from './helpers/e2e.ts';

const DASH_PHONE = 'E2E_partydelete_user';
const RUN = Date.now().toString(36);
const PARTY_ID = `e2e_pd_main_${RUN}`;
const GUESTS_PARTY_ID = `e2e_pd_guests_${RUN}`;
const MISSING_ID = `e2e_pd_missing_${RUN}`;
const GUEST_ID = `e2e_pd_guest_${RUN}`;
const WA_PHONE = `e2e_pd_phone_${RUN}`;
const OWN_IDS = [PARTY_ID, GUESTS_PARTY_ID];

let token = '';

async function postDelete(id: string): Promise<Response> {
    const { result } = await measure(`POST /party/${id}/delete`, () =>
        dashboardFetch(
            new Request(`http://dashboard/party/${id}/delete`, {
                method: 'POST',
                headers: { authorization: `Bearer ${token}` },
            }),
        ),
    );
    return result;
}

async function countRows(id: string) {
    const [row] = await dbQuery<Record<string, number>>(
        `select
            (select count(*)::int from party where id = $1) as party,
            (select count(*)::int from party_time where party_id = $1) as time,
            (select count(*)::int from party_tables where party_id = $1) as tables,
            (select count(*)::int from wa_marketing_sends where party_id = $1) as sends,
            (select count(*)::int from party_guestlist where party_id = $1) as guestlist`,
        [id],
    );
    return row;
}

async function seedParty(id: string): Promise<void> {
    await withClient(async (client) => {
        await client.query(
            `insert into party (id, type, name, price, location) values ($1, 'owned', 'E2E delete', 0, 'E2E')`,
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
    });
}

async function cleanup(): Promise<void> {
    await withClient(async (client) => {
        await client.query(`delete from party_guestlist where party_id = any($1)`, [OWN_IDS]);
        await client.query(`delete from guests where id = $1`, [GUEST_ID]);
        await client.query(`delete from wa_marketing_sends where party_id = any($1)`, [OWN_IDS]);
        await client.query(`delete from party_tables where party_id = any($1)`, [OWN_IDS]);
        await client.query(`delete from party_time where party_id = any($1)`, [OWN_IDS]);
        await client.query(`delete from party where id = any($1)`, [OWN_IDS]);
        await client.query(`delete from dashboard_users where phone_number = $1`, [DASH_PHONE]);
    });
}

describe('e2e: dashboard partyPostDelete', () => {
    before(async () => {
        await cleanup();
        token = signAuthToken(await seedDashboardUser(DASH_PHONE));
        await seedParty(PARTY_ID);
        await seedParty(GUESTS_PARTY_ID);
        await withClient(async (client) => {
            await client.query(`insert into guests (id, first_name) values ($1, 'E2E')`, [
                GUEST_ID,
            ]);
            await client.query(
                `insert into party_guestlist (party_id, guest_id, joined_at) values ($1, $2, now())`,
                [GUESTS_PARTY_ID, GUEST_ID],
            );
        });
    });

    after(async () => {
        await cleanup();
        await closePool();
        await dashboardPool.end();
    });

    it('e2e: partyPostDelete — без гостей: 200 { id }, удалены party и все зависимые', async () => {
        const res = await postDelete(PARTY_ID);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { id: PARTY_ID });
        assert.deepEqual(await countRows(PARTY_ID), {
            party: 0,
            time: 0,
            tables: 0,
            sends: 0,
            guestlist: 0,
        });

        const again = await postDelete(PARTY_ID);
        assert.equal(again.status, 404, 'повтор — вечеринки уже нет');
    });

    it('e2e: partyPostDelete — есть гости: 409, ничего не удалено', async () => {
        const res = await postDelete(GUESTS_PARTY_ID);
        assert.equal(res.status, 409);
        assert.deepEqual(await countRows(GUESTS_PARTY_ID), {
            party: 1,
            time: 1,
            tables: 1,
            sends: 1,
            guestlist: 1,
        });
    });

    it('e2e: partyPostDelete — несуществующий id: 404', async () => {
        const res = await postDelete(MISSING_ID);
        assert.equal(res.status, 404);
    });
});
