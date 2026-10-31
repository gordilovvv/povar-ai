import type { IRequest, RequestHandler } from 'itty-router';
import { type GuestsStatisticRow, selectGuestsStatistic } from '#Dashboard/Db/Guests.js';
import { pool } from '#Dashboard/Db/Pool.js';
import { success } from '#Dashboard/Lib/Response.js';

export const guestsGetStatisticHandler: RequestHandler<IRequest> = async () => {
    const client = await pool.connect();
    let row: GuestsStatisticRow;
    try {
        row = await selectGuestsStatistic(client);
    } finally {
        client.release();
    }

    return success({
        guestsCount: row.guests_count,
        maleCount: row.male_count,
        femaleCount: row.female_count,
    });
};
