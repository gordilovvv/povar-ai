import type { PartyGuestlistStorage } from '#Db/Guestlist.js';
import type { ChatContext } from '#Intelligence/Context.js';

export class Checklist {
    static create(context: ChatContext): string {
        const { guest, chat, guestlist, parties } = context;

        const entry = Checklist.lastJoined(guestlist);
        const greeted = !!chat?.last_sent_message_at;
        const named = !!guest.first_name;
        const instaAsked = !!guest.instagram_asked_at;
        const tableOffered = !!entry?.table_offered_at;
        const tableAnswered = entry ? entry.booked_table !== null : false;
        const bookedTable = entry?.booked_table ?? null;

        const instagram = guest.instagram
            ? Checklist.field(guest.instagram)
            : instaAsked
              ? '— (asked, unanswered)'
              : '—';
        const partyName = entry
            ? (parties.find((party) => party.id === entry.party_id)?.name ?? entry.party_id)
            : null;

        const state = [
            `name: ${Checklist.field([guest.first_name, guest.last_name].filter(Boolean).join(' '))}`,
            `instagram: ${instagram}`,
            `guestlist: ${Checklist.field(partyName)}`,
            `table: ${bookedTable === null ? (tableOffered ? 'offered, unanswered' : 'not raised') : bookedTable ? 'wants one' : 'declined'}`,
            `friends: ${Checklist.field(entry?.friends?.join(', '))}`,
            `parties running: ${Checklist.field(parties.map((party) => party.name).join(', '))}`,
        ];

        const done: string[] = [];
        if (greeted) {
            done.push('greet');
        }
        if (entry) {
            done.push('pitch the parties', 'get the name', 'put the guest on the guestlist');
        } else if (named) {
            done.push('get the name');
        }
        if (instaAsked) {
            done.push('ask for the instagram');
        }
        if (tableOffered || tableAnswered) {
            done.push('offer a table');
        }

        let now: string;
        if (!greeted) {
            now = 'greet + pitch (get_party)';
        } else if (!entry) {
            // питч и гест-фраза не оставляют следа в базе — были ли они, видно только по истории
            now = named
                ? 'name is known but not saved — call save_guest with it and the party_id'
                : 'waiting for the name — just answer; the guestlist move happens only if history shows it was never said';
        } else if (!instaAsked) {
            now =
                'instagram (once, save_guest insta_asked immediately) + confirm the list with entry conditions';
        } else if (!tableAnswered) {
            now = tableOffered
                ? 'nothing — table already offered, wait; save_guest want_table if the answer comes'
                : 'offer a table (once)';
        } else {
            now = 'nothing — funnel over, just keep answering';
        }

        return [
            `State: ${state.join(' | ')}`,
            `Done: ${done.length ? done.join('; ') : 'nothing yet'}`,
            `Now: ${now}`,
        ].join('\n');
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
