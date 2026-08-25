import type { PartyWithTimeStorage } from '#Db/Party.js';
import type { Lang } from '#Lib/Lang.js';
import { formatDubai } from '#Lib/Time.js';

/**
 * Блок вечеринок для system-промта. Набор — selectActivePartiesWithTimes: только текущая
 * неделя по Дубаю (пн–вс), старт не раньше now() − PARTY_ACTIVE_HOURS; заведённое наперёд не попадает.
 */
export class Parties {
    private static readonly HEADER =
        "<parties>\nEvery party currently running, one <party> each. type: owned means Sema's own party, invited means he plays there as a guest DJ — the pitch wording depends on it. when lists the upcoming starts with their free-entry cutoff, already in Dubai time and in the guest's format. party_id is the id for save_guest. A missing field is genuinely unknown. No <party> at all → no party is open, say so.";

    static block(rows: PartyWithTimeStorage[], lang: Lang): string {
        const cards = [...Map.groupBy(rows, (row) => row.id).values()].flatMap((times) => {
            const [party] = times;
            if (!party) {
                return [];
            }
            const card = {
                party_id: party.id,
                name: party.name,
                type: party.type,
                location: party.location,
                price: party.price,
                notes: party.notes,
                reels_url: party.reels_url,
                google_map_link: party.google_map_link,
                when: times.map((row) => ({
                    start: formatDubai(row.party_start_at, lang),
                    free_entry_before: row.free_entry_before
                        ? formatDubai(row.free_entry_before, lang)
                        : null,
                })),
            };
            return [`<party>\n${JSON.stringify(card, null, 1)}\n</party>`];
        });
        return [Parties.HEADER, ...cards, '</parties>'].join('\n');
    }
}
