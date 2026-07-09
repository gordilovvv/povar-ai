import type Anthropic from '@anthropic-ai/sdk';
import type { WaMessageStorage } from '../../src/db/wa-messages.ts';
import { Agent, type ChatContext } from '../../src/intelligence/agent.ts';

export interface SimGuest {
    first_name: string | null;
    last_name: string | null;
    instagram_url: string | null;
    came_from: 'ad' | null;
    lang: 'ru' | 'en';
}

export interface SimState {
    guest: SimGuest;
    guestlist: string[];
    bookedTables: string[];
    mapSends: number;
    toolCalls: { name: string; input: unknown }[];
}

export interface Turn {
    role: 'guest' | 'sema';
    text: string;
}

export interface SimParty {
    party_id: string;
    name: string;
    location: string;
    price: number;
    google_map_link: string;
    reels_url: string | null;
    notes: string | null;
    when: { start: string; free_entry_before: string | null }[];
}

export const PARTIES: SimParty[] = [
    {
        party_id: 'coya',
        name: 'COYA',
        location: 'COYA Dubai, Four Seasons Resort',
        price: 100,
        google_map_link: 'https://maps.google.com/?q=COYA+Dubai',
        reels_url: null,
        notes: null,
        when: [{ start: 'Thursday 18.06 22:00', free_entry_before: 'Friday 19.06 00:00' }],
    },
    {
        party_id: 'lylo',
        name: 'LYLO',
        location: 'LYLO, Club Vista Mare, Palm Jumeirah, Dubai',
        price: 150,
        google_map_link: 'https://maps.app.goo.gl/9UDyD7XRjTfQSzYy7',
        reels_url: 'https://www.instagram.com/p/DUBJSn8DZW5/',
        notes: 'LYLO — иммерсивный speakeasy-бар со скрытым танцполом на Palm Jumeirah (Canary Beach, Club Vista Mare). Вайб интимный, красный ретро-свет, deep house / minimal techno. Внутри прохладно, кондиционеры, комфортно. Бар: авторские коктейли (85–110 AED), премиум-крепкий, шампанское и вино (бокал 65–85 AED), интерактив «Discover Your Aura» — коктейль под настроение. При заведении есть ресторан (за стеной), но кухня работает примерно до 23:00 — поесть лучше до тусовки; на самой вечеринке уже только напитки. Кальяна нет.',
        when: [{ start: 'Saturday 20.06 22:00', free_entry_before: 'Sunday 21.06 00:00' }],
    },
];

export const INSTAGRAM = 'https://www.instagram.com/weare.wrld/';
export const NOW = 'Wednesday 2026-06-17 14:00:00';

const GUEST_ID = 'e2e-nextstep';
const GUEST_PHONE = '10000000000';

const COLLECTABLE = ['first_name', 'instagram_url'] as const;

const runTool = (
    name: string,
    input: unknown,
    state: SimState,
    replies: string[],
    parties: typeof PARTIES,
): Record<string, unknown> => {
    const args = (input ?? {}) as Record<string, unknown>;
    if (name === 'send_message') {
        const texts = Array.isArray(args.texts)
            ? args.texts.filter((t) => typeof t === 'string')
            : [];
        replies.push(...texts);
        return { ok: true, sent: texts.length };
    }
    if (name === 'get_parties') {
        return { parties, assets: { instagram: INSTAGRAM } };
    }
    if (name === 'update_guest') {
        for (const key of ['first_name', 'last_name', 'instagram_url'] as const) {
            if (typeof args[key] === 'string' && args[key]) {
                state.guest[key] = args[key] as string;
            }
        }
        return {
            ok: true,
            saved: Object.keys(args),
            missing: COLLECTABLE.filter((k) => !state.guest[k]),
        };
    }
    if (name === 'add_to_guestlist') {
        if (!state.guest.instagram_url) {
            return { ok: false, error: 'instagram_required' };
        }
        const partyId = String(args.party_id ?? '');
        const already = state.guestlist.includes(partyId);
        if (!already) {
            state.guestlist.push(partyId);
        }
        return { ok: true, already };
    }
    if (name === 'show_tables') {
        state.mapSends++;
        replies.push('[table map image]');
        return {
            ok: true,
            image_sent: true,
            prices: {
                high_top: { pax: 4, tables: ['171', '172', '173'], min_spend_aed: 1000 },
                front_stage: { pax: 4, tables: ['161', '162'], min_spend_aed: 2000 },
            },
            occupied_tables: ['171', '161'],
        };
    }
    if (name === 'book_table') {
        const partyId = String(args.party_id ?? '');
        if (!state.guestlist.includes(partyId)) {
            return { ok: false, error: 'not_in_guestlist' };
        }
        state.bookedTables.push(partyId);
        return { ok: true, table: args.table ?? null };
    }
    return { ok: false, error: 'unknown_tool' };
};

