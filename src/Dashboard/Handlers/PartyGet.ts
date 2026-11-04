import type { IRequest, RequestHandler } from 'itty-router';
import { selectParty } from '#Dashboard/Db/Parties.js';
import { pool } from '#Dashboard/Db/Pool.js';
import { badRequest, notFound, success } from '#Dashboard/Lib/Response.js';
import { fromDateTime, safeParseString } from '#Lib/Fmt.js';

export const partyGetHandler: RequestHandler<IRequest> = async (request) => {
    const partyId = safeParseString(request.params.id);
    if (partyId === null) {
        return badRequest();
    }

    const client = await pool.connect();
    let row: Awaited<ReturnType<typeof selectParty>>;
    try {
        row = await selectParty(client, partyId);
    } finally {
        client.release();
    }
    if (!row) {
        return notFound();
    }

    return success({
        id: row.id,
        type: row.type,
        name: row.name,
        price: row.price === null ? null : Number(row.price),
        location: row.location,
        googleMapLink: row.google_map_link,
        reelsUrl: row.reels_url,
        notes: row.notes,
        guestCount: Number(row.guest_count),
        time:
            row.time_party_id === null
                ? null
                : {
                      startsAt: fromDateTime(row.starts_at),
                      endsAt: fromDateTime(row.ends_at),
                      freeEntryBefore: fromDateTime(row.free_entry_before),
                      guestlistAlertAt: fromDateTime(row.guestlist_alert_at),
                  },
    });
};
