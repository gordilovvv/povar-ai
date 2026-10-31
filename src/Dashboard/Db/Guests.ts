import type { PoolClient } from 'pg';
import format from 'pg-format';

export type GuestGender = 'male' | 'female';

export interface GuestListRow {
    id: string;
    wa_phone: string | null;
    first_name: string | null;
    last_name: string | null;
    instagram: string | null;
    gender: GuestGender | null;
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
) => {
    const result = await client.query<GuestListRow>(
        format(
            `select id, wa_phone, first_name, last_name, instagram, gender
            from guests
            where %L::text is null or id > %L
            order by id asc
            limit %L`,
            lastId,
            lastId,
            limit,
        ),
    );
    return result.rows;
};
