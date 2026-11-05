import type { IRequest, RequestHandler } from 'itty-router';
import { z } from 'zod';
import { updateGuestMarketing } from '#Dashboard/Db/Guests.js';
import { pool } from '#Dashboard/Db/Pool.js';
import { badRequest, conflict, notFound, success } from '#Dashboard/Lib/Response.js';
import { type GuestMarketing, guestMarketingSchema } from '#Db/Guests.js';
import { safeParseString } from '#Lib/Fmt.js';

const bodySchema = z.object({
    marketing: guestMarketingSchema.exclude([guestMarketingSchema.enum.blocked_by_user]),
});

export const guestPostMarketingHandler: RequestHandler<IRequest> = async (request) => {
    const id = safeParseString(request.params.id);
    if (id === null) {
        return badRequest();
    }
    let raw: unknown;
    try {
        raw = await request.json();
    } catch {
        return badRequest();
    }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
        return badRequest();
    }

    const client = await pool.connect();
    let marketing: GuestMarketing | null;
    try {
        marketing = await updateGuestMarketing(client, id, parsed.data.marketing);
    } finally {
        client.release();
    }
    if (marketing === null) {
        return notFound();
    }
    if (marketing === guestMarketingSchema.enum.blocked_by_user) {
        return conflict();
    }

    console.log(`[dashboard:guest_marketing] ${id} ${marketing}`);

    return success({ id, marketing });
};
