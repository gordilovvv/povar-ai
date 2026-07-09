import type { PoolClient } from 'pg';
import format from 'pg-format';

export interface PartyStorage {
    id: string;
    name: string;
    location: string;
    google_map_link: string | null;
    price: string | null;
    reels_url: string | null;
    notes: string | null;
}

export interface PartyTablesStorage {
    party_id: string;
    prices: unknown;
    map: string | null;
}

export interface PartyAdStorage {
    party_id: string;
    source_ad_id: string;
}

export interface PartyTimeStorage {
    party_id: string;
    party_start_at: string;
    free_entry_before: string | null;
}

export const selectActivePartyTimes = async (client: PoolClient) => {
    const result = await client.query<PartyTimeStorage>(
        `select party_time.*
        from party_time
        where party_time.party_start_at >= now() - interval '6 hours'
        order by party_time.party_start_at`,
    );
    return result.rows;
};

export const selectActiveParties = async (client: PoolClient) => {
    const result = await client.query<PartyStorage>(
        `select distinct party.*
        from party
        join party_time on party_time.party_id = party.id
        where party_time.party_start_at >= now() - interval '6 hours'`,
    );
    return result.rows;
};

export const selectPartyTables = async (client: PoolClient, partyId: string) => {
    const result = await client.query<PartyTablesStorage>(
        format(`select * from party_tables where party_id = %L`, partyId),
    );
    return result.rows.length ? result.rows[0] : null;
};

export const selectPartyByAd = async (client: PoolClient, sourceAdId: string) => {
    const result = await client.query<PartyStorage>(
        format(
            `select party.*
            from party
            join party_ads on party_ads.party_id = party.id
            where party_ads.source_ad_id = %L`,
            sourceAdId,
        ),
    );
    return result.rows.length ? result.rows[0] : null;
};
