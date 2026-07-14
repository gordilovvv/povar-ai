import { randomBytes } from 'node:crypto';
import { env } from '#Dashboard/environment.js';
import { signJwt } from '#Dashboard/Lib/Jwt.js';

const ACCESS_TTL_SEC = 15 * 60;
const REFRESH_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const REFRESH_BYTES = 32;

const refreshTokens = new Map<string, number>();

export interface TokenPair {
    accessToken: string;
    refreshToken: string;
}

/** Выдать пару токенов и зарегистрировать refresh. */
export const issueTokenPair = (phone: string): TokenPair => {
    const accessToken = signJwt(
        { sub: phone, exp: Math.floor(Date.now() / 1000) + ACCESS_TTL_SEC },
        env.JWT_SECRET,
    );
    const refreshToken = randomBytes(REFRESH_BYTES).toString('base64url');
    refreshTokens.set(refreshToken, Date.now() + REFRESH_TTL_MS);
    return { accessToken, refreshToken };
};

/** Одноразовая проверка refresh: гасит запись, `true` только если была валидна. */
export const consumeRefresh = (refreshToken: string): boolean => {
    const expiresAt = refreshTokens.get(refreshToken);
    if (expiresAt === undefined) {
        return false;
    }
    refreshTokens.delete(refreshToken);
    return expiresAt > Date.now();
};
