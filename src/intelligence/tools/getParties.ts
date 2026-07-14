import { z } from 'zod';
import { selectActiveParties, selectActivePartyTimes } from '#Db/Party.js';
import { pool } from '#Db/Pool.js';
import type { AgentTool } from '#Intelligence/Tools/Types.js';
import { formatDubai } from '#Lib/Time.js';

const name = 'get_parties';
const description = `Get active parties (venues, Dubai dates/times, entry price, reels_url = the party poster) and assets (instagram link). Call it when you need to tell the guest about parties, take a party_id, send the instagram link, or send the poster (reels_url).`;

const input = z.object({});

const INSTAGRAM = 'https://www.instagram.com/weare.wrld/';

const handler = async () => {
    const client = await pool.connect();
    try {
        const parties = await selectActiveParties(client);
        const times = await selectActivePartyTimes(client);

        const result = [];
        for (const party of parties) {
            const when = times
                .filter((t) => t.party_id === party.id)
                .map((t) => ({
                    start: formatDubai(t.party_start_at),
                    free_entry_before: t.free_entry_before
                        ? formatDubai(t.free_entry_before)
                        : null,
                }));
            result.push({
                party_id: party.id,
                name: party.name,
                location: party.location,
                price: party.price,
                notes: party.notes,
                reels_url: party.reels_url,
                google_map_link: party.google_map_link,
                when,
            });
        }
        return {
            parties: result,
            assets: { instagram: INSTAGRAM },
        };
    } finally {
        client.release();
    }
};

export default { name, description, input, handler } satisfies AgentTool;
