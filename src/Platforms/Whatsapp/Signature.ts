import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '#environment.js';

export const verifySignature = (raw: string, header: string | null) => {
    if (!header) {
        return false;
    }
    const expected = `sha256=${createHmac('sha256', env.WA_APP_SECRET).update(raw).digest('hex')}`;
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
};
