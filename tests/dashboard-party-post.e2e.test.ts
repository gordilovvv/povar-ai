// Задача модуля (partyPostHandler):
//   вход  → POST /party (Bearer JWT, гейт withAuthorization)
//           body { id, type, name, price ≥0, location, googleMapLink|null, reelsUrl|null, notes|null,
//                  time?: { startsAt, endsAt, freeEntryBefore?, guestlistAlertAt } }  ISO UTC
//   выход → { id }; upsert party (insert → на 23505 update, полная перезапись полей);
//           time задан → party_time ровно одна строка с новыми значениями; не задан → не трогаем;
//           marketing_message и party_tables не трогаем;
//           GET /parties/:id после POST отдаёт все поля тела + guestCount; повтор с теми же
//           полями и новым именем не меняет googleMapLink и time
//   бюджет → сеть/БД не меряем, только measure()
//   негатив → endsAt < startsAt → 400 без записи; параллельные POST одного id → 1 party, 1 party_time;
//             auth / кривое тело — в .attack

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { pool as dashboardPool } from '#Dashboard/Db/Pool.js';
import { dashboardFetch } from '#Dashboard/Router.js';
import {
    closePool,
    dbOne,
    dbQuery,
    measure,
    seedDashboardUser,
    signAuthToken,
    withClient,
} from './helpers/e2e.ts';

const DASH_PHONE = 'E2E_partypost_user';
const RUN = Date.now().toString(36);
const PARTY_ID = `e2e_pp_main_${RUN}`;
const RACE_ID = `e2e_pp_race_${RUN}`;
const BAD_ID = `e2e_pp_bad_${RUN}`;
const OWN_IDS = [PARTY_ID, RACE_ID, BAD_ID];

const TIME_V1 = {
    startsAt: '2026-12-01T18:00:00.000Z',
    endsAt: '2026-12-02T02:00:00.000Z',
    freeEntryBefore: '2026-12-01T20:00:00.000Z',
    guestlistAlertAt: '2026-12-01T14:00:00.000Z',
};
const TIME_V2 = {
    startsAt: '2026-12-05T19:00:00.000Z',
    endsAt: '2026-12-06T03:00:00.000Z',
    guestlistAlertAt: '2026-12-05T15:00:00.000Z',
};

const BODY_V1 = {
    id: PARTY_ID,
    type: 'owned',
    name: 'E2E Party',
    price: 150,
    location: 'Dubai Marina',
    googleMapLink: 'https://maps.google.com/?q=1',
    reelsUrl: 'https://instagram.com/reel/1',
    notes: 'e2e notes',
    time: TIME_V1,
};

interface PartyRow {
    type: string;
    name: string;
    price: string | null;
    location: string;
    google_map_link: string | null;
    reels_url: string | null;
    notes: string | null;
    marketing_message: unknown;
}

interface TimeRow {
    party_start_at: Date | null;
    party_end_at: Date | null;
    free_entry_before: Date | null;
    guestlist_alert_at: Date | null;
}

let token = '';

async function post(body: unknown): Promise<Response> {
    const { result } = await measure('POST /party', () =>
        dashboardFetch(
            new Request('http://dashboard/party', {
                method: 'POST',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                body: JSON.stringify(body),
            }),
        ),
    );
    return result;
}

async function getParty(id: string): Promise<Response> {
    const { result } = await measure('GET /parties/:id', () =>
        dashboardFetch(
            new Request(`http://dashboard/parties/${encodeURIComponent(id)}`, {
                headers: { authorization: `Bearer ${token}` },
            }),
        ),
    );
    return result;
}

const selectParty = (id: string) =>
    dbOne<PartyRow>(
        `select type, name, price, location, google_map_link, reels_url, notes, marketing_message
         from party where id = $1`,
        [id],
    );

const selectTimes = (id: string) =>
    dbQuery<TimeRow>(
        `select party_start_at, party_end_at, free_entry_before, guestlist_alert_at
         from party_time where party_id = $1`,
        [id],
    );

const iso = (value: Date | null) => (value === null ? null : value.toISOString());

async function cleanup(): Promise<void> {
    await withClient(async (client) => {
        await client.query(`delete from party_tables where party_id = any($1)`, [OWN_IDS]);
        await client.query(`delete from party_time where party_id = any($1)`, [OWN_IDS]);
        await client.query(`delete from party where id = any($1)`, [OWN_IDS]);
        await client.query(`delete from dashboard_users where phone_number = $1`, [DASH_PHONE]);
    });
}

