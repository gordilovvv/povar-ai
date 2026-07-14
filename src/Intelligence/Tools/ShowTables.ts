import { ulid } from 'ulid';
import { z } from 'zod';
import { selectGuestlist } from '#Db/Guestlist.js';
import { selectPartyTables } from '#Db/Party.js';
import { pool } from '#Db/Pool.js';
import { updateWaChatLastSent } from '#Db/WaChats.js';
import { insertWaMessage } from '#Db/WaMessages.js';
import { env } from '#environment.js';
import type { AgentTool, ToolContext } from '#Intelligence/Tools/Types.js';
import { sendWhatsappImage } from '#Platforms/Whatsapp/index.js';

const name = 'show_tables';
const description = `Send the guest the table map image for a party and get zone prices plus occupied_tables — table numbers already taken. The image is sent to the guest automatically on every call — do NOT send any link yourself, and don't call this more than once per reply (each call re-sends the image). After calling, follow up with send_message inviting the guest to pick a table from the photo and tell you the number — do NOT recite the whole list of tables or prices. Answer a specific table's price/availability only when the guest names one, from prices/occupied_tables. Call when the guest asks about tables, table prices, zones, or whether a table is free.`;

const input = z.object({
    party_id: z.string().min(1),
});

export const IMAGE_PLACEHOLDER = '[table map image]';

const handler = async (ctx: ToolContext, raw: unknown) => {
    const parsed = input.safeParse(raw);
    if (!parsed.success) {
        return { ok: false, error: 'bad_input' };
    }

    const client = await pool.connect();
    let tables: Awaited<ReturnType<typeof selectPartyTables>>;
    let occupied: string[];
    try {
        tables = await selectPartyTables(client, parsed.data.party_id);
        if (!tables?.map) {
            return { ok: false, error: 'no_table_map' };
        }
        occupied = [];
        for (const entry of await selectGuestlist(client, parsed.data.party_id)) {
            if (entry.booked_table && entry.table) {
                occupied.push(entry.table);
            }
        }
    } finally {
        client.release();
    }

    if (env.WA_SEND !== 'on') {
        ctx.replies.push(IMAGE_PLACEHOLDER);
        console.log(`[show_tables:off] ${ctx.phone} map: ${tables.map}`);
        return { ok: true, image_sent: true, prices: tables.prices, occupied_tables: occupied };
    }

    const waMessageId = await sendWhatsappImage(ctx.phone, tables.map);
    console.log(`[show_tables] ${ctx.phone} sent map`);

    const now = new Date();
    const writeClient = await pool.connect();
    try {
        await insertWaMessage(writeClient, {
            id: ulid(),
            wa_message_id: waMessageId,
            wa_chat_phone: ctx.phone,
            text: IMAGE_PLACEHOLDER,
            owner: 'sema',
            status: 'sent',
            worker_status: null,
            concurrency_version: 0,
            sent_at: now,
        });
        await updateWaChatLastSent(writeClient, ctx.phone, now);
    } finally {
        writeClient.release();
    }

    ctx.replies.push(IMAGE_PLACEHOLDER);
    return { ok: true, image_sent: true, prices: tables.prices, occupied_tables: occupied };
};

export default { name, description, input, handler } satisfies AgentTool;
