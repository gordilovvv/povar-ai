import type { IRequest, RequestHandler } from 'itty-router';
import { type GuestlistRow, selectPartyGuestlist } from '#Dashboard/Db/Parties.js';
import { pool } from '#Dashboard/Db/Pool.js';
import { badRequest, success } from '#Dashboard/Lib/Response.js';
import { safeParseString } from '#Lib/Fmt.js';

interface GuestlistItem {
    firstName: string | null;
    lastName: string | null;
    instagram: string | null;
}

export const partyGetGuestlistListHandler: RequestHandler<IRequest> = async (request) => {
    const partyId = safeParseString(request.params.id);
    if (partyId === null) {
        return badRequest();
    }

    const client = await pool.connect();
    let rows: GuestlistRow[];
    try {
        rows = await selectPartyGuestlist(client, partyId);
    } finally {
        client.release();
    }

    const items: GuestlistItem[] = [];
    for (const row of rows) {
        items.push({
            firstName: row.first_name,
            lastName: row.last_name,
            instagram: row.instagram,
        });
    }

    return success(items);
};
