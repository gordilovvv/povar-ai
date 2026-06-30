import { z } from 'zod';
import { pool } from '../../db/db.ts';
import { selectActiveParties, selectActivePartyTimes } from '../../db/party.ts';
import { formatDubai } from '../../lib/time.ts';
import type { AgentTool } from './types.ts';

const name = 'get_parties';
const description = `Получить активные вечеринки (площадки, даты/время в Дубае, цена входа) и ассеты для шеринга (WhatsApp-группа, афиша). Вызывай когда нужно рассказать гостю про вечеринки или взять party_id.`;

const input = z.object({});

const WHATSAPP_GROUP = 'https://chat.whatsapp.com/GZ2IIBdkm4W78CoqNtxayu';
const FLYER_REEL = 'https://www.instagram.com/reel/DZka5l_zn7c/';

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
                google_map_link: party.google_map_link,
                when,
            });
        }
        return {
            parties: result,
            assets: { whatsapp_group: WHATSAPP_GROUP, flyer_reel: FLYER_REEL },
        };
    } finally {
        client.release();
    }
};

export default { name, description, input, handler } satisfies AgentTool;
