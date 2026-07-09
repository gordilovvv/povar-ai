import type { DialogResult, SimGuest, Turn } from './harness.ts';

export interface Scenario {
    key: string;
    guest: Partial<SimGuest>;
    turns: string[];
    checks: Record<string, (r: DialogResult) => boolean>;
}

const semaTexts = (transcript: Turn[]): string[] =>
    transcript.filter((t) => t.role === 'sema').map((t) => t.text);

const instaAsks = (r: DialogResult): string[] =>
    semaTexts(r.transcript).filter(
        (t) => /инст|insta/i.test(t) && !/подпи|follow|weare|instagram\.com/i.test(t),
    );

const askedInstagram = (r: DialogResult): boolean => instaAsks(r).length > 0;

const followupSent = (r: DialogResult): boolean =>
    semaTexts(r.transcript).some((t) => t.includes('instagram.com'));

const NAME_ASK = /имя\s*(и\s*)?фамили|как тебя зовут|name and surname|your name/i;
const GUEST_NAME = /^[А-ЯЁA-Z][а-яёa-z]+\s+[А-ЯЁA-Z][а-яёa-z]+/;

// повтор имени = вредно, только если гость его УЖЕ прислал; до ответа один повтор ок (гость проигнорил)
const noNameRepeat = (r: DialogResult): boolean => {
    const t = r.transcript;
    const nameIdx = t.findIndex((x) => x.role === 'guest' && GUEST_NAME.test(x.text.trim()));
    const askIdxs = t
        .map((x, i) => ({ x, i }))
        .filter(({ x }) => x.role === 'sema' && NAME_ASK.test(x.text))
        .map(({ i }) => i);
    if (nameIdx !== -1 && askIdxs.some((i) => i > nameIdx)) return false;
    return askIdxs.length <= 2;
};

// первый же ответ агента (все пузыри до следующей реплики гостя) после вопроса про стол — о столе
const tableAddressedPromptly = (r: DialogResult): boolean => {
    const askIdx = r.transcript.findIndex((t) => t.role === 'guest' && /стол|table/i.test(t.text));
    if (askIdx === -1) return false;
    const bubbles: string[] = [];
    for (const turn of r.transcript.slice(askIdx + 1)) {
        if (turn.role === 'guest') break;
        bubbles.push(turn.text);
    }
    return bubbles.some((t) =>
        /стол|table|заброниров|book|сделаем|сколько вас|на скольких|зон|во сколько|какое время/i.test(
            t,
        ),
    );
};

const guestTableAskIdx = (r: DialogResult): number =>
    r.transcript.findIndex((t) => t.role === 'guest' && /стол|table/i.test(t.text));

// follow-up после вопроса о столе запрещён; до него — по флоу законен
const noFollowupAfterTableAsk = (r: DialogResult): boolean => {
    const askIdx = guestTableAskIdx(r);
    if (askIdx === -1) return true;
    return !r.transcript
        .slice(askIdx + 1)
        .some((t) => t.role === 'sema' && t.text.includes('instagram.com'));
};

// пузыри агента после первой реплики гостя, матчащей re, до следующей реплики гостя
const replyAfter = (r: DialogResult, re: RegExp): string[] => {
    const idx = r.transcript.findIndex((t) => t.role === 'guest' && re.test(t.text));
    if (idx === -1) return [];
    const bubbles: string[] = [];
    for (const turn of r.transcript.slice(idx + 1)) {
        if (turn.role === 'guest') break;
        bubbles.push(turn.text);
    }
    return bubbles;
};

const ALLOWED_LINKS =
    /instagram\.com\/weare\.wrld|instagram\.com\/p\/DUBJSn8DZW5|maps\.google\.com|maps\.app\.goo\.gl\/9UDyD7XRjTfQSzYy7|chat\.whatsapp\.com\/GZ2IIBdkm4W78CoqNtxayu/;

