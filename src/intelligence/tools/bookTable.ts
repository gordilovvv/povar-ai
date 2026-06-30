import { z } from 'zod';
import { pool } from '../../db/db.ts';
import { updateGuestlistBooking } from '../../db/guestlist.ts';
import type { AgentTool, ToolContext } from './types.ts';

const name = 'book_table';
const description = `Забронировать стол гостю на конкретной вечеринке. Вызывай только когда гость явно согласился взять стол. Гость уже должен быть в гест-листе (add_to_guestlist). table — необязательная метка/зона стола, если гость назвал.`;

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
