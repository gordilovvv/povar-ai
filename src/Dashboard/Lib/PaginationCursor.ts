import { parseIsoUtc } from '#Lib/Fmt.js';

interface KeysetCursor {
    time: string;
    id: string;
}

/**
 * Формат opaque `<iso>|<id>`; id без разделителя (у нас — цифры телефона).
 */
export class PaginationCursor {
    private static readonly SEPARATOR = '|';

    static encode(time: string, id: string): string {
        return `${time}${PaginationCursor.SEPARATOR}${id}`;
    }

    static decode(raw: string): KeysetCursor | null {
        const index = raw.indexOf(PaginationCursor.SEPARATOR);
        if (index === -1) {
            return null;
        }
        const time = parseIsoUtc(raw.slice(0, index));
        const id = raw.slice(index + 1);
        if (time === null || id === '') {
            return null;
        }
        return { time, id };
    }
}
