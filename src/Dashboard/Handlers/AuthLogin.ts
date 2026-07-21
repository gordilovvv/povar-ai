import type { IRequest, RequestHandler } from 'itty-router';
import { z } from 'zod';
import { env } from '#Dashboard/environment.js';
import { issueTokenPair } from '#Dashboard/Lib/AuthTokens.js';
import { verifyPassword } from '#Dashboard/Lib/Password.js';
import { badRequest, success, unauthorized } from '#Dashboard/Lib/Response.js';

const bodySchema = z.object({ phone: z.string().min(1), password: z.string().min(1) });

export const authLoginHandler: RequestHandler<IRequest> = async (request) => {
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

    const passwordOk = verifyPassword(parsed.data.password, env.ADMIN_PASSWORD_HASH);
    const phoneOk = parsed.data.phone === env.ADMIN_PHONE;
    if (!phoneOk || !passwordOk) {
        return unauthorized();
    }

    return success(issueTokenPair(env.ADMIN_PHONE));
};
