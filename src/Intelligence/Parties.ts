import type { PartyWithTimeStorage } from '#Db/Party.js';
import type { Lang } from '#Lib/Lang.js';
import { dubaiDaysFromNow, dubaiWeeksFromNow, formatDubai } from '#Lib/Time.js';

export class Parties {
    private static readonly HEADER =
        "<parties>\nEvery party currently running, one <party> each. type: owned means Sema's own party, invited means he plays there as a guest DJ — the pitch wording depends on it. when lists the upcoming starts with their end and free-entry cutoff, already in Dubai time and in the guest's format; day is the distance of the start from today — never count dates yourself; week is the ready week phrase. party_id is the id for save_guest. A missing field is genuinely unknown. No <party> at all → no party is open, say so.";

    private static readonly WEEK: Record<Lang, [current: string, next: string, later: string]> = {
        en: ['this week', 'next week', 'soon'],
        ru: ['На этой неделе', 'На следующей неделе', 'Скоро'],
    };

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
                    end: row.party_end_at ? formatDubai(row.party_end_at, lang) : null,
                    day: Parties.day(dubaiDaysFromNow(row.party_start_at)),
                    week: Parties.WEEK[lang][
                        Math.min(Math.max(dubaiWeeksFromNow(row.party_start_at), 0), 2)
                    ],
                    free_entry_before: row.free_entry_before
                        ? formatDubai(row.free_entry_before, lang)
                        : null,
                })),
            };
            return [`<party>\n${JSON.stringify(card, null, 1)}\n</party>`];
        });
        return [Parties.HEADER, ...cards, '</parties>'].join('\n');
    }

    private static day(days: number): string {
        if (days < 0) {
            return 'already started';
        }
        return ['today', 'tomorrow'][days] ?? `in ${days} days`;
    }
}
