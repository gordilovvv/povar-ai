import type { IRequest, RequestHandler } from 'itty-router';
import format from 'pg-format';
import { pool } from '#Dashboard/Db/Pool.js';
import { badRequest, success } from '#Dashboard/Lib/Response.js';
import { fromDateTime, parseIsoUtc, safeParseString } from '#Lib/Fmt.js';

// год 0000 dayjs пропускает, а Postgres отвергает (22008 → 500)
const EARLIEST_BOUND = '0001-01-01T00:00:00.000Z';

interface PartiesChartRow {
    id: string;
    name: string;
    starts_at: string;
    guest_count: string;
}

interface PartiesChartPoint {
    id: string;
    name: string;
    startsAt: string | null;
    guestCount: number;
}

export const partiesGetChartHandler: RequestHandler<IRequest> = async (request) => {
    const rawFrom = safeParseString(request.query.from);
    const rawTo = safeParseString(request.query.to);
    const from = rawFrom === null ? null : parseIsoUtc(rawFrom);
    const to = rawTo === null ? null : parseIsoUtc(rawTo);
    if (from === null || to === null || from < EARLIEST_BOUND || to <= from) {
        return badRequest();
    }

    const client = await pool.connect();
    let rows: PartiesChartRow[];
    try {
        const result = await client.query<PartiesChartRow>(
            format(
                `with parties as (
                    select
                        party.id,
                        party.name,
                        (select min(time.party_start_at)
                            from party_time time where time.party_id = party.id) as starts_at,
                        (select coalesce(sum(1 + coalesce(cardinality(guest.friends), 0)), 0)
                            from party_guestlist guest where guest.party_id = party.id) as guest_count
                    from party
                )
                select id, name, starts_at, guest_count
                from parties
                where starts_at >= %L::timestamptz and starts_at < %L::timestamptz
                order by starts_at asc, id asc`,
                from,
                to,
            ),
        );
        rows = result.rows;
    } finally {
        client.release();
    }

    const points: PartiesChartPoint[] = [];
    for (const row of rows) {
        points.push({
            id: row.id,
            name: row.name,
            startsAt: fromDateTime(row.starts_at),
            guestCount: Number(row.guest_count),
        });
    }

    return success(points);
};
