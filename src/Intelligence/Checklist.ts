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
        if (tableAnswered) {
            done.push('offer a table');
        }

        let now: string;
        if (!greeted) {
            now = 'Greet the guest and pitch the parties once via get_party.';
        } else if (!entry) {
            // питч не оставляет следа в базе: без оговорки указатель встал бы на нём навсегда
            now = named
                ? 'Call save_guest with the name you already have and the party_id.'
                : "Unless you have already pitched the parties in this chat, pitch them once via get_party; otherwise ask for the guest's first and last name and call save_guest with it the moment it arrives.";
        } else if (!instaAsked) {
            now =
                "Ask for the guest's instagram once and call save_guest with insta_asked in the same turn — never wait for the answer. In the same reply confirm the guest is on the list, with the entry conditions; in your next reply send our instagram and the WhatsApp group, unprompted.";
        } else if (!tableAnswered) {
            now = tableOffered
                ? 'A table was already offered and the guest has not answered — never raise it again. Keep answering about the party, and pass the answer to save_guest as want_table if it ever comes.'
                : "Offer a table once and pass the guest's answer to save_guest as want_table — the tool answers the guest itself.";
        } else {
            now =
                'The funnel is over. Keep answering about the party; anything only Sema can decide — money, exceptions, a fact you were not given — goes to pause_chat.';
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
