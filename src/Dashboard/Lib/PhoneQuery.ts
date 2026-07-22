import { parsePhoneNumberFromString } from 'libphonenumber-js';

export const parsePhoneQuery = (raw: string): string | null => {
    const digits = raw.replace(/\D/g, '');
    if (!digits.length) {
        return null;
    }
    const candidate = raw.trim().startsWith('+') ? raw : `+${digits}`;
    const parsed = parsePhoneNumberFromString(candidate);
    return parsed?.isValid() ? parsed.number.slice(1) : digits;
};