const noInventedLinks = (r: DialogResult): boolean =>
    !semaTexts(r.transcript).some((t) => /https?:\/\//i.test(t) && !ALLOWED_LINKS.test(t));

// бот не спихивает гостя гуглить адрес/меню — это провал заботы
const noGoogleDeflect = (r: DialogResult): boolean =>
    !semaTexts(r.transcript).some((t) =>
        /загугл|погугл|в гугл|в google|google it|search google/i.test(t),
    );

const mapLinkGiven = (r: DialogResult): boolean =>
    replyAfter(r, /гугл ?мапс|где наход|ссылк/i).some((t) => /maps\.app\.goo\.gl/i.test(t));

const TABLE_NUM = /\b(171|172|173|161|162)\b/g;

// не «простыня» в ПЕРВОМ ответе на общий вопрос о столах (назвать 2-3 свободных на конкретный вопрос — ок)
const noTableWall = (r: DialogResult): boolean =>
    !replyAfter(r, /про столы|какие столы|расскажи про стол/i).some(
        (t) => new Set(t.match(TABLE_NUM)).size >= 2,
    );

// никогда не «все столы заняты»
const neverAllTaken = (r: DialogResult): boolean =>
    !semaTexts(r.transcript).some((t) =>
        /все\s+стол\w*\s+занят|всё\s+занят|все\s+занят|all\s+tables?\s+(taken|booked|occupied)/i.test(
            t,
        ),
    );

const entryConditionsOnceAfterGuestlist = (r: DialogResult): boolean => {
    const texts = semaTexts(r.transcript);
    const priceIdx = texts.findIndex((t) => /дирхам|бесплатн/i.test(t));
    const mentions = texts.filter((t) => /дирхам|бесплатн/i.test(t)).length;
    if (mentions > 1) return false;
    if (priceIdx === -1) return true;
    const addedIdx = texts.findIndex((t) => /добавил|added/i.test(t));
    return addedIdx !== -1 && priceIdx >= addedIdx;
};

export const scenarios: Scenario[] = [
    {
        key: 's1-eager-closer',
        guest: { came_from: 'ad' },
        turns: [
            'Привет! Хочу на вечеринку COYA',
            'Игорь Гордилов',
            '@gordilov',
            'Спасибо бро, увидимся!',
        ],
        checks: {
            name_saved: (r) => !!r.state.guest.first_name,
            instagram_saved: (r) => !!r.state.guest.instagram_url,
            guestlist_added: (r) => r.state.guestlist.includes('coya'),
            instagram_pursued: askedInstagram,
            no_invented_links: noInventedLinks,
            no_name_repeat: noNameRepeat,
        },
    },
    {
        key: 's2-distraction',
        guest: { came_from: 'ad' },
        turns: ['Привет, хочу на COYA', 'Игорь Гордилов. А вход платный?', '@gordilov_igor', '❤️'],
        checks: {
            instagram_saved: (r) => !!r.state.guest.instagram_url,
            guestlist_added: (r) => r.state.guestlist.includes('coya'),
            followup_sent: followupSent,
            entry_conditions_ok: entryConditionsOnceAfterGuestlist,
            no_invented_links: noInventedLinks,
            no_name_repeat: noNameRepeat,
        },
    },
    {
        key: 's3-all-at-once',
        guest: {},
        turns: ['Привет! Я Игорь Гордилов, инста @gordilov, запиши меня на COYA плз', 'Красава ❤️'],
        checks: {
            name_saved: (r) => !!r.state.guest.first_name,
            instagram_saved: (r) => !!r.state.guest.instagram_url,
            guestlist_added: (r) => r.state.guestlist.includes('coya'),
            followup_sent: followupSent,
            no_invented_links: noInventedLinks,
        },
    },
    {
        key: 's4-table-detour',
        guest: { came_from: 'ad' },
        turns: [
            'Привет, хочу забронировать стол на COYA',
            'Нас будет 4, я Игорь Гордилов. Давай хай топ 172',
            'инста @gordilov',
        ],
        checks: {
            table_booked: (r) => r.state.bookedTables.includes('coya'),
            guestlist_added: (r) => r.state.guestlist.includes('coya'),
            instagram_saved: (r) => !!r.state.guest.instagram_url,
            table_addressed: tableAddressedPromptly,
            followup_skipped: (r) => !followupSent(r),
            no_invented_links: noInventedLinks,
            no_name_repeat: noNameRepeat,
        },
    },
    {
        key: 's7-table-interrupt',
        guest: { came_from: 'ad' },
        turns: [
            'Привет, хочу на COYA',
            'Игорь Гордилов',
            '@gordilov',
            'Слушай, а можно стол забронировать? Нас 6',
            'Да, бронируй хай топ 172',
        ],
        checks: {
            guestlist_added: (r) => r.state.guestlist.includes('coya'),
            table_addressed: tableAddressedPromptly,
            table_booked: (r) => r.state.bookedTables.includes('coya'),
            no_followup_after_table: noFollowupAfterTableAsk,
            no_invented_links: noInventedLinks,
            no_name_repeat: noNameRepeat,
        },
    },
    {
        key: 's5-insta-stall',
        guest: { came_from: 'ad' },
        turns: ['Привет, хочу на COYA', 'Игорь Гордилов', 'А дресскод есть?', 'Окей, понял'],
        checks: {
            // гость тянет с инстой → инста обязательна → в гест-лист НЕ добавлен
            guestlist_not_added: (r) => !r.state.guestlist.includes('coya'),
            instagram_pursued: askedInstagram,
            insta_not_spammed: (r) => instaAsks(r).length <= 3,
            no_invented_links: noInventedLinks,
            no_name_repeat: noNameRepeat,
        },
    },
    {
        key: 's6-ambiguous-party',
        guest: {},
        turns: ['Привет! Хочу на вечеринку', 'Давай COYA. Игорь Гордилов', '@gordilov', '❤️'],
        checks: {
            lineup_pitched: (r) =>
                semaTexts(r.transcript).some((t) => t.includes('COYA') && t.includes('LYLO')),
            guestlist_added: (r) => r.state.guestlist.includes('coya'),
            instagram_saved: (r) => !!r.state.guest.instagram_url,
            followup_sent: followupSent,
            no_invented_links: noInventedLinks,
            no_name_repeat: noNameRepeat,
        },
    },
    {
        key: 's8-tables-info',
        guest: { came_from: 'ad' },
        turns: [
            'Привет! Расскажи про столы на COYA',
            'А стол 171 свободен?',
            'Скинь карту столов ещё раз',
            'Понял, спасибо!',
        ],
        checks: {
            show_tables_called: (r) => r.state.toolCalls.some((c) => c.name === 'show_tables'),
            map_sent: (r) => r.state.mapSends >= 1,
            invited_to_pick: (r) =>
                replyAfter(r, /про столы/i).some((t) =>
                    /глянь|напиши|выбери|какой|номер|pick|which|нравится/i.test(t),
                ),
            no_table_wall: noTableWall,
            occupied_answered: (r) =>
                replyAfter(r, /171 свободен/i).some((t) => /занят|taken|не свободен/i.test(t)),
            never_all_taken: neverAllTaken,
            no_invented_links: noInventedLinks,
        },
    },
    {
        key: 's9-venue-real',
        guest: { came_from: 'ad' },
        turns: [
            'Привет! Хочу на LYLO',
            'Игорь Гордилов',
            'А там комфортно в заведении?',
            'Не жарко?',
            'А где находится?',
            'Можно ссылку на гугл мапс?',
            'А алкогольные напитки там есть? Еда? Борщ будет?',
            '@gordilov',
        ],
        checks: {
            guestlist_added: (r) => r.state.guestlist.includes('lylo'),
            no_google_deflect: noGoogleDeflect,
            map_link_given: mapLinkGiven,
            comfort_answered: (r) => replyAfter(r, /комфортно/i).length > 0,
            drinks_answered: (r) =>
                replyAfter(r, /алкогольные/i).some((t) => /коктейл|алкогол|бар|есть|вино/i.test(t)),
            no_invented_links: noInventedLinks,
            no_name_repeat: noNameRepeat,
        },
    },
    {
        key: 's11-poster',
        guest: { came_from: 'ad' },
        turns: ['Привет! Хочу на LYLO', 'Скинь афишу вечеринки', 'Игорь Гордилов', '@gordilov'],
        checks: {
            guestlist_added: (r) => r.state.guestlist.includes('lylo'),
            poster_sent: (r) =>
                replyAfter(r, /афиш/i).some((t) => /instagram\.com\/p\/DUBJSn8DZW5/i.test(t)),
            no_google_deflect: noGoogleDeflect,
            no_invented_links: noInventedLinks,
            no_name_repeat: noNameRepeat,
        },
    },
    {
        key: 's10-venue-en',
        guest: { came_from: 'ad', lang: 'en' },
        turns: [
            'Hey! I want to come to LYLO',
            "What's the vibe there?",
            'Where is it? can you drop the location',
            'John Carter',
            '@johnc',
        ],
        checks: {
            guestlist_added: (r) => r.state.guestlist.includes('lylo'),
            no_google_deflect: noGoogleDeflect,
            map_link_given: (r) =>
                replyAfter(r, /where is it|location/i).some((t) => /maps\.app\.goo\.gl/i.test(t)),
            no_invented_links: noInventedLinks,
        },
    },
];
