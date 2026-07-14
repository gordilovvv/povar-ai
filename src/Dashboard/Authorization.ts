import type { IRequest, RequestHandler } from 'itty-router';
import { selectDashboardUser } from '#Dashboard/Db/DashboardUsers.js';
import { pool } from '#Dashboard/Db/Pool.js';
import { env } from '#Dashboard/environment.js';
import { verifyJwt } from '#Dashboard/Lib/Jwt.js';
import { unauthorized } from '#Dashboard/Lib/Response.js';

const BEARER_PREFIX = 'Bearer ';

export const withAuthorization: RequestHandler<IRequest> = async (request) => {
    const header = request.headers.get('authorization');
    if (!header?.startsWith(BEARER_PREFIX)) {
        return unauthorized();
    }

    const payload = verifyJwt(header.slice(BEARER_PREFIX.length), env.JWT_SECRET);
    if (!payload) {
        return unauthorized();
    }

    const client = await pool.connect();
    let user: Awaited<ReturnType<typeof selectDashboardUser>>;
    try {
        user = await selectDashboardUser(client, payload.sub);
    } finally {
        client.release();
    }
    if (!user) {
        return unauthorized();
    }
};