describe('e2e: dashboard partyPost', () => {
    before(async () => {
        await cleanup();
        token = signAuthToken(await seedDashboardUser(DASH_PHONE));
    });

    after(async () => {
        await cleanup();
        await closePool();
        await dashboardPool.end();
    });

    it('e2e: partyPost — создание: party и одна party_time как в теле', async () => {
        const res = await post(BODY_V1);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { id: PARTY_ID });

        assert.deepEqual(await selectParty(PARTY_ID), {
            type: 'owned',
            name: 'E2E Party',
            price: '150',
            location: 'Dubai Marina',
            google_map_link: 'https://maps.google.com/?q=1',
            reels_url: 'https://instagram.com/reel/1',
            notes: 'e2e notes',
            marketing_message: null,
        });
        const times = await selectTimes(PARTY_ID);
        assert.equal(times.length, 1, 'ровно одна строка времени');
        assert.deepEqual(
            {
                startsAt: iso(times[0].party_start_at),
                endsAt: iso(times[0].party_end_at),
                freeEntryBefore: iso(times[0].free_entry_before),
                guestlistAlertAt: iso(times[0].guestlist_alert_at),
            },
            TIME_V1,
        );
    });

    it('e2e: partyPost → GET /parties/:id отдаёт все поля; повтор с новым именем не меняет карту и время', async () => {
        const { id: _id, ...fields } = BODY_V1;
        const expected = { id: PARTY_ID, ...fields, guestCount: 0, time: TIME_V1 };

        const first = await getParty(PARTY_ID);
        assert.equal(first.status, 200);
        assert.deepEqual(await first.json(), expected, 'GET после создания = тело POST');

        const res = await post({ ...BODY_V1, name: 'E2E Party renamed' });
        assert.equal(res.status, 200);

        const second = await getParty(PARTY_ID);
        assert.equal(second.status, 200);
        assert.deepEqual(
            await second.json(),
            { ...expected, name: 'E2E Party renamed' },
            'сменилось только имя: googleMapLink и time прежние',
        );
        assert.equal((await selectTimes(PARTY_ID)).length, 1, 'party_time по-прежнему одна');
    });

    it('e2e: partyPost — повтор: полная перезапись, время заменено, marketing/tables целы', async () => {
        const marketing = { image: 'e2e.jpg', message: 'e2e invite' };
        await withClient(async (client) => {
            await client.query(`update party set marketing_message = $1 where id = $2`, [
                marketing,
                PARTY_ID,
            ]);
            await client.query(`insert into party_tables (party_id, map) values ($1, 'e2e map')`, [
                PARTY_ID,
            ]);
        });

        const res = await post({
            ...BODY_V1,
            type: 'invited',
            name: 'E2E Party v2',
            price: 0,
            location: 'JBR',
            googleMapLink: null,
            reelsUrl: null,
            notes: null,
            time: TIME_V2,
        });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { id: PARTY_ID });

        assert.deepEqual(await selectParty(PARTY_ID), {
            type: 'invited',
            name: 'E2E Party v2',
            price: '0',
            location: 'JBR',
            google_map_link: null,
            reels_url: null,
            notes: null,
            marketing_message: marketing,
        });
        const times = await selectTimes(PARTY_ID);
        assert.equal(times.length, 1, 'старое время удалено, новое одно');
        assert.deepEqual(
            {
                startsAt: iso(times[0].party_start_at),
                endsAt: iso(times[0].party_end_at),
                freeEntryBefore: iso(times[0].free_entry_before),
                guestlistAlertAt: iso(times[0].guestlist_alert_at),
            },
            { ...TIME_V2, freeEntryBefore: null },
        );
        const tables = await dbQuery(`select map from party_tables where party_id = $1`, [
            PARTY_ID,
        ]);
        assert.deepEqual(tables, [{ map: 'e2e map' }], 'party_tables не тронута');
    });

    it('e2e: partyPost — без time: party обновлена, party_time не тронута', async () => {
        const { time: _time, ...withoutTime } = BODY_V1;
        const res = await post({ ...withoutTime, name: 'E2E Party v3' });
        assert.equal(res.status, 200);

        assert.equal((await selectParty(PARTY_ID))?.name, 'E2E Party v3');
        const times = await selectTimes(PARTY_ID);
        assert.equal(times.length, 1);
        assert.equal(iso(times[0].party_start_at), TIME_V2.startsAt, 'время от прошлого POST');
    });

    it('e2e: partyPost — endsAt < startsAt → 400, ничего не записано', async () => {
        const res = await post({
            ...BODY_V1,
            id: BAD_ID,
            time: { startsAt: TIME_V1.endsAt, endsAt: TIME_V1.startsAt },
        });
        assert.equal(res.status, 400);
        assert.equal(await selectParty(BAD_ID), null);
        assert.equal((await selectTimes(BAD_ID)).length, 0);
    });

    it('e2e: partyPost — 5 параллельных POST нового id → 1 party, 1 party_time', async () => {
        const statuses = await Promise.all(
            Array.from({ length: 5 }, (_, i) =>
                post({ ...BODY_V1, id: RACE_ID, name: `race ${i}` }).then((r) => r.status),
            ),
        );
        assert.deepEqual(statuses, [200, 200, 200, 200, 200]);
        const parties = await dbQuery(`select id from party where id = $1`, [RACE_ID]);
        assert.equal(parties.length, 1);
        assert.equal((await selectTimes(RACE_ID)).length, 1, 'гонка не задублировала время');
    });
});
