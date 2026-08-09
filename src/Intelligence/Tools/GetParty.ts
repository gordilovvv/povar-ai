import { z } from 'zod';
import { selectActivePartiesWithTimes } from '#Db/Party.js';
import { pool } from '#Db/Pool.js';
import { badInput } from '#Intelligence/Tools/Utils.js';
import { langSchema } from '#Lib/Lang.js';
import { formatDubai } from '#Lib/Time.js';
import type { AgentTool, ToolContext } from '#Lib/Tools.js';

const name = 'get_party';
const description = `Read-only. Returns every party currently running, each as party_id, name, type (owned means Sema's own party, invited means he plays there as a guest DJ — the pitch wording depends on it), location, price, notes, reels_url, google_map_link, and a when list of upcoming starts with their free-entry cutoff, times already in Dubai for the guest. Call it before the first pitch and before any factual answer about a party — date, time, place, price, free entry, how to get there, what the night is about, and anything else a guest may ask about it — the party_id for save_guest is the id from this result or from the state block — they are the same ids. language is the language the guest writes in, and the weekday of every start comes back in it; use en if it is neither Russian nor English. A missing field is genuinely unknown, never invent a price, link or condition it did not return; an empty result means no party is open, say so instead of inventing one; if more than one party comes back and the guest has not named one, ask which before going on. It never speaks to the guest — send what you learned through send_message — and it never saves anything about the guest — that is save_guest. It carries only the entry price, so table cost, discounts and anything else outside these fields go to pause_chat, not another call here; the guest's own yes or no about a table is neither — that goes to save_guest as want_table.`;

const input = z.object({
    language: langSchema,
});

/**
 * Отдаёт активные вечеринки: карточку вечеринки плюс её расписание стартов.
 * Активной считается вечеринка со стартом не старше окна PARTY_ACTIVE_HOURS.
 * Время — строками в таймзоне Дубая, для показа гостю.
 */
const handler = async (_ctx: ToolContext, raw: unknown) => {
    const parsed = input.safeParse(raw);
    if (!parsed.success) {
        return badInput(parsed.error);
    }
    const { language } = parsed.data;

    const client = await pool.connect();
    try {
        const rows = await selectActivePartiesWithTimes(client);

        const parties = new Map<
            string,
            {
                party_id: string;
                name: string;
                type: string;
                location: string;
                price: string | null;
                notes: string | null;
                reels_url: string | null;
                google_map_link: string | null;
                when: { start: string; free_entry_before: string | null }[];
            }
        >();
        for (const row of rows) {
            let party = parties.get(row.id);
            if (!party) {
                party = {
                    party_id: row.id,
                    name: row.name,
                    type: row.type,
                    location: row.location,
                    price: row.price,
                    notes: row.notes,
                    reels_url: row.reels_url,
                    google_map_link: row.google_map_link,
                    when: [],
                };
                parties.set(row.id, party);
            }
            party.when.push({
                start: formatDubai(row.party_start_at, language),
                free_entry_before: row.free_entry_before
                    ? formatDubai(row.free_entry_before, language)
                    : null,
            });
        }
        return [...parties.values()];
    } finally {
        client.release();
    }
};

export default { name, description, input, handler } satisfies AgentTool;
