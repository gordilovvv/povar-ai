// Задача модуля (partiesGetListHandler + partyGetHandler + partyGetGuestlistListHandler):
//   вход  → GET /parties?limit&cursor ; GET /parties/:id ; GET /parties/:id/guestlist
//           заголовок authorization: Bearer <access JWT> (гейт withAuthorization)
//   выход → parties: { id, type, name, price, location, googleMapLink, reelsUrl, notes, startsAt,
//                      guestCount (гости + friends), time: { startsAt, endsAt, freeEntryBefore, guestlistAlertAt } | null }[], nextCursor
//           сорт: активная (идёт сейчас, ≤ ACTIVE_PARTY_WINDOW_HOURS после старта) →
//                 будущие (asc) → прошедшие (desc) → без времени (последними)
//           party: те же поля без startsAt; нет вечеринки → 404
//           guestlist: { guestId, phone, firstName, lastName, instagram, friends, joinedAt }[] по joined_at asc
//   бюджет → сеть/БД жёстко не меряем (ориентир p95 ≤ 150ms), только measure()
//   негатив → нет/битый токен → 401; пустой id → 400 (в .attack);
//             несуществующий party в guestlist → 200 []; в GET /parties/:id → 404

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ulid } from 'ulid';
import { pool as dashboardPool } from '#Dashboard/Db/Pool.js';
import { dashboardFetch } from '#Dashboard/Router.js';
import { toDateTime } from '#Lib/Fmt.js';
import {
    closePool,
    dbOne,
    measure,
    seedDashboardUser,
    signAuthToken,
    withClient,
} from './helpers/e2e.ts';

const DASH_PHONE = 'E2E_parties_user';
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const NOW = Date.now();

// id с префиксом E2E_pt_ — фильтруем свои строки поверх реальных dev-данных.
const PARTIES = [
    { key: 'ongoing', offset: -2 * HOUR_MS, guests: 2 }, // старт 2ч назад → активна (окно 6ч)
    { key: 'future1', offset: +1 * DAY_MS, guests: 0 },
    { key: 'future2', offset: +2 * DAY_MS, guests: 0 },
    { key: 'past1', offset: -10 * DAY_MS, guests: 0 },
    { key: 'past2', offset: -20 * DAY_MS, guests: 0 },
    { key: 'notime', offset: null as number | null, guests: 0 },
];
const ID = new Map(PARTIES.map((p) => [p.key, `E2E_pt_${p.key}_${ulid()}`]));
const OWN_IDS = [...ID.values()];
const EXPECTED_ORDER = ['ongoing', 'future1', 'future2', 'past1', 'past2', 'notime'].map(
    (k) => ID.get(k) ?? '',
);
const GUEST_PHONES = ['E2E_ptg_0', 'E2E_ptg_1'];
const GUEST_IDS = [ulid(), ulid()];
const END_OFFSET = 6 * HOUR_MS;
const ALERT_OFFSET = -3 * HOUR_MS;

async function cleanup(): Promise<void> {
    await withClient(async (client) => {
        await client.query(`delete from party_guestlist where party_id = any($1)`, [OWN_IDS]);
        await client.query(`delete from party_time where party_id = any($1)`, [OWN_IDS]);
        await client.query(`delete from party where id = any($1)`, [OWN_IDS]);
        await client.query(`delete from guests where wa_phone = any($1)`, [GUEST_PHONES]);
        await client.query(`delete from dashboard_users where phone_number = $1`, [DASH_PHONE]);
    });
}

