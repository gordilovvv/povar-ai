import type { PoolClient } from 'pg';
import format from 'pg-format';

export interface PartyGuestlistStorage {
    party_id: string;
    guest_id: string;
    table: string | null;
    visited_party: boolean | null;
    booked_table: boolean | null;
    booked_table_paid: boolean | null;
    joined_at: string | null;
    friends: string[] | null;
    table_offered_at: string | null;
    telegram_alert_at: string | null;
}

export const selectGuestlistByGuest = async (client: PoolClient, guestId: string) => {
    const result = await client.query<PartyGuestlistStorage>(
        format(
            'select * from party_guestlist where guest_id = %L order by joined_at, party_id',
            guestId,
        ),
    );
    return result.rows;
};

export const selectGuestlist = async (client: PoolClient, partyId: string) => {
    const result = await client.query<PartyGuestlistStorage>(
        format('select * from party_guestlist where party_id = %L', partyId),
    );
    return result.rows;
};

export const selectGuestlistEntry = async (
    client: PoolClient,
    partyId: string,
    guestId: string,
) => {
    const result = await client.query<PartyGuestlistStorage>(
        format(
            'select * from party_guestlist where party_id = %L and guest_id = %L',
            partyId,
            guestId,
        ),
    );
    return result.rows[0] ?? null;
};

export const insertGuestlistEntry = async (
    client: PoolClient,
    partyId: string,
    guestId: string,
    joinedAt: string,
) => {
    await client.query(
        format(
            `insert into party_guestlist
                (party_id, guest_id, joined_at)
            values
                (%L, %L, %L)`,
            partyId,
            guestId,
            joinedAt,
        ),
    );
};

export const updateGuestlistFriends = async (
    client: PoolClient,
    partyId: string,
    guestId: string,
    friends: string[],
) => {
    const result = await client.query<PartyGuestlistStorage>(
        friends.length
            ? format(
                  `update party_guestlist set friends = array[%L]::text[]
                  where party_id = %L and guest_id = %L
                  returning *`,
                  friends,
                  partyId,
                  guestId,
              )
            : format(
                  `update party_guestlist set friends = '{}'::text[]
                  where party_id = %L and guest_id = %L
                  returning *`,
                  partyId,
                  guestId,
              ),
    );
    return result.rows.length ? result.rows[0] : null;
};

export const updateGuestlistTableOffered = async (
    client: PoolClient,
    partyId: string,
    guestId: string,
    offeredAt: string,
) => {
    await client.query(
        format(
            `update party_guestlist set table_offered_at = coalesce(table_offered_at, %L)
            where party_id = %L and guest_id = %L`,
            offeredAt,
            partyId,
            guestId,
        ),
    );
};

/**
 * Захват ответа про стол: сам себе замок — берёт строку только пока ответа не было.
 * Ноль строк = на вопрос уже ответили, повтор ничего не делает.
 */
export const updateGuestlistTableAnswer = async (
    client: PoolClient,
    partyId: string,
    guestId: string,
    bookedTable: boolean,
    offeredAt: string,
) => {
    const result = await client.query<PartyGuestlistStorage>(
        format(
            `update party_guestlist set
                booked_table = %L,
                table_offered_at = coalesce(table_offered_at, %L)
            where party_id = %L and guest_id = %L and booked_table is null
            returning *`,
            bookedTable,
            offeredAt,
            partyId,
            guestId,
        ),
    );
    return result.rows.length ? result.rows[0] : null;
};
