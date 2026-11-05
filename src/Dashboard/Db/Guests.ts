import type { PoolClient } from 'pg';
import format from 'pg-format';
import type { GuestMarketing } from '#Db/Guests.js';

export type GuestGender = 'male' | 'female';

export interface GuestListRow {
    id: string;
    wa_phone: string | null;
    first_name: string | null;
    last_name: string | null;
    instagram: string | null;
    gender: GuestGender | null;
    marketing: GuestMarketing | null;
}

export interface GuestsStatisticRow {
    guests_count: number;
    male_count: number;
    female_count: number;
}

export const selectGuestsStatistic = async (client: PoolClient) => {
    const result = await client.query<GuestsStatisticRow>(
        `select
            count(*)::int as guests_count,
            (count(*) filter (where gender = 'male'))::int as male_count,
            (count(*) filter (where gender = 'female'))::int as female_count
        from guests`,
    );
    const [row] = result.rows;
    if (!row) {
        throw new Error('[dashboard] guests statistic: aggregate returned no row');
    }
    return row;
};

export const selectGuestsList = async (
    client: PoolClient,
    lastId: string | null,
    limit: number,
    marketing: GuestMarketing | null,
) => {
    const result = await client.query<GuestListRow>(
        format(
            `select id, wa_phone, first_name, last_name, instagram, gender, marketing
            from guests
            where (%L::text is null or id > %L)
              and (%L::text is null or marketing = %L)
            order by id asc
            limit %L`,
            lastId,
            lastId,
            marketing,
            marketing,
            limit,
        ),
    );
    return result.rows;
};

export const updateGuestMarketing = async (
    client: PoolClient,
    id: string,
    marketing: GuestMarketing,
) => {
    const result = await client.query<{ marketing: GuestMarketing }>(
        format(
            `update guests
                set marketing = case when marketing = 'blocked_by_user' then marketing else %L end
            where id = %L
            returning marketing`,
            marketing,
            id,
        ),
    );
    const [row] = result.rows;
    return row ? row.marketing : null;
};
