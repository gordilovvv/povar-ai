/**
 * Проба 3: чек-лист остаётся, меняем источник состояния.
 * A — регексы по тексту (прод сегодня), C — журнал событий (факты + флаги).
 * Один набор кейсов, одна метрика: сколько флагов чек-листа сошлись с истиной.
 * API не дёргаем.
 */
import type { GuestStorage } from '#Db/Guests.js';
import type { WaMessageStorage } from '#Db/WaMessages.js';
import { Agent, type ChatContext } from '#Intelligence/Agent.js';

/** Что журнал реально записал бы: интент отправленного сообщения либо вызов тула. */
type Event =
    | { kind: 'sent'; intent: 'ask_instagram' | 'insta_followup' | 'venue_answer' | 'lineup' }
    | { kind: 'tool'; name: 'add_to_guestlist' | 'book_table' | 'show_tables' };

interface Turn {
    role: 'guest' | 'sema';
    text: string;
}

interface Flags {
    tableMode: boolean;
    instaAsked: boolean;
    followupDone: boolean;
}

interface Case {
    name: string;
    turns: Turn[];
    journal: Event[];
    guest?: Partial<GuestStorage>;
    guestlist?: boolean;
    truth: Flags;
}

const CASES: Case[] = [
    {
        name: 'вопрос про комфорт («is it comfortable inside?»)',
        turns: [{ role: 'guest', text: 'is it comfortable inside? i hate hot places' }],
        journal: [{ kind: 'sent', intent: 'venue_answer' }],
        guest: { first_name: 'Игорь' },
        guestlist: true,
        truth: { tableMode: false, instaAsked: false, followupDone: false },
    },
    {
        name: '«столько людей будет?»',
        turns: [{ role: 'guest', text: 'а столько людей будет на вечеринке?' }],
        journal: [{ kind: 'sent', intent: 'venue_answer' }],
        guest: { first_name: 'Игорь' },
        guestlist: true,
        truth: { tableMode: false, instaAsked: false, followupDone: false },
    },
    {
        name: 'гость реально просит стол',
        turns: [{ role: 'guest', text: 'хочу забронировать стол' }],
        journal: [{ kind: 'tool', name: 'show_tables' }],
        guest: { first_name: 'Игорь' },
        guestlist: true,
        truth: { tableMode: true, instaAsked: false, followupDone: false },
    },
    {
        name: 'афиша (reels_url) — не follow-up',
        turns: [
            { role: 'guest', text: 'скинь афишу' },
            { role: 'sema', text: 'https://www.instagram.com/p/DUBJSn8DZW5/' },
        ],
        journal: [{ kind: 'sent', intent: 'venue_answer' }],
        guest: { first_name: 'Игорь' },
        guestlist: true,
        truth: { tableMode: false, instaAsked: false, followupDone: false },
    },
    {
        name: 'инста-зона упомянута — не вопрос про инсту',
        turns: [
            { role: 'guest', text: 'а фотозона будет?' },
            { role: 'sema', text: 'Да, там есть инста-зона, красиво выходит' },
        ],
        journal: [{ kind: 'sent', intent: 'venue_answer' }],
        guest: { first_name: 'Игорь' },
        guestlist: true,
        truth: { tableMode: false, instaAsked: false, followupDone: false },
    },
    {
        name: 'инсту реально спросили',
        turns: [{ role: 'sema', text: 'Скинь свой инстаграм' }],
        journal: [{ kind: 'sent', intent: 'ask_instagram' }],
        guest: { first_name: 'Игорь' },
        guestlist: true,
        truth: { tableMode: false, instaAsked: true, followupDone: false },
    },
    {
        name: 'follow-up реально отправлен',
        turns: [
            { role: 'sema', text: 'Буду рад если подпишешься' },
            { role: 'sema', text: 'Insta: https://www.instagram.com/weare.wrld/' },
        ],
        journal: [{ kind: 'sent', intent: 'insta_followup' }],
        guest: { first_name: 'Игорь', instagram: 'https://instagram.com/igor' },
        guestlist: true,
        truth: { tableMode: false, instaAsked: true, followupDone: true },
    },
];

const buildContext = (item: Case): ChatContext =>
    ({
        guest: {
            id: 'probe',
            wa_phone: '1',
            first_name: null,
            last_name: null,
            instagram: null,
            came_from: null,
            came_at: null,
            lang: 'ru',
            ...item.guest,
        },
        messages: item.turns.map(
            (turn, index): WaMessageStorage =>
                ({
                    id: String(index + 1),
                    wa_chat_phone: '1',
                    text: turn.text,
                    owner: turn.role,
                    sent_at: '2026-06-17 14:00:00',
                }) as WaMessageStorage,
        ),
        ownedGuestlist: item.guestlist
            ? ([{ party_id: 'lylo', guest_id: 'probe', booked_table: false }] as never)
            : [],
        now: 'Wednesday 2026-06-17 14:00:00',
    }) as ChatContext;

/** Источник A: сегодняшний прод — регексы внутри buildFlowState. */
const sourceRegex = (item: Case): Flags => {
    const state = Agent.buildFlowState(buildContext(item));
    return {
        tableMode: state.includes('[→] TABLE') || state.includes('[✓] table'),
        instaAsked: state.includes('[…] instagram — ALREADY ASKED'),
        followupDone: state.includes('[✓] instagram follow-up — sent'),
    };
};

/** Источник C: журнал событий + факты из БД. Никакого разбора текста. */
const sourceJournal = (item: Case): Flags => {
    const sent = new Set(item.journal.filter((e) => e.kind === 'sent').map((e) => e.intent));
    const tools = new Set(item.journal.filter((e) => e.kind === 'tool').map((e) => e.name));
    const followupDone = sent.has('insta_followup');
    return {
        tableMode: tools.has('show_tables') || tools.has('book_table'),
        // follow-up невозможен без собранной инсты — спрашивали точно
        instaAsked: sent.has('ask_instagram') || followupDone,
        followupDone,
    };
};

const KEYS = ['tableMode', 'instaAsked', 'followupDone'] as const;
const startedAt = process.hrtime();
const score = { regex: 0, journal: 0 };
const total = CASES.length * KEYS.length;

for (const item of CASES) {
    const regex = sourceRegex(item);
    const journal = sourceJournal(item);
    const notes: string[] = [];

    for (const key of KEYS) {
        if (regex[key] === item.truth[key]) score.regex++;
        else notes.push(`  A/регекс ${key}: ${regex[key]} ≠ ${item.truth[key]}`);
        if (journal[key] === item.truth[key]) score.journal++;
        else notes.push(`  C/журнал ${key}: ${journal[key]} ≠ ${item.truth[key]}`);
    }

    console.log(`${notes.length ? '❌' : '✅'} ${item.name}`);
    for (const note of notes) console.log(note);
}

const [sec, nano] = process.hrtime(startedAt);
console.log(
    `\n[probe3] A/регексы ${score.regex}/${total} · C/журнал ${score.journal}/${total} · ${sec}s ${Math.round(nano / 1e6)}ms`,
);
