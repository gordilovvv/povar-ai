import type { PoolClient } from 'pg';
import format from 'pg-format';
import { toDateTime } from '#Lib/Fmt.js';

export interface WaMarketingSendStorage {
    party_id: string;
    wa_phone: string;
    sent_at: string | null;
}

export const selectWaMarketingSend = async (
    client: PoolClient,
    partyId: string,
    waPhone: string,
) => {
    const result = await client.query(
        format(
            'select * from wa_marketing_sends where party_id = %L and wa_phone = %L',
            partyId,
            waPhone,
        ),
    );

    return result.rows.length ? (result.rows[0] as WaMarketingSendStorage) : null;
};

export const selectWaMarketingSends = async (client: PoolClient, waPhone: string) => {
    const result = await client.query(
        format('select * from wa_marketing_sends where wa_phone = %L', waPhone),
    );

    return result.rows as WaMarketingSendStorage[];
};

export const insertWaMarketingSend = async (
    client: PoolClient,
    partyId: string,
    waPhone: string,
    sentAt: Date,
) => {
    await client.query(
        format(
            `insert into wa_marketing_sends (party_id, wa_phone, sent_at)
            values (%L, %L, %L)`,
            partyId,
            waPhone,
            toDateTime(sentAt),
        ),
    );
};
