import { appendFileSync, existsSync, readFileSync } from 'node:fs';

export const BOLD = '\x1b[1;97m';
export const GRAY = '\x1b[90m';
export const RED = '\x1b[91m';
export const YELLOW = '\x1b[93m';
export const RESET = '\x1b[0m';

const SEPARATORS = /[\s().\-/‐‑‒–—―]/g;
const MIN_DIGITS = 8;
const MAX_DIGITS = 15;

export function normalizePhone(raw: string): string | null {
    const cleaned = raw.replace(SEPARATORS, '');
    const hasCountryCode = cleaned.startsWith('+') || cleaned.startsWith('00');
    const digits = cleaned.startsWith('+')
        ? cleaned.slice(1)
        : cleaned.startsWith('00')
          ? cleaned.slice(2)
          : cleaned;
    if (!/^\d+$/.test(digits)) {
        return null;
    }
    if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) {
        return null;
    }
    if (!hasCountryCode && digits.startsWith('0')) {
        return null;
    }
    return digits;
}

export function readCheckpoint(path: string): Set<string> {
    if (!existsSync(path)) {
        return new Set();
    }
    const phones = new Set<string>();
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        const phone = line.trim().split(/\s+/)[0];
        if (phone) {
            phones.add(phone);
        }
    }
    return phones;
}

export function appendCheckpoint(
    path: string,
    phone: string,
    status: 'sending' | 'sent' | 'failed',
) {
    appendFileSync(path, `${phone} ${status}\n`);
}

export function fmtMmSs(totalSec: number): string {
    const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const ss = String(totalSec % 60).padStart(2, '0');
    return `${mm}:${ss}`;
}
