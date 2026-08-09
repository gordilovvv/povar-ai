import type { PartyGuestlistStorage } from '#Db/Guestlist.js';
import type { PartyWithTimeStorage } from '#Db/Party.js';
import type { ChatContext } from '#Intelligence/Context.js';
import { formatDubai, isDubaiToday } from '#Lib/Time.js';

export class Checklist {
    static create(context: ChatContext, returning: boolean): string {
        const { guest, chat, guestlist, pastGuestlist, parties, pastParties } = context;

        const entry = Checklist.lastJoined(guestlist);
        const named = !!guest.first_name;
        const instaAsked = !!guest.instagram_asked_at;
        const tableOffered = !!entry?.table_offered_at;
        const tableAnswered = entry ? entry.booked_table !== null : false;
        // повторному гостю здороваемся заново каждые новые календарные сутки Дубая
        const greeted =
            !!chat?.last_sent_message_at && (!returning || isDubaiToday(chat.last_sent_message_at));

        const instagram = guest.instagram
            ? Checklist.field(guest.instagram)
            : instaAsked
              ? '— (asked, unanswered)'
              : '—';
        const party = entry
            ? `${parties.find((row) => row.id === entry.party_id)?.name ?? entry.party_id} (party_id: ${entry.party_id})`
            : returning
              ? 'not on any current party yet'
              : null;
        const table =
            !entry || entry.booked_table === null
                ? tableOffered
                    ? 'offered, unanswered'
                    : returning
                      ? 'not discussed for the current parties'
                      : 'not raised'
                : entry.booked_table
                  ? 'wants one'
                  : 'declined';

        const state = [
            `name: ${Checklist.field([guest.first_name, guest.last_name].filter(Boolean).join(' '))}`,
            `instagram: ${instagram}`,
            `guestlist: ${Checklist.field(party)}`,
            `table: ${table}`,
            `friends: ${Checklist.field(entry?.friends?.join(', '))}`,
            `parties running: ${Checklist.field(Checklist.running(parties))}`,
        ];

        const done: string[] = returning ? ['get the name', 'ask for the instagram'] : [];
        if (greeted) {
            done.push('greet');
        }
        if (entry) {
            done.push('pitch the parties', 'put the guest on the guestlist');
            if (!returning) {
                done.push('get the name');
            }
        } else if (named && !returning) {
            done.push('get the name');
        }
        if (instaAsked && !returning) {
            done.push('ask for the instagram');
        }
        if (tableOffered || tableAnswered) {
            done.push('offer a table');
        }

        let now: string;
        if (!greeted) {
            now = returning
                ? 'greet warmly (by name if known) — a new day has begun since your last message'
                : 'greet + pitch (get_party)';
        } else if (!entry) {
            // питч и гест-фраза не оставляют следа в базе — были ли они, видно только по истории
            now = returning
                ? 'just answer; the pitch, the yes/no guestlist offer and the solo-or-company question happen only where the history shows they were never asked for the current parties (declined → drop it); the names arrived → save_guest with the party_id and friends'
                : named
                  ? 'name is known but not saved — call save_guest with it and the party_id'
                  : 'waiting for the name — just answer; the guestlist move happens only if history shows it was never said';
        } else if (!instaAsked && !returning) {
            now =
                'instagram (once, save_guest insta_asked immediately) + confirm the list with entry conditions';
        } else if (!tableAnswered) {
            now = tableOffered
                ? 'nothing — table already offered, wait; save_guest want_table if the answer comes'
                : 'offer a table (once)';
        } else {
            now = 'nothing — funnel over, just keep answering';
        }

        const lines = [
            `State: ${state.join(' | ')}`,
            `Done: ${done.length ? done.join('; ') : 'nothing yet'}`,
            `Now: ${now}`,
        ];
        if (returning) {
            const past = pastParties
                .map((row) => {
                    const when = formatDubai(row.party_start_at, guest.lang ?? 'en');
                    const owned = pastGuestlist.find((item) => item.party_id === row.id);
                    return `${row.name} (party_id: ${row.id}, ${when}) — was on its guestlist, ${Checklist.pastTable(owned)}`;
                })
                .join('; ');
            lines.unshift(
                `Past parties: ${past}. That funnel is over and fully saved; State below covers ONLY the current parties. Never re-save anything from a past party.`,
            );
        }
        return lines.join('\n');
    }

    /** Вечеринка идёт строкой на каждое время старта — в блок она попадает один раз. */
    private static running(parties: PartyWithTimeStorage[]): string {
        const seen = new Map<string, string>();
        for (const party of parties) {
            seen.set(party.id, `${party.name} (party_id: ${party.id})`);
        }
        return [...seen.values()].join(', ');
    }

    private static pastTable(entry: PartyGuestlistStorage | undefined): string {
        if (entry?.booked_table === true) {
            return 'table booked';
        }
        if (entry?.booked_table === false) {
            return 'table offered and declined';
        }
        return entry?.table_offered_at ? 'table offered, unanswered' : 'table never offered';
    }

    private static lastJoined(guestlist: PartyGuestlistStorage[]): PartyGuestlistStorage | null {
        return guestlist.reduce<PartyGuestlistStorage | null>(
            (latest, row) =>
                !latest || (row.joined_at ?? '') > (latest.joined_at ?? '') ? row : latest,
            null,
        );
    }

    /** Схлопывает `\n` и `|`: иначе имя гостя допишет в блок свою строку `Now:`. */
    private static field(value: string | null | undefined): string {
        const flat = value?.replace(/[\r\n|]+/g, ' ').trim();
        return flat || '—';
    }
}