async function seed(): Promise<void> {
    await withClient(async (client) => {
        for (const party of PARTIES) {
            const id = ID.get(party.key) ?? '';
            await client.query(
                `insert into party (id, type, name, price, location, google_map_link, reels_url, notes)
                 values ($1, 'owned', $2, $3, $4, $5, $6, $7)`,
                [
                    id,
                    `Party ${party.key}`,
                    party.key === 'ongoing' ? 1500 : null,
                    `Loc ${party.key}`,
                    party.key === 'ongoing' ? 'https://maps/ongoing' : null,
                    `https://reels/${party.key}`,
                    `note ${party.key}`,
                ],
            );
            if (party.offset !== null) {
                await client.query(
                    `insert into party_time (party_id, party_start_at, party_end_at, guestlist_alert_at)
                     values ($1, $2, $3, $4)`,
                    [
                        id,
                        toDateTime(new Date(NOW + party.offset)),
                        toDateTime(new Date(NOW + party.offset + END_OFFSET)),
                        toDateTime(new Date(NOW + party.offset + ALERT_OFFSET)),
                    ],
                );
            }
        }

        // Гости на активной вечеринке: joined_at по возрастанию → guest0 раньше guest1.
        // guest0 — с friends и table_offered_at; guest1 — без (проверяем null → [] и null-дату).
        const ongoingId = ID.get('ongoing') ?? '';
        const FRIENDS = [['Ann Smith', 'Bob Lee'], null];
        const OFFERED = [toDateTime(new Date(NOW)), null];
        for (let i = 0; i < 2; i++) {
            const guestId = GUEST_IDS[i];
            await client.query(
                `insert into guests (id, wa_phone, first_name, last_name, instagram)
                 values ($1, $2, $3, $4, $5)`,
                [guestId, GUEST_PHONES[i], `First${i}`, `Last${i}`, `https://insta/${i}`],
            );
            await client.query(
                `insert into party_guestlist (party_id, guest_id, joined_at, friends, table_offered_at)
                 values ($1, $2, $3, $4, $5)`,
                [ongoingId, guestId, toDateTime(new Date(NOW + i * 1000)), FRIENDS[i], OFFERED[i]],
            );
        }
    });
}

interface PartyTime {
    startsAt: string | null;
    endsAt: string | null;
    freeEntryBefore: string | null;
    guestlistAlertAt: string | null;
}

interface PartyItem {
    id: string;
    type: string;
    name: string;
    price: number | null;
    location: string;
    googleMapLink: string | null;
    reelsUrl: string | null;
    notes: string | null;
    guestCount: number;
    time: PartyTime | null;
}

interface PartiesResponse {
    items: (PartyItem & { startsAt: string | null })[];
    nextCursor: string | null;
}

type GuestlistResponse = {
    guestId: string;
    phone: string;
    firstName: string | null;
    lastName: string | null;
    instagram: string | null;
    friends: string[];
    joinedAt: string | null;
}[];

const isoSec = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString();
const ONGOING_TIME: PartyTime = {
    startsAt: isoSec(NOW - 2 * HOUR_MS),
    endsAt: isoSec(NOW - 2 * HOUR_MS + END_OFFSET),
    freeEntryBefore: null,
    guestlistAlertAt: isoSec(NOW - 2 * HOUR_MS + ALERT_OFFSET),
};

let token = '';

async function getParties(query: string): Promise<PartiesResponse> {
    const { result } = await measure(`GET /parties?${query}`, () =>
        dashboardFetch(
            new Request(`http://dashboard/parties?${query}`, {
                headers: { authorization: `Bearer ${token}` },
            }),
        ),
    );
    assert.equal(result.status, 200, 'happy-path /parties → 200');
    return (await result.json()) as PartiesResponse;
}

