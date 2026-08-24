import type { PartyGuestlistStorage } from '#Db/Guestlist.js';
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
        ];

        const invite = Checklist.invite(context);
        if (invite) {
            state.push(`invite: ${invite}`);
        }

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
                ? "greet warmly (by name if known, the name rendered in the chat's language: latin-stored → Cyrillic in a Russian chat) — a new day has begun since your last message"
                : 'greet + pitch';
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

    /** Приглашение — факт чата, а не гостя: came_from повторному гостю рассылка не меняет. */
    private static invite(context: ChatContext): string | null {
        if (!context.messages.some((message) => message.owner === 'marketing')) {
            return null;
        }
        const sent = context.marketingSends.filter((row) =>
            context.parties.some((party) => party.id === row.party_id),
        );
        if (!sent.length) {
            return 'the guest got the broadcast invite template and is writing back to it — do not open from scratch';
        }
        const names = sent
            .map((row) => {
                const name = context.parties.find((party) => party.id === row.party_id)?.name;
                return `${name} (party_id: ${row.party_id})`;
            })
            .join(', ');
        return `the guest got the broadcast invite and the full details for ${names} — they are already in their hands, do not pitch it from scratch, take them to the guestlist`;
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
