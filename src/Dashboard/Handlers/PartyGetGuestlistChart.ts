import type { IRequest, RequestHandler } from 'itty-router';
import format from 'pg-format';
import { pool } from '#Dashboard/Db/Pool.js';
import { badRequest, success } from '#Dashboard/Lib/Response.js';
import { safeParseString } from '#Lib/Fmt.js';

interface GuestlistChartRow {
    date: string;
    count: string;
}

interface GuestlistChartPoint {
    date: string;
    count: number;
}

export const partyGetGuestlistChartHandler: RequestHandler<IRequest> = async (request) => {
    const partyId = safeParseString(request.params.id);
    if (partyId === null) {
        return badRequest();
    }

    const client = await pool.connect();
    let rows: GuestlistChartRow[];
    try {
        const result = await client.query<GuestlistChartRow>(
            format(
                `select
                    to_char((joined_at at time zone 'Asia/Dubai')::date, 'YYYY-MM-DD') as date,
                    sum(1 + coalesce(cardinality(friends), 0)) as count
                from party_guestlist
                where party_id = %L and joined_at is not null
                group by 1
                order by 1`,
                partyId,
            ),
        );
        rows = result.rows;
    } finally {
        client.release();
    }

    const points: GuestlistChartPoint[] = [];
    for (const row of rows) {
        points.push({ date: row.date, count: Number(row.count) });
    }

    return success(points);
};
