import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const jwtPayloadSchema = z.object({ sub: z.string(), exp: z.number() });

export type JwtPayload = z.infer<typeof jwtPayloadSchema>;

const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

export const signJwt = (payload: JwtPayload, secret: string) => {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const data = `${HEADER}.${body}`;
    const signature = createHmac('sha256', secret).update(data).digest('base64url');
    return `${data}.${signature}`;
};

export const verifyJwt = (token: string, secret: string): JwtPayload | null => {
    const [header, body, signature, extra] = token.split('.');
    if (
        header === undefined ||
        body === undefined ||
        signature === undefined ||
        extra !== undefined
    ) {
        return null;
    }
    const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (signatureBuffer.length !== expectedBuffer.length) {
        return null;
    }
    if (!timingSafeEqual(signatureBuffer, expectedBuffer)) {
        return null;
    }
    let raw: unknown;
    try {
        raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
    const parsed = jwtPayloadSchema.safeParse(raw);
    if (!parsed.success) {
        return null;
    }
    if (parsed.data.exp <= Math.floor(Date.now() / 1000)) {
        return null;
    }
    return parsed.data;
};
