import type { IRequest, RequestHandler } from 'itty-router';
import { type GuestGender, type GuestListRow, selectGuestsList } from '#Dashboard/Db/Guests.js';
import { pool } from '#Dashboard/Db/Pool.js';
import { success } from '#Dashboard/Lib/Response.js';
import { minMax, safeParseInt, safeParseString } from '#Lib/Fmt.js';

interface GuestListItem {
    id: string;
    phone: string | null;
    firstName: string | null;
    lastName: string | null;
    instagram: string | null;
    gender: GuestGender | null;
}

export const guestsGetListHandler: RequestHandler<IRequest> = async (request) => {
    const limit = minMax(safeParseInt(request.query.limit, 30), 1, 100);
    const lastId = safeParseString(request.query.lastId);

    const client = await pool.connect();
    let rows: GuestListRow[];
    try {
        rows = await selectGuestsList(client, lastId, limit);
    } finally {
        client.release();
    }

    const items: GuestListItem[] = [];
    for (const row of rows) {
        items.push({
            id: row.id,
            phone: row.wa_phone,
            firstName: row.first_name,
            lastName: row.last_name,
            instagram: row.instagram,
            gender: row.gender,
        });
    }

    return success(items);
};
