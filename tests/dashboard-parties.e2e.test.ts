// Задача модуля (partiesGetListHandler + partyGetGuestlistListHandler):
//   вход  → GET /parties?limit&cursor ; GET /parties/:id/guestlist
//           заголовок authorization: Bearer <access JWT> (гейт withAuthorization)
//   выход → parties: { id, name, location, startsAt, guestCount }[], nextCursor
//           сорт: активная (идёт сейчас, ≤ ACTIVE_PARTY_WINDOW_HOURS после старта) →
//                 будущие (asc) → прошедшие (desc) → без времени (последними)
//           guestlist: { firstName, lastName, instagram }[] по joined_at asc
//   бюджет → сеть/БД жёстко не меряем (ориентир p95 ≤ 150ms), только measure()
//   негатив → нет/битый токен → 401; пустой id → 400 (в .attack);
//             несуществующий party в guestlist → 200 []

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
            await client.query(`insert into party (id, name, location) values ($1, $2, $3)`, [
                id,
                `Party ${party.key}`,
                `Loc ${party.key}`,
            ]);
            if (party.offset !== null) {
                await client.query(
                    `insert into party_time (party_id, party_start_at) values ($1, $2)`,
                    [id, toDateTime(new Date(NOW + party.offset))],
                );
            }
        }

        // Гости на активной вечеринке: joined_at по возрастанию → guest0 раньше guest1.
        const ongoingId = ID.get('ongoing') ?? '';
        for (let i = 0; i < 2; i++) {
            const guestId = ulid();
            await client.query(
                `insert into guests (id, wa_phone, first_name, last_name, instagram_url)
                 values ($1, $2, $3, $4, $5)`,
                [guestId, GUEST_PHONES[i], `First${i}`, `Last${i}`, `https://insta/${i}`],
            );
            await client.query(
                `insert into party_guestlist (party_id, guest_id, joined_at) values ($1, $2, $3)`,
                [ongoingId, guestId, toDateTime(new Date(NOW + i * 1000))],
            );
        }
    });
}

interface PartiesResponse {
    items: {
        id: string;
        name: string;
        location: string;
        startsAt: string | null;
        guestCount: number;
    }[];
    nextCursor: string | null;
}

type GuestlistResponse = {
    firstName: string | null;
    lastName: string | null;
    instagram: string | null;
}[];

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
        assert.equal(byId.get(ID.get('ongoing') ?? '')?.guestCount, 2, 'guestCount активной = 2');
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

        // Сверка guestCount напрямую с БД.
        const dbRow = await dbOne<{ n: string }>(
            `select count(*)::text as n from party_guestlist where party_id = $1`,
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

    it('guestlist: { firstName, lastName, instagram }[] по joined_at asc', async () => {
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

        assert.deepEqual(
            body,
            [
                { firstName: 'First0', lastName: 'Last0', instagram: 'https://insta/0' },
                { firstName: 'First1', lastName: 'Last1', instagram: 'https://insta/1' },
            ],
            'гости по joined_at asc, instagram из instagram_url',
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
