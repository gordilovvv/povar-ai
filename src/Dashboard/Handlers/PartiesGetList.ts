import type { IRequest, RequestHandler } from 'itty-router';
import { type PartyListRow, selectPartiesList } from '#Dashboard/Db/Parties.js';
import { pool } from '#Dashboard/Db/Pool.js';
import { env } from '#Dashboard/environment.js';
import { PaginationCursor, type PartiesKeyset } from '#Dashboard/Lib/PaginationCursor.js';
import { badRequest, success } from '#Dashboard/Lib/Response.js';
import { fromDateTime, minMax, safeParseInt, safeParseString } from '#Lib/Fmt.js';

interface PartyListItem {
    id: string;
    type: string;
    name: string;
    price: number | null;
    location: string;
    googleMapLink: string | null;
    reelsUrl: string | null;
    notes: string | null;
    startsAt: string | null;
    guestCount: number;
    time: PartyTime | null;
}

interface PartyTime {
    startsAt: string | null;
    endsAt: string | null;
    freeEntryBefore: string | null;
    guestlistAlertAt: string | null;
}

export const partiesGetListHandler: RequestHandler<IRequest> = async (request) => {
    const limit = minMax(safeParseInt(request.query.limit, 30), 1, 100);

    const rawCursor = safeParseString(request.query.cursor);
    let cursor: PartiesKeyset | null = null;
    if (rawCursor !== null) {
        cursor = PaginationCursor.decodeParties(rawCursor);
        if (cursor === null) {
            return badRequest();
        }
    }

    const activeWindowHours = Number(env.ACTIVE_PARTY_WINDOW_HOURS);

    const client = await pool.connect();
    let rows: PartyListRow[];
    try {
        rows = await selectPartiesList(client, cursor, limit, activeWindowHours);
    } finally {
        client.release();
    }

    const items: PartyListItem[] = [];
    for (const row of rows) {
        items.push({
            id: row.id,
            type: row.type,
            name: row.name,
            price: row.price === null ? null : Number(row.price),
            location: row.location,
            googleMapLink: row.google_map_link,
            reelsUrl: row.reels_url,
            notes: row.notes,
            startsAt: fromDateTime(row.starts_at),
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
    }

    const tail = rows.length === limit ? rows[rows.length - 1] : null;
    const nextCursor = tail
        ? PaginationCursor.encodeParties({
              bucket: tail.bucket,
              startsAt: fromDateTime(tail.starts_at),
              id: tail.id,
          })
        : null;

    return success({ items, nextCursor });
};
