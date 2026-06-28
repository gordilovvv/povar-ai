import type { PoolClient } from 'pg';
import format from 'pg-format';

export interface PartyStorage {
    id: string;
    name: string;
    location: string;
    google_map_link: string | null;
    price: string | null;
}

export interface PartyAdStorage {
    party_id: string;
    source_ad_id: string;
}

export const selectActiveParties = async (client: PoolClient) => {
    const result = await client.query<PartyStorage>(
        `select distinct party.*
        from party
        join party_time on party_time.party_id = party.id
        where party_time.party_start_at >= now() - interval '6 hours'`,
    );
    return result.rows;
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
