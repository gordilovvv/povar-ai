import type { PoolClient } from 'pg';
import { type PartyGuestlistStorage, selectGuestlistByGuest } from '#Db/Guestlist.js';
import { type GuestStorage, selectGuestByPhone, updateGuestLang } from '#Db/Guests.js';
import {
    type PartyWithTimeStorage,
    type PastPartyStorage,
    selectActivePartiesWithTimes,
    selectPastPartiesByGuest,
} from '#Db/Party.js';
import { pool } from '#Db/Pool.js';
import { selectWaChat, type WaChatStorage } from '#Db/WaChats.js';
import { selectWaChatMessages, type WaMessageStorage } from '#Db/WaMessages.js';
import { parseLanguage } from '#Lib/Lang.js';
import { formatDubaiNow } from '#Lib/Time.js';

interface ChatState {
    guest: GuestStorage;
    chat: WaChatStorage | null;
    guestlist: PartyGuestlistStorage[];
    pastGuestlist: PartyGuestlistStorage[];
}

export interface ChatContext extends ChatState {
    messages: WaMessageStorage[];
    parties: PartyWithTimeStorage[];
    pastParties: PastPartyStorage[];
    now: string;
}

export class Context {
    private static readonly MESSAGES_HISTORY_LIMIT = 40;

    static async load(phone: string): Promise<Context> {
        const client = await pool.connect();
        try {
            const messages = await selectWaChatMessages(
                client,
                phone,
                null,
                Context.MESSAGES_HISTORY_LIMIT,
            );
            // запрос отдаёт последние N по id: порядок хода — по sent_at, id разводит одну секунду
            messages.sort((a, b) => {
                // pg отдаёт timestamptz как Date: `===` сравнивает ссылки и тай-брейк по id никогда не срабатывает
                const left = new Date(a.sent_at).getTime();
                const right = new Date(b.sent_at).getTime();
                return left !== right ? left - right : a.id < b.id ? -1 : 1;
            });

            const parties = await selectActivePartiesWithTimes(client);
            const state = await Context.loadState(client, phone, parties);
            const pastParties = await selectPastPartiesByGuest(client, state.guest.id);

            if (!state.guest.lang) {
                const lang = parseLanguage(
                    messages.flatMap((message) =>
                        message.owner === 'guest' && message.text ? [message.text] : [],
                    ),
                );
                if (lang) {
                    state.guest =
                        (await updateGuestLang(client, state.guest.id, lang)) ?? state.guest;
                }
            }

            return new Context(phone, messages, parties, pastParties, state);
        } finally {
            client.release();
        }
    }

    private constructor(
        readonly phone: string,
        private readonly messages: WaMessageStorage[],
        private readonly parties: PartyWithTimeStorage[],
        private readonly pastParties: PastPartyStorage[],
        private state: ChatState,
    ) {}

    /**
     * История и вечеринки заморожены на ход: окно активных вечеринок отсчитывается
     * от now(), и запись гостя иначе исчезнет из-под воронки посреди хода.
     */
    async refresh(): Promise<void> {
        const client = await pool.connect();
        try {
            this.state = await Context.loadState(client, this.phone, this.parties);
        } finally {
            client.release();
        }
    }

    get context(): ChatContext {
        return {
            ...this.state,
            messages: this.messages,
            parties: this.parties,
            pastParties: this.pastParties,
            now: formatDubaiNow(),
        };
    }

    private static async loadState(
        client: PoolClient,
        phone: string,
        parties: PartyWithTimeStorage[],
    ): Promise<ChatState> {
        const guest = await selectGuestByPhone(client, phone);
        if (!guest) {
            throw new Error(`Unknown guest ${phone}`);
        }

        const chat = await selectWaChat(client, phone);
        const owned = await selectGuestlistByGuest(client, guest.id);
        const running = (row: PartyGuestlistStorage) =>
            parties.some((party) => party.id === row.party_id);

        return {
            guest,
            chat,
            guestlist: owned.filter(running),
            pastGuestlist: owned.filter((row) => !running(row)),
        };
    }
}
