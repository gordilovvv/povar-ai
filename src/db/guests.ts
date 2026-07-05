import type { PoolClient } from 'pg';
import format from 'pg-format';

type GuestCameFrom = 'ad' | 'manual';
type GuestLang = 'ru' | 'en';

export interface GuestStorage {
    id: string;
    wa_phone: string | null;
    first_name: string | null;
    last_name: string | null;
    instagram_url: string | null;
    came_from: GuestCameFrom | null;
    came_at: string | null;
    lang: GuestLang | null;
}

export const selectGuestByPhone = async (client: PoolClient, waPhone: string) => {
    const result = await client.query<GuestStorage>(
        format('select * from guests where wa_phone = %L', waPhone),
    );
    return result.rows.length ? result.rows[0] : null;
};

export const insertGuest = async (client: PoolClient, guest: GuestStorage) => {
    await client.query(
        format(
            `insert into guests
                (id, wa_phone, first_name, last_name, instagram_url, came_from, came_at, lang)
            values
                (%L, %L, %L, %L, %L, %L, %L, %L)`,
            guest.id,
            guest.wa_phone,
            guest.first_name,
            guest.last_name,
            guest.instagram_url,
            guest.came_from,
            guest.came_at,
            guest.lang,
        ),
    );
};

export const updateGuestLang = async (client: PoolClient, id: string, lang: GuestLang) => {
    await client.query(format('update guests set lang = %L where id = %L', lang, id));
};

export const updateGuestProfile = async (
    client: PoolClient,
    id: string,
    patch: {
        first_name?: string | undefined;
        last_name?: string | undefined;
        instagram_url?: string | undefined;
    },
) => {
    const result = await client.query<GuestStorage>(
        format(
            `update guests set
                first_name = coalesce(%L, first_name),
                last_name = coalesce(%L, last_name),
                instagram_url = coalesce(%L, instagram_url)
            where id = %L
            returning *`,
            patch.first_name ?? null,
            patch.last_name ?? null,
            patch.instagram_url ?? null,
            id,
        ),
    );
    return result.rows.length ? result.rows[0] : null;
};
