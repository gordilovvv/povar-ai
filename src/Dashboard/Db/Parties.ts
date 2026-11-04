import type { PoolClient } from 'pg';
import format from 'pg-format';
import { z } from 'zod';
import type { PartiesKeyset } from '#Dashboard/Lib/PaginationCursor.js';

export interface PartyRow {
    id: string;
    type: string;
    name: string;
    price: string | null;
    location: string;
    google_map_link: string | null;
    reels_url: string | null;
    notes: string | null;
    time_party_id: string | null;
    starts_at: string | null;
    ends_at: string | null;
    free_entry_before: string | null;
    guestlist_alert_at: string | null;
    guest_count: string;
}

export interface PartyListRow extends PartyRow {
    bucket: number;
}

export interface GuestlistRow {
    guest_id: string;
    phone: string;
    first_name: string | null;
    last_name: string | null;
    instagram: string | null;
    friends: string[] | null;
    joined_at: string | null;
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
                    party.google_map_link,
                    party.reels_url,
                    party.notes,
                    time.party_id as time_party_id,
                    time.party_start_at as starts_at,
                    time.party_end_at as ends_at,
                    time.free_entry_before,
                    time.guestlist_alert_at,
                    (select coalesce(sum(1 + coalesce(cardinality(guest.friends), 0)), 0)
                        from party_guestlist guest where guest.party_id = party.id) as guest_count
                from party
                left join lateral (
                    select party_id, party_start_at, party_end_at, free_entry_before, guestlist_alert_at
                    from party_time where party_id = party.id
                    order by party_start_at asc limit 1
                ) time on true
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
            select *
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

export const selectParty = async (client: PoolClient, partyId: string) => {
    const result = await client.query<PartyRow>(
        format(
            `select
                party.id,
                party.type,
                party.name,
                party.price,
                party.location,
                party.google_map_link,
                party.reels_url,
                party.notes,
                time.party_id as time_party_id,
                time.party_start_at as starts_at,
                time.party_end_at as ends_at,
                time.free_entry_before,
                time.guestlist_alert_at,
                (select coalesce(sum(1 + coalesce(cardinality(guest.friends), 0)), 0)
                    from party_guestlist guest where guest.party_id = party.id) as guest_count
            from party
            left join lateral (
                select party_id, party_start_at, party_end_at, free_entry_before, guestlist_alert_at
                from party_time where party_id = party.id
                order by party_start_at asc limit 1
            ) time on true
            where party.id = %L`,
            partyId,
        ),
    );
    return result.rows.length ? result.rows[0] : null;
};

export const selectPartyGuestlist = async (client: PoolClient, partyId: string) => {
    const result = await client.query<GuestlistRow>(
        format(
            `select guest.id as guest_id, guest.wa_phone as phone,
                guest.first_name, guest.last_name, guest.instagram,
                list.friends, list.joined_at
            from party_guestlist list
            join guests guest on guest.id = list.guest_id
            where list.party_id = %L
            order by list.joined_at asc nulls last, list.guest_id asc`,
            partyId,
        ),
    );
    return result.rows;
};

export const partyTypeSchema = z.enum(['owned', 'invited']);
export type PartyType = z.infer<typeof partyTypeSchema>;

export interface PartyStorage {
    id: string;
    type: PartyType;
    name: string;
    price: number;
    location: string;
    google_map_link: string | null;
    reels_url: string | null;
    notes: string | null;
}

export interface PartyTimeStorage {
    party_id: string;
    party_start_at: string;
    party_end_at: string;
    free_entry_before: string | null;
    guestlist_alert_at: string;
}

export const insertParty = async (client: PoolClient, party: PartyStorage) => {
    await client.query(
        format(
            `insert into party
                (id, type, name, price, location, google_map_link, reels_url, notes)
            values
                (%L, %L, %L, %L, %L, %L, %L, %L)`,
            party.id,
            party.type,
            party.name,
            party.price,
            party.location,
            party.google_map_link,
            party.reels_url,
            party.notes,
        ),
    );
};

export const updateParty = async (client: PoolClient, party: PartyStorage) => {
    await client.query(
        format(
            `update party
                set type = %L, name = %L, price = %L, location = %L,
                    google_map_link = %L, reels_url = %L, notes = %L
            where id = %L`,
            party.type,
            party.name,
            party.price,
            party.location,
            party.google_map_link,
            party.reels_url,
            party.notes,
            party.id,
        ),
    );
};

export const replacePartyTime = async (client: PoolClient, time: PartyTimeStorage) => {
    await client.query(
        format(
            `with removed as (delete from party_time where party_id = %1$L)
            insert into party_time
                (party_id, party_start_at, party_end_at, free_entry_before, guestlist_alert_at)
            values
                (%1$L, %2$L, %3$L, %4$L, %5$L)`,
            time.party_id,
            time.party_start_at,
            time.party_end_at,
            time.free_entry_before,
            time.guestlist_alert_at,
        ),
    );
};

export const deleteParty = async (client: PoolClient, id: string) => {
    const result = await client.query(
        format(
            `with
                removed_time as (delete from party_time where party_id = %1$L),
                removed_tables as (delete from party_tables where party_id = %1$L),
                removed_sends as (delete from wa_marketing_sends where party_id = %1$L)
            delete from party where id = %1$L`,
            id,
        ),
    );
    return result.rowCount;
};
