import type { IRequest, RequestHandler } from 'itty-router';
import { z } from 'zod';
import { env } from '#Dashboard/environment.js';
import { consumeRefresh, issueTokenPair } from '#Dashboard/Lib/AuthTokens.js';
import { badRequest, success, unauthorized } from '#Dashboard/Lib/Response.js';

const bodySchema = z.object({ refreshToken: z.string().min(1) });

export const authRefreshHandler: RequestHandler<IRequest> = async (request) => {
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

    if (!consumeRefresh(parsed.data.refreshToken)) {
        return unauthorized();
    }

    return success(issueTokenPair(env.ADMIN_PHONE));
};
