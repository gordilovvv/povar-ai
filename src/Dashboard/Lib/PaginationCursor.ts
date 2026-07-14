import { z } from 'zod';
import { parseIsoUtc } from '#Lib/Fmt.js';

interface KeysetCursor {
    time: string;
    id: string;
}

const partiesKeysetSchema = z
    .object({
        bucket: z.number().int().min(0).max(2),
        startsAt: z.union([z.null(), z.string().refine((value) => parseIsoUtc(value) !== null)]),
        id: z.string().min(1),
    })
    .refine((keyset) => (keyset.bucket === 0) === (keyset.startsAt === null));

export type PartiesKeyset = z.infer<typeof partiesKeysetSchema>;

/**
 * Opaque keyset-курсоры дашборда. Форматы по методам:
 * time|id (чаты/сообщения) и base64url(JSON) от (bucket, startsAt, id) (вечеринки).
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

    static encodeParties(keyset: PartiesKeyset): string {
        return Buffer.from(JSON.stringify(keyset)).toString('base64url');
    }

    static decodeParties(raw: string): PartiesKeyset | null {
        let parsed: unknown;
        try {
            parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
        } catch {
            return null;
        }
        const result = partiesKeysetSchema.safeParse(parsed);
        return result.success ? result.data : null;
    }
}
