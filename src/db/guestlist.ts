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
