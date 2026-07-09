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
}

export const selectGuestlistByGuest = async (client: PoolClient, guestId: string) => {
    const result = await client.query<PartyGuestlistStorage>(
        format('select * from party_guestlist where guest_id = %L', guestId),
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

export const updateGuestlistBooking = async (
    client: PoolClient,
    partyId: string,
    guestId: string,
    patch: { table?: string | undefined; booked_table?: boolean | undefined },
) => {
    const result = await client.query<PartyGuestlistStorage>(
        format(
            `update party_guestlist set
                "table" = coalesce(%L, "table"),
                booked_table = coalesce(%L, booked_table)
            where party_id = %L and guest_id = %L
            returning *`,
            patch.table ?? null,
            patch.booked_table ?? null,
            partyId,
            guestId,
        ),
    );
    return result.rows[0] ?? null;
};
