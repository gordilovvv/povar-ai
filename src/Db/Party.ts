import type { PoolClient } from 'pg';
import format from 'pg-format';
import { z } from 'zod';
import { env } from '#environment.js';

export const partyTypeSchema = z.enum(['owned', 'invited']);

type PartyType = z.infer<typeof partyTypeSchema>;

export const marketingMessageSchema = z.object({
    image: z.string().startsWith('s3://'),
    message: z.string().min(1),
});

export type MarketingMessage = z.infer<typeof marketingMessageSchema>;

export interface PartyStorage {
    id: string;
    name: string;
    location: string;
    google_map_link: string | null;
    price: string | null;
    reels_url: string | null;
    notes: string | null;
    marketing_message: unknown;
    type: PartyType;
}

export interface PartyTablesStorage {
    party_id: string;
    prices: unknown;
    map: string | null;
}

export interface PartyTimeStorage {
    party_id: string;
    party_start_at: string;
    free_entry_before: string | null;
}

export interface PastPartyStorage {
    id: string;
    name: string;
    party_start_at: string;
}

export interface PartyWithTimeStorage extends PartyStorage {
    party_start_at: string;
    free_entry_before: string | null;
}

export const selectActivePartiesWithTimes = async (client: PoolClient) => {
    const result = await client.query<PartyWithTimeStorage>(
        format(
            `select party.*, party_time.party_start_at, party_time.free_entry_before
            from party
            join party_time on party_time.party_id = party.id
            where party_time.party_start_at >= now() - make_interval(hours => %L::int)
              and party_time.party_start_at < (date_trunc('week', now() at time zone 'Asia/Dubai') + interval '7 days') at time zone 'Asia/Dubai'
            order by party.id, party_time.party_start_at`,
            env.PARTY_ACTIVE_HOURS,
        ),
    );
    return result.rows;
};

export const selectPastPartiesByGuest = async (client: PoolClient, guestId: string) => {
    const result = await client.query<PastPartyStorage>(
        format(
            `select party.id, party.name, max(party_time.party_start_at) as party_start_at
            from party_guestlist
            join party on party.id = party_guestlist.party_id
            join party_time on party_time.party_id = party.id
            where party_guestlist.guest_id = %L
            group by party.id, party.name
            having max(party_time.party_start_at) < now() - make_interval(hours => %L::int)
            order by 3 desc`,
            guestId,
            env.PARTY_ACTIVE_HOURS,
        ),
    );
    return result.rows;
};

export const selectPartyTables = async (client: PoolClient, partyId: string) => {
    const result = await client.query<PartyTablesStorage>(
        format(`select * from party_tables where party_id = %L`, partyId),
    );
    return result.rows.length ? result.rows[0] : null;
};
