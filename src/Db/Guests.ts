import type { PoolClient } from 'pg';
import format from 'pg-format';

type GuestCameFrom = 'ad' | 'manual' | 'party_invite';
type GuestLang = 'ru' | 'en';

export interface GuestStorage {
    id: string;
    wa_phone: string | null;
    first_name: string | null;
    last_name: string | null;
    instagram: string | null;
    came_from: GuestCameFrom | null;
    came_at: string | null;
    lang: GuestLang | null;
    instagram_asked_at: string | null;
    marketing_enable: boolean;
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
                (id, wa_phone, first_name, last_name, instagram, came_from, came_at, lang, marketing_enable)
            values
                (%L, %L, %L, %L, %L, %L, %L, %L, %L)`,
            guest.id,
            guest.wa_phone,
            guest.first_name,
            guest.last_name,
            guest.instagram,
            guest.came_from,
            guest.came_at,
            guest.lang,
            guest.marketing_enable,
        ),
    );
};

export const updateGuestMarketingEnableOff = async (client: PoolClient, waPhone: string) => {
    const result = await client.query<GuestStorage>(
        format(
            'update guests set marketing_enable = false where wa_phone = %L and marketing_enable = true returning *',
            waPhone,
        ),
    );

    return result.rowCount === 1;
};

export const updateGuestLang = async (client: PoolClient, id: string, lang: GuestLang) => {
    const result = await client.query<GuestStorage>(
        format('update guests set lang = %L where id = %L and lang is null returning *', lang, id),
    );
    return result.rows.length ? result.rows[0] : null;
};

export const updateGuestProfile = async (
    client: PoolClient,
    id: string,
    patch: {
        first_name?: string | undefined;
        last_name?: string | undefined;
        instagram?: string | undefined;
        instagram_asked_at?: string | undefined;
    },
) => {
    const result = await client.query<GuestStorage>(
        format(
            `update guests set
                first_name = coalesce(%L, first_name),
                last_name = coalesce(%L, last_name),
                instagram = coalesce(%L, instagram),
                instagram_asked_at = coalesce(%L, instagram_asked_at)
            where id = %L
            returning *`,
            patch.first_name ?? null,
            patch.last_name ?? null,
            patch.instagram ?? null,
            patch.instagram_asked_at ?? null,
            id,
        ),
    );
    return result.rows.length ? result.rows[0] : null;
};
