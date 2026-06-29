import type { PoolClient } from 'pg';
import format from 'pg-format';

type GuestCameFrom = 'ad' | 'manual';

export interface GuestStorage {
    id: string;
    wa_phone: string | null;
    first_name: string | null;
    last_name: string | null;
    instagram_url: string | null;
    came_from: GuestCameFrom | null;
    came_at: string | null;
}

export const selectGuestByPhone = async (client: PoolClient, waPhone: string) => {
    const result = await client.query<GuestStorage>(
        format('select * from guests where wa_phone = %L', waPhone),
    );
    return result.rows.length ? result.rows[0] : null;
};

export const insertGuest = async (
    client: PoolClient,
    guest: GuestStorage,
): Promise<GuestStorage> => {
    const result = await client.query<GuestStorage>(
        format(
            `insert into guests
                (id, wa_phone, first_name, last_name, instagram_url, came_from, came_at)
            values
                (%L, %L, %L, %L, %L, %L, %L)
            returning *`,
            guest.id,
            guest.wa_phone,
            guest.first_name,
            guest.last_name,
            guest.instagram_url,
            guest.came_from,
            guest.came_at,
        ),
    );
    const row = result.rows[0];
    if (!row) {
        throw new Error('insertGuest returned no row');
    }
    return row;
};
