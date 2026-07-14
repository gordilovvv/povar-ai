import { z } from 'zod';
import { updateGuestlistBooking } from '#Db/Guestlist.js';
import { pool } from '#Db/Pool.js';
import type { AgentTool, ToolContext } from '#Intelligence/Tools/Types.js';

const name = 'book_table';
const description = `Book a table for the guest at a specific party. Call it only when the guest explicitly agreed to take a table. The guest must already be on the guestlist (add_to_guestlist). table is an optional table label/zone if the guest named one.`;

const input = z.object({
    party_id: z.string().min(1),
    table: z.string().min(1).optional(),
});

const handler = async (ctx: ToolContext, raw: unknown) => {
    const parsed = input.safeParse(raw);
    if (!parsed.success) {
        return { ok: false, error: 'bad_input' };
    }

    const client = await pool.connect();
    try {
        const entry = await updateGuestlistBooking(client, parsed.data.party_id, ctx.guestId, {
            table: parsed.data.table,
            booked_table: true,
        });
        if (!entry) {
            return { ok: false, error: 'not_in_guestlist' };
        }
        return { ok: true, table: entry.table };
    } finally {
        client.release();
    }
};

export default { name, description, input, handler } satisfies AgentTool;
