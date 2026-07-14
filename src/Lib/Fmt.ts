import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';

dayjs.extend(utc);

export const capitalize = (str: string) => {
    return str.charAt(0).toUpperCase() + str.slice(1);
};

export const toDateTime = (date: Date | string | number) => {
    return dayjs(date).utc().format('YYYY-MM-DD HH:mm:ss');
};

export const fromDateTime = (value: Date | string | null | undefined): string | null => {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    const parsed =
        value instanceof Date ? dayjs.utc(value) : dayjs.utc(value, 'YYYY-MM-DD HH:mm:ss');
    return parsed.isValid() ? parsed.toISOString() : null;
};

export const parseIsoUtc = (value: string): string | null => {
    const parsed = dayjs.utc(value);
    return parsed.isValid() && parsed.toISOString() === value ? value : null;
};

// Длинные тире (—, –, ―, …) выглядят «ботом» — заменяем на обычный дефис.
const LONG_DASHES = /[‒–—―⸺⸻]/g;

export const stripLongDashes = (text: string) => text.replace(LONG_DASHES, '-');

// Модель путает ё/е — убираем ё из исходящего текста вовсе.
export const stripYo = (text: string) => text.replace(/ё/g, 'е').replace(/Ё/g, 'Е');

const MAX_QUERY_STRING_LENGTH = 512;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control chars stripped intentionally
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export const safeParseString = (value: string | string[] | undefined): string | null => {
    if (typeof value !== 'string' || value.length > MAX_QUERY_STRING_LENGTH) {
        return null;
    }
    const trimmed = value.trim();
    if (trimmed === '' || CONTROL_CHARS.test(trimmed)) {
        return null;
    }
    return trimmed;
};

export const safeParseInt = (value: string | string[] | undefined, fallback: number): number => {
    const str = safeParseString(value);
    if (str === null || !/^-?\d+$/.test(str)) {
        return fallback;
    }
    const num = Number(str);
    return Number.isSafeInteger(num) ? num : fallback;
};

export const safeParseDigits = (value: string | string[] | undefined): string | null => {
    const str = safeParseString(value);
    return str !== null && /^\d+$/.test(str) ? str : null;
};

export const minMax = (value: number, min: number, max: number): number => {
    return Math.min(Math.max(value, min), max);
};
