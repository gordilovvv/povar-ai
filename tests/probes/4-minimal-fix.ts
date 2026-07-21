/**
 * Проба 4: оспариваем идею «журнал» — сколько чинится вообще без новой инфраструктуры.
 * Источник D: только то, чем мы уже владеем — вызовы тулов и точный asset-URL.
 * Цель — узнать, за какой из флагов реально приходится платить журналом.
 */

interface Flags {
    tableMode: boolean;
    instaAsked: boolean;
    followupDone: boolean;
}

const ASSET_INSTAGRAM = 'https://www.instagram.com/weare.wrld/';
const REELS = 'https://www.instagram.com/p/DUBJSn8DZW5/';

interface Case {
    name: string;
    semaTexts: string[];
    guestTexts: string[];
    toolCalls: string[];
    truth: Flags;
}

const CASES: Case[] = [
    {
        name: 'вопрос про комфорт',
        semaTexts: ['Внутри прохладно, комфортно'],
        guestTexts: ['is it comfortable inside?'],
        toolCalls: [],
        truth: { tableMode: false, instaAsked: false, followupDone: false },
    },
    {
        name: '«столько людей будет?»',
        semaTexts: ['Обычно человек 200'],
        guestTexts: ['а столько людей будет?'],
        toolCalls: [],
        truth: { tableMode: false, instaAsked: false, followupDone: false },
    },
    {
        name: 'гость реально просит стол',
        semaTexts: ['Скинул карту'],
        guestTexts: ['хочу забронировать стол'],
        toolCalls: ['show_tables'],
        truth: { tableMode: true, instaAsked: false, followupDone: false },
    },
    {
        name: 'афиша (reels) — не follow-up',
        semaTexts: [REELS],
        guestTexts: ['скинь афишу'],
        toolCalls: ['get_parties'],
        truth: { tableMode: false, instaAsked: false, followupDone: false },
    },
    {
        name: 'инста-зона упомянута',
        semaTexts: ['Да, там есть инста-зона'],
        guestTexts: ['а фотозона будет?'],
        toolCalls: [],
        truth: { tableMode: false, instaAsked: false, followupDone: false },
    },
    {
        name: 'инсту реально спросили',
        semaTexts: ['Скинь свой инстаграм'],
        guestTexts: [],
        toolCalls: [],
        truth: { tableMode: false, instaAsked: true, followupDone: false },
    },
    {
        name: 'follow-up реально отправлен',
        semaTexts: [`Буду рад если подпишешься`, `Insta: ${ASSET_INSTAGRAM}`],
        guestTexts: [],
        toolCalls: [],
        truth: { tableMode: false, instaAsked: true, followupDone: true },
    },
];

/** Источник A — как в проде сегодня. */
const sourceRegex = (item: Case): Flags => {
    const followupDone = item.semaTexts.some((t) => t.includes('instagram.com'));
    const instaAsked = item.semaTexts.some(
        (t) => /инст|insta/i.test(t) && !/подпи|follow|instagram\.com/i.test(t),
    );
    return {
        tableMode: item.guestTexts.some((t) => /стол|table/i.test(t)),
        instaAsked,
        followupDone,
    };
};

/** Источник D — только факты, которыми мы уже владеем. Никаких новых колонок. */
const sourceFacts = (item: Case): Flags => ({
    // стол обсуждается только если мы реально показали карту или забронировали
    tableMode: item.toolCalls.includes('show_tables') || item.toolCalls.includes('book_table'),
    // честно: этот флаг фактами не берётся — за него платим журналом
    instaAsked: false,
    // точный asset-URL, а не подстрока instagram.com — афиша живёт на другом URL
    followupDone: item.semaTexts.some((t) => t.includes(ASSET_INSTAGRAM)),
});

const KEYS = ['tableMode', 'instaAsked', 'followupDone'] as const;
const startedAt = process.hrtime();
const score = { regex: 0, facts: 0 };
const missBy = { regex: {} as Record<string, number>, facts: {} as Record<string, number> };
const total = CASES.length * KEYS.length;

for (const item of CASES) {
    const regex = sourceRegex(item);
    const facts = sourceFacts(item);
    const notes: string[] = [];

    for (const key of KEYS) {
        if (regex[key] === item.truth[key]) score.regex++;
        else {
            missBy.regex[key] = (missBy.regex[key] ?? 0) + 1;
            notes.push(`  A/регекс ${key}: ${regex[key]} ≠ ${item.truth[key]}`);
        }
        if (facts[key] === item.truth[key]) score.facts++;
        else {
            missBy.facts[key] = (missBy.facts[key] ?? 0) + 1;
            notes.push(`  D/факты ${key}: ${facts[key]} ≠ ${item.truth[key]}`);
        }
    }

    console.log(`${notes.length ? '❌' : '✅'} ${item.name}`);
    for (const note of notes) console.log(note);
}

const [sec, nano] = process.hrtime(startedAt);
console.log(`\n[probe4] A/регексы ${score.regex}/${total} · D/факты ${score.facts}/${total}`);
console.log(`  промахи A по флагам: ${JSON.stringify(missBy.regex)}`);
console.log(`  промахи D по флагам: ${JSON.stringify(missBy.facts)}`);
console.log(`  ${sec}s ${Math.round(nano / 1e6)}ms`);
