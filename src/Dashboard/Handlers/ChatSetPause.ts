import type { IRequest, RequestHandler } from 'itty-router';
import { z } from 'zod';
import { updateChatPause } from '#Dashboard/Db/Chats.js';
import { pool } from '#Dashboard/Db/Pool.js';
import { badRequest, notFound, success } from '#Dashboard/Lib/Response.js';
import { safeParseString } from '#Lib/Fmt.js';

const bodySchema = z.object({ paused: z.boolean(), details: z.string().trim().min(1).optional() });

export const chatSetPauseHandler: RequestHandler<IRequest> = async (request) => {
    const phone = safeParseString(request.params.phone);
    if (phone === null) {
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

    const pausedAt = parsed.data.paused ? new Date() : null;
    const details = parsed.data.paused ? (parsed.data.details ?? null) : null;

    const client = await pool.connect();
    let affected: boolean;
    try {
        affected = await updateChatPause(client, phone, pausedAt, details);
    } finally {
        client.release();
    }
    if (!affected) {
        return notFound();
    }

    console.log(`[dashboard:set_pause] ${phone} paused=${parsed.data.paused}`);

    return success({ paused: parsed.data.paused });
};
