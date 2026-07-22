import type { PoolClient } from 'pg';
import format from 'pg-format';
import type { PartiesKeyset } from '#Dashboard/Lib/PaginationCursor.js';

export interface PartyListRow {
    id: string;
    type: string;
    name: string;
    price: string | null;
    location: string;
    reels_url: string | null;
    notes: string | null;
    starts_at: string | null;
    guest_count: string;
    bucket: number;
}

export interface GuestlistRow {
    first_name: string | null;
    last_name: string | null;
    instagram: string | null;
    friends: string[] | null;
    joined_at: string | null;
    table_offered_at: string | null;
}

/**
 * Список вечеринок. Бакеты: активные/будущие (2) → прошедшие (1) → без времени (0).
 * Активна в окне ACTIVE_PARTY_WINDOW_HOURS после старта (env) — как в боте (src/Db/Party.ts).
 * Внутри активных/будущих — по возрастанию (идущая сейчас/ближайшая первой),
 * прошедших — по убыванию (свежая первой). Keyset по (bucket, starts_at, id).
 */
export const selectPartiesList = async (
    client: PoolClient,
    cursor: PartiesKeyset | null,
    limit: number,
    activeWindowHours: number,
) => {
    const result = await client.query<PartyListRow>(
        format(
            `with parties as (
                select
                    party.id,
                    party.type,
                    party.name,
                    party.price,
                    party.location,
                    party.reels_url,
                    party.notes,
                    (select min(time.party_start_at)
                        from party_time time where time.party_id = party.id) as starts_at,
                    (select count(*)
                        from party_guestlist guest where guest.party_id = party.id) as guest_count
                from party
            ),
            ranked as (
                select parties.*,
                    case
                        when parties.starts_at is null then 0
                        when parties.starts_at >= now() - make_interval(hours => %L::int) then 2
                        else 1
                    end as bucket
                from parties
            )
            select id, type, name, price, location, reels_url, notes, starts_at, guest_count, bucket
            from ranked
            where %L::int is null
                or bucket < %L::int
                or (bucket = %L::int and (
                    (bucket = 2 and (starts_at > %L::timestamptz
                        or (starts_at = %L::timestamptz and id < %L)))
                    or (bucket = 1 and (starts_at < %L::timestamptz
                        or (starts_at = %L::timestamptz and id < %L)))
                    or (bucket = 0 and id < %L)
                ))
            order by bucket desc,
                case when bucket = 2 then starts_at end asc nulls last,
                case when bucket = 1 then starts_at end desc nulls last,
                id desc
            limit %L`,
            activeWindowHours,
            cursor?.bucket ?? null,
            cursor?.bucket ?? null,
            cursor?.bucket ?? null,
            cursor?.startsAt ?? null,
            cursor?.startsAt ?? null,
            cursor?.id ?? null,
            cursor?.startsAt ?? null,
            cursor?.startsAt ?? null,
            cursor?.id ?? null,
            cursor?.id ?? null,
            limit,
        ),
    );
    return result.rows;
};

export const selectPartyGuestlist = async (client: PoolClient, partyId: string) => {
    const result = await client.query<GuestlistRow>(
        format(
            `select guest.first_name, guest.last_name, guest.instagram,
                list.friends, list.joined_at, list.table_offered_at
            from party_guestlist list
            join guests guest on guest.id = list.guest_id
            where list.party_id = %L
            order by list.joined_at asc nulls last, list.guest_id asc`,
            partyId,
        ),
    );
    return result.rows;
};
