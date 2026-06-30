import { z } from 'zod';
import { pool, UNIQUE_ERROR_CODE } from '../../db/db.ts';
import { insertGuestlistEntry, selectGuestlistEntry } from '../../db/guestlist.ts';
import { toDateTime } from '../../lib/fmt.ts';
import type { AgentTool, ToolContext } from './types.ts';

const name = 'add_to_guestlist';
const description = `Тихо занести гостя в гест-лист конкретной вечеринки. Вызывай после того как собрал имя гостя. Идемпотентно — повторный вызов безопасен. party_id бери из списка активных вечеринок.`;

const input = z.object({
    party_id: z.string().min(1),
});

const handler = async (ctx: ToolContext, raw: unknown): Promise<unknown> => {
    const parsed = input.safeParse(raw);
    if (!parsed.success) {
        return { ok: false, error: 'bad_input' };
    }

    const client = await pool.connect();
    try {
        const existing = await selectGuestlistEntry(client, parsed.data.party_id, ctx.guestId);
        if (existing) {
            return { ok: true, already: true };
        }
        await insertGuestlistEntry(
            client,
            parsed.data.party_id,
            ctx.guestId,
            toDateTime(Date.now()),
        );
        return { ok: true, already: false };
    } catch (error) {
        const isUniqueViolation =
            error &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === UNIQUE_ERROR_CODE;
        if (!isUniqueViolation) {
            throw error;
        }
    } finally {
        client.release();
    }

    return handler(ctx, raw);
};

export default { name, description, input, handler } satisfies AgentTool;