describe('e2e: dashboard partiesGetList + partyGetGuestlistList', () => {
    before(async () => {
        await cleanup();
        const userId = await seedDashboardUser(DASH_PHONE);
        token = signAuthToken(userId);
        await seed();
    });

    after(async () => {
        await cleanup();
        await closePool();
        await dashboardPool.end();
    });

    it('parties: сорт активная → будущие(asc) → прошедшие(desc) → без времени; guestCount', async () => {
        const res = await getParties('limit=100');
        const mine = res.items.filter((p) => OWN_IDS.includes(p.id));

        assert.deepEqual(
            mine.map((p) => p.id),
            EXPECTED_ORDER,
            'порядок бакетов и сортировка внутри',
        );

        const byId = new Map(mine.map((p) => [p.id, p]));
        assert.equal(
            byId.get(ID.get('ongoing') ?? '')?.guestCount,
            4,
            'guestCount активной = 2 гостя + 2 друга (friends null → 0)',
        );
        assert.equal(byId.get(ID.get('future1') ?? '')?.guestCount, 0, 'без гостей → 0');
        assert.equal(
            byId.get(ID.get('notime') ?? '')?.startsAt,
            null,
            'без времени → startsAt null',
        );
        assert.equal(
            byId.get(ID.get('ongoing') ?? '')?.location,
            'Loc ongoing',
            'location отдаётся as-is',
        );

        // Новые поля party.
        const ongoing = byId.get(ID.get('ongoing') ?? '');
        assert.equal(ongoing?.type, 'owned', 'type отдаётся');
        assert.equal(ongoing?.price, 1500, 'price → number');
        assert.equal(ongoing?.reelsUrl, 'https://reels/ongoing', 'reelsUrl отдаётся');
        assert.equal(ongoing?.notes, 'note ongoing', 'notes отдаётся');
        assert.equal(
            byId.get(ID.get('future1') ?? '')?.price,
            null,
            'price null → null (не 0/NaN)',
        );
        assert.equal(ongoing?.googleMapLink, 'https://maps/ongoing', 'googleMapLink отдаётся');
        assert.deepEqual(ongoing?.time, ONGOING_TIME, 'time: все 4 поля из party_time');
        assert.equal(byId.get(ID.get('notime') ?? '')?.time, null, 'без party_time → time null');

        // Сверка guestCount напрямую с БД.
        const dbRow = await dbOne<{ n: string }>(
            `select sum(1 + coalesce(cardinality(friends), 0))::text as n from party_guestlist where party_id = $1`,
            [ID.get('ongoing') ?? ''],
        );
        assert.equal(
            String(byId.get(ID.get('ongoing') ?? '')?.guestCount),
            dbRow?.n,
            'guestCount = факт БД',
        );

        // startsAt активной = party_start_at в ISO (toDateTime усекает до секунд).
        const startSec = Math.floor((NOW - 2 * HOUR_MS) / 1000) * 1000;
        assert.equal(
            byId.get(ID.get('ongoing') ?? '')?.startsAt,
            new Date(startSec).toISOString(),
            'startsAt = party_start_at в ISO UTC',
        );
    });

    it('parties: keyset-пагинация limit=2 — все мои в верном порядке, без дублей', async () => {
        const seen: string[] = [];
        const mineOrder: string[] = [];
        let cursor: string | null = null;

        for (let page = 0; page < 50; page++) {
            const query = cursor ? `limit=2&cursor=${encodeURIComponent(cursor)}` : 'limit=2';
            const res = await getParties(query);
            for (const item of res.items) {
                seen.push(item.id);
                if (OWN_IDS.includes(item.id)) {
                    mineOrder.push(item.id);
                }
            }
            cursor = res.nextCursor;
            if (cursor === null || mineOrder.length === EXPECTED_ORDER.length) {
                break;
            }
        }

        assert.equal(new Set(seen).size, seen.length, 'ни одна вечеринка не задублирована');
        assert.deepEqual(mineOrder, EXPECTED_ORDER, 'keyset выдаёт мои вечеринки в верном порядке');
    });

    it('party: GET /parties/:id отдаёт все поля и time; сверка с БД', async () => {
        const { result } = await measure('GET /parties/:id', () =>
            dashboardFetch(
                new Request(
                    `http://dashboard/parties/${encodeURIComponent(ID.get('ongoing') ?? '')}`,
                    {
                        headers: { authorization: `Bearer ${token}` },
                    },
                ),
            ),
        );
        assert.equal(result.status, 200);
        const body = (await result.json()) as PartyItem;
        assert.deepEqual(body, {
            id: ID.get('ongoing'),
            type: 'owned',
            name: 'Party ongoing',
            price: 1500,
            location: 'Loc ongoing',
            googleMapLink: 'https://maps/ongoing',
            reelsUrl: 'https://reels/ongoing',
            notes: 'note ongoing',
            guestCount: 4,
            time: ONGOING_TIME,
        });

        const dbRow = await dbOne<{ start: Date; n: string }>(
            `select t.party_start_at as start,
                (select sum(1 + coalesce(cardinality(g.friends), 0))::text from party_guestlist g where g.party_id = p.id) as n
             from party p join party_time t on t.party_id = p.id where p.id = $1`,
            [ID.get('ongoing') ?? ''],
        );
        assert.equal(body.time?.startsAt, dbRow?.start.toISOString(), 'time.startsAt = факт БД');
        assert.equal(String(body.guestCount), dbRow?.n, 'guestCount = факт БД');
    });

    it('party: без party_time → time null; несуществующий id → 404', async () => {
        const headers = { authorization: `Bearer ${token}` };
        const notime = await dashboardFetch(
            new Request(`http://dashboard/parties/${encodeURIComponent(ID.get('notime') ?? '')}`, {
                headers,
            }),
        );
        assert.equal(notime.status, 200);
        assert.equal(((await notime.json()) as PartyItem).time, null);

        const missing = await dashboardFetch(
            new Request('http://dashboard/parties/E2E_pt_missing', { headers }),
        );
        assert.equal(missing.status, 404);
    });

    it('guestlist: { guestId, phone, firstName, lastName, instagram, friends, joinedAt }[] по joined_at asc', async () => {
        const { result } = await measure('GET /parties/:id/guestlist', () =>
            dashboardFetch(
                new Request(
                    `http://dashboard/parties/${encodeURIComponent(ID.get('ongoing') ?? '')}/guestlist`,
                    {
                        headers: { authorization: `Bearer ${token}` },
                    },
                ),
            ),
        );
        assert.equal(result.status, 200);
        const body = (await result.json()) as GuestlistResponse;

        const joinedAt = (i: number) =>
            new Date(Math.floor((NOW + i * 1000) / 1000) * 1000).toISOString();
        assert.deepEqual(
            body,
            [
                {
                    guestId: GUEST_IDS[0],
                    phone: GUEST_PHONES[0],
                    firstName: 'First0',
                    lastName: 'Last0',
                    instagram: 'https://insta/0',
                    friends: ['Ann Smith', 'Bob Lee'],
                    joinedAt: joinedAt(0),
                },
                {
                    guestId: GUEST_IDS[1],
                    phone: GUEST_PHONES[1],
                    firstName: 'First1',
                    lastName: 'Last1',
                    instagram: 'https://insta/1',
                    friends: [],
                    joinedAt: joinedAt(1),
                },
            ],
            'гости по joined_at asc: guestId, phone, friends (null→[]), joinedAt',
        );
    });

    it('guestlist: несуществующий party → 200 []', async () => {
        const { result } = await measure('GET /parties/NOPE/guestlist', () =>
            dashboardFetch(
                new Request('http://dashboard/parties/E2E_pt_missing/guestlist', {
                    headers: { authorization: `Bearer ${token}` },
                }),
            ),
        );
        assert.equal(result.status, 200);
        assert.deepEqual((await result.json()) as GuestlistResponse, []);
    });

    it('guestlist: вечеринка без гостей → 200 []', async () => {
        const { result } = await measure('GET /parties/:id/guestlist (empty)', () =>
            dashboardFetch(
                new Request(
                    `http://dashboard/parties/${encodeURIComponent(ID.get('future1') ?? '')}/guestlist`,
                    {
                        headers: { authorization: `Bearer ${token}` },
                    },
                ),
            ),
        );
        assert.equal(result.status, 200);
        assert.deepEqual((await result.json()) as GuestlistResponse, []);
    });
});