const toChatContext = (state: SimState, transcript: Turn[], now: string): ChatContext => ({
    guest: {
        id: GUEST_ID,
        wa_phone: GUEST_PHONE,
        first_name: state.guest.first_name,
        last_name: state.guest.last_name,
        instagram_url: state.guest.instagram_url,
        came_from: state.guest.came_from,
        came_at: null,
        lang: state.guest.lang,
    },
    messages: transcript.map(
        (turn, index): WaMessageStorage => ({
            id: String(index + 1).padStart(6, '0'),
            wa_message_id: null,
            wa_chat_phone: GUEST_PHONE,
            text: turn.text,
            owner: turn.role,
            status: 'sent',
            worker_status: null,
            concurrency_version: 0,
            sent_at: NOW,
        }),
    ),
    ownedGuestlist: state.guestlist.map((partyId) => ({
        party_id: partyId,
        guest_id: GUEST_ID,
        table: null,
        visited_party: null,
        booked_table: state.bookedTables.includes(partyId),
        booked_table_paid: null,
        joined_at: null,
    })),
    now,
});

export interface DialogOptions {
    now?: string;
    parties?: typeof PARTIES;
}

const agentTurn = async (
    state: SimState,
    transcript: Turn[],
    opts: Required<DialogOptions>,
): Promise<string[]> => {
    const replies: string[] = [];
    const messages: Anthropic.MessageParam[] = transcript.map((turn) => ({
        role: turn.role === 'guest' ? 'user' : 'assistant',
        content: turn.text,
    }));

    const system = Agent.buildSystem(toChatContext(state, transcript, opts.now));
    let retriedEmptyReply = false;

    for (let step = 0; step < Agent.MAX_STEPS; step++) {
        const response = await Agent.client.messages.create({
            model: process.env.ANTHROPIC_MODEL ?? '',
            max_tokens: Agent.MAX_TOKENS,
            system,
            tools: Agent.toolDefs,
            messages,
        });
        messages.push({ role: 'assistant', content: response.content });

        const toolUses = response.content.filter((block) => block.type === 'tool_use');
        if (response.stop_reason !== 'tool_use' || !toolUses.length) {
            const hasTextReply = replies.some((text) => text !== '[table map image]');
            // как в agent.ts: текст мимо send_message не теряем — шлём сами
            if (!hasTextReply) {
                for (const block of response.content) {
                    if (block.type !== 'text') {
                        continue;
                    }
                    for (const line of block.text.split('\n')) {
                        const bubble = line.trim();
                        if (bubble) {
                            replies.push(bubble);
                        }
                    }
                }
            }
            if (!replies.some((text) => text !== '[table map image]') && !retriedEmptyReply) {
                retriedEmptyReply = true;
                messages.push({
                    role: 'user',
                    content: '(You did not message the guest. Reply now via send_message.)',
                });
                continue;
            }
            break;
        }

        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const toolUse of toolUses) {
            state.toolCalls.push({ name: toolUse.name, input: toolUse.input });
            let output: Record<string, unknown>;
            try {
                output = runTool(toolUse.name, toolUse.input, state, replies, opts.parties);
            } catch {
                output = { ok: false, error: 'tool_failed' };
            }
            results.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: JSON.stringify(output),
            });
        }
        messages.push({ role: 'user', content: results });
    }

    return replies;
};

export interface DialogResult {
    state: SimState;
    transcript: Turn[];
}

export const runDialog = async (
    guest: Partial<SimGuest>,
    guestTurns: string[],
    opts: DialogOptions = {},
): Promise<DialogResult> => {
    const resolved: Required<DialogOptions> = {
        now: opts.now ?? NOW,
        parties: opts.parties ?? PARTIES,
    };
    const state: SimState = {
        guest: {
            first_name: null,
            last_name: null,
            instagram_url: null,
            came_from: null,
            lang: 'ru',
            ...guest,
        },
        guestlist: [],
        bookedTables: [],
        mapSends: 0,
        toolCalls: [],
    };
    const transcript: Turn[] = [];

    for (const guestText of guestTurns) {
        transcript.push({ role: 'guest', text: guestText });
        const replies = await agentTurn(state, transcript, resolved);
        for (const text of replies) {
            transcript.push({ role: 'sema', text });
        }
    }

    return { state, transcript };
};
