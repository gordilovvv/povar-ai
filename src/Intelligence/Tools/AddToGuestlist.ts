import { z } from 'zod';
import { insertGuestlistEntry, selectGuestlistEntry } from '#Db/Guestlist.js';
import { selectGuestByPhone } from '#Db/Guests.js';
import { pool, UNIQUE_ERROR_CODE } from '#Db/Pool.js';
import type { AgentTool, ToolContext } from '#Intelligence/Tools/Types.js';
import { toDateTime } from '#Lib/Fmt.js';

const name = 'add_to_guestlist';
const description = `Put the guest on the guestlist of a specific party. Call it once you have the guest's first name AND instagram. Requires the guest's own instagram saved first — returns instagram_required if missing, collect it via update_guest then retry. Idempotent — a repeated call is safe. Take party_id from the active parties list.`;

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
        const guest = await selectGuestByPhone(client, ctx.phone);
        if (!guest?.instagram_url) {
            return { ok: false, error: 'instagram_required' };
        }

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
