/**
 * Проба идеи 1: «состояние диалога, выведенное регексами, врёт».
 * Гоняем Agent.buildFlowState на транскриптах, где истина известна заранее,
 * и считаем расхождения. API не дёргаем — чистая функция.
 */
import type { PartyGuestlistStorage } from '#Db/Guestlist.js';
import type { GuestStorage } from '#Db/Guests.js';
import type { WaMessageStorage } from '#Db/WaMessages.js';
import { Agent, type ChatContext } from '#Intelligence/Agent.js';

interface Turn {
    role: 'guest' | 'sema';
    text: string;
}

interface Case {
    name: string;
    turns: Turn[];
    guest?: Partial<GuestStorage>;
    guestlist?: boolean;
    /** что должно быть в flow-state по смыслу диалога */
    expect: { tableMode?: boolean; instaAsked?: boolean; followupDone?: boolean };
}

const CASES: Case[] = [
    {
        name: 'гость спросил про комфорт («is it comfortable inside?»)',
        turns: [
            { role: 'guest', text: 'hey' },
            { role: 'sema', text: 'Hey! Glad you wrote' },
            { role: 'guest', text: 'is it comfortable inside? i hate hot places' },
        ],
        expect: { tableMode: false },
    },
    {
        name: 'гость спросил про наличие мест («are tickets available?»)',
        turns: [{ role: 'guest', text: 'are tickets still available?' }],
        expect: { tableMode: false },
    },
    {
        name: 'гость спросил «столько людей будет?»',
        turns: [{ role: 'guest', text: 'а столько людей будет на вечеринке?' }],
        expect: { tableMode: false },
    },
    {
        name: 'гость реально просит стол',
        turns: [{ role: 'guest', text: 'хочу забронировать стол' }],
        expect: { tableMode: true },
    },
    {
        name: 'сёма прислал афишу (reels_url) — это не insta follow-up',
        turns: [
            { role: 'guest', text: 'скинь афишу' },
            { role: 'sema', text: 'https://www.instagram.com/p/DUBJSn8DZW5/' },
        ],
        guest: { first_name: 'Игорь' },
        guestlist: true,
        expect: { followupDone: false },
    },
    {
        name: 'сёма упомянул инсту не как вопрос («инста-зона есть»)',
        turns: [
            { role: 'guest', text: 'а фотозона будет?' },
            { role: 'sema', text: 'Да, там есть инста-зона, красиво выходит' },
        ],
        guest: { first_name: 'Игорь' },
        guestlist: true,
        expect: { instaAsked: false },
    },
    {
        name: 'сёма реально спросил инсту',
        turns: [{ role: 'sema', text: 'Скинь свой инстаграм' }],
        guest: { first_name: 'Игорь' },
        guestlist: true,
        expect: { instaAsked: true },
    },
];

const buildContext = (item: Case): ChatContext => ({
    guest: {
        id: 'probe',
        wa_phone: '10000000000',
        first_name: null,
        last_name: null,
        instagram: null,
        came_from: null,
        came_at: null,
        lang: 'ru',
        ...item.guest,
    } as GuestStorage,
    messages: item.turns.map(
        (turn, index): WaMessageStorage =>
            ({
                id: String(index + 1),
                wa_message_id: null,
                wa_chat_phone: '10000000000',
                text: turn.text,
                owner: turn.role,
                status: 'sent',
                worker_status: null,
                concurrency_version: 0,
                sent_at: '2026-06-17 14:00:00',
            }) as WaMessageStorage,
    ),
    ownedGuestlist: item.guestlist
        ? ([
              { party_id: 'lylo', guest_id: 'probe', booked_table: false },
          ] as PartyGuestlistStorage[])
        : [],
    now: 'Wednesday 2026-06-17 14:00:00',
});

const startedAt = process.hrtime();
let failures = 0;

for (const item of CASES) {
    const state = Agent.buildFlowState(buildContext(item));

    const actual = {
        tableMode: state.includes('[→] TABLE') || state.includes('[✓] table'),
        instaAsked: state.includes('[…] instagram — ALREADY ASKED'),
        followupDone: state.includes('[✓] instagram follow-up — sent'),
    };

    const bad: string[] = [];
    for (const key of ['tableMode', 'instaAsked', 'followupDone'] as const) {
        const want = item.expect[key];
        if (want !== undefined && want !== actual[key]) {
            bad.push(`${key}: ожидали ${want}, регекс дал ${actual[key]}`);
        }
    }

    if (bad.length) {
        failures++;
        console.log(`❌ ${item.name}`);
        for (const line of bad) console.log(`     ${line}`);
    } else {
        console.log(`✅ ${item.name}`);
    }
}

const [sec, nano] = process.hrtime(startedAt);
console.log(
    `\n[probe1] ${CASES.length - failures}/${CASES.length} совпали, ${failures} расхождений, ${sec}s ${Math.round(nano / 1e6)}ms`,
);
