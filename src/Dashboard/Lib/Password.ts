import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SALT_BYTES = 16;
const KEY_BYTES = 64;

/** Хэш пароля в формате `saltHex:hashHex` для записи в env. */
export const hashPassword = (password: string): string => {
    const salt = randomBytes(SALT_BYTES);
    const hash = scryptSync(password, salt, KEY_BYTES);
    return `${salt.toString('hex')}:${hash.toString('hex')}`;
};

/** Сверка пароля с хэшем `saltHex:hashHex`; constant-time. */
export const verifyPassword = (password: string, stored: string): boolean => {
    const [saltHex, hashHex] = stored.split(':');
    if (!saltHex || !hashHex) {
        return false;
    }
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
};
