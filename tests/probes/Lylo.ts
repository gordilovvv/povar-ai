// Проба: notes We Are x LYLO — кастомная фраза гест-листа, ссылка + сообщение после записи (оно же предложение стола), факты (сет Сёмы, кухня).
// Заводит временную копию вечеринки (старт сегодня 22:00 по Дубаю) и удаляет её с гостем в finally и по SIGINT.
// Запуск: pnpm exec tsx --conditions=development --env-file=.env.dev tests/probes/Lylo.ts [--quiet]
import Anthropic from '@anthropic-ai/sdk';
import { ulid } from 'ulid';
import { insertGuest } from '#Db/Guests.js';
import { pool } from '#Db/Pool.js';
import { updateWaChatLastSent, upsertWaChat } from '#Db/WaChats.js';
import { insertWaMessage } from '#Db/WaMessages.js';
import { env } from '#environment.js';
import { Agent } from '#Intelligence/Agent.js';
import { toDateTime } from '#Lib/Fmt.js';
import { Logger } from '#Lib/Logger.js';

if (process.argv.includes('--quiet')) {
    Logger.log = () => {};
    Logger.logWarn = () => {};
    Logger.debug = () => {};
}

const PARTY_ID = `test_lylo_${ulid().toLowerCase()}`;
const MAP_LINK = 'https://maps.app.goo.gl/ouDGGaTG8dL14siv5';
const DUBAI_OFFSET_MS = 4 * 60 * 60 * 1000;
const dubaiToday = new Date(Date.now() + DUBAI_OFFSET_MS).toISOString().slice(0, 10);
const PARTY_START = new Date(`${dubaiToday}T22:00:00+04:00`);
const PARTY_END = new Date(PARTY_START.getTime() + 5 * 60 * 60 * 1000);
const FREE_ENTRY_BEFORE = new Date(PARTY_START.getTime() + 3 * 60 * 60 * 1000);
const NOTES = `Сегодня. Старт 22:00, конец 03:00. Вход всю ночь 100 AED, включает один напиток на баре. Для девушек вход бесплатный всю ночь и безлимит по вину до 01:00. Гест-лист: бесплатный вход только для смешанных компаний от двух человек и для девушек, работает до 01:00; для остальных вход платный 100 AED. Одиночный парень в списке — вход не гарантирован. В день вечеринки список собирается до 21:00, после закрывается — никого не добавляем, только платный вход на месте. Диджеи этой ночи: Povar, Millerusha, Monta, KMZ, Sintea. Сёма (Povar) играет в 23:59. Дресс-код: Smart Casual, без пляжного и спортивного. Площадка: секретный клуб внутри ресторана Canary Beach, интересный интерьер и высокий уровень сервиса. Кухни в клубе нет, только в ресторане при площадке, работает до 00:00. Кальянов нет. Столы: уютные столы с депозитной системой, детали — у Сёмы.
Инструкции боту. Вместо стандартного предложения гест-листа отправь два сообщения подряд, дословно. Первое: «Гостевой список только для смешанных компаний и девочек. Для остальных вход платный 100 AED (включая один напиток на баре). Даже если случайно пробьёшься в список один, это не гарантирует вход.» Второе, отдельным сообщением: «Добавить тебя и твоих друзей в гостевой список?» Как только добавил гостя в гест-лист — обязательно пришли ему адрес площадки и ссылку на google maps, и следом одним сообщением дословно: «Гостевой список для компаний работает до 01 ночи, успевайте. Для девочек бесплатно всю ночь. Дресс-код Smart Casual, без спортивных и пляжных элементов. Также, на площадке есть уютные столы с депозитной системой, хочешь забронировать и узнать подробнее?» — это сообщение и есть предложение стола.`;

const GUEST_LINES = [
    'Привет! Что на этой неделе?',
    'Запиши меня на сегодня',
    'Нас двое, я и моя девушка. Иван Тестов и Мария Тестова',
    '@ivan_test',
    'Во сколько играет Сёма?',
    'А кухня там есть?',
    'А до скольки мероприятие?',
    'Нет, стол не нужен',
];
const OFFER_TURN = GUEST_LINES.indexOf('Запиши меня на сегодня');
const NAME_TURN = OFFER_TURN + 1;
const END_TURN = GUEST_LINES.indexOf('А до скольки мероприятие?');

const WHITE = '\x1b[97m';
const RED = '\x1b[91m';
const GRAY = '\x1b[90m';
const YELLOW = '\x1b[93m';
const RESET = '\x1b[0m';

if (env.WA_SEND === 'on') {
    console.error('WA_SEND=on — проба шлёт в реальный WhatsApp, запускай с WA_SEND=off');
    process.exit(1);
}

const phone = `lylo_${ulid()}`;

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
let turnCalls: string[] = [];

const create = async (params: Anthropic.MessageCreateParamsNonStreaming) => {
    const response = await anthropic.messages.create(params);
    usage.input += response.usage.input_tokens;
    usage.output += response.usage.output_tokens;
    usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
    usage.cacheWrite += response.usage.cache_creation_input_tokens ?? 0;
    const names = response.content.flatMap((block) =>
        block.type === 'tool_use' ? [block.name] : [],
    );
    turnCalls.push(names.length ? names.join('+') : '(text)');
    return response;
};

const seed = async () => {
    const client = await pool.connect();
    try {
        await client.query(
            `insert into party (id, type, name, price, location, google_map_link, notes)
            values ($1, 'owned', 'We Are x LYLO', 100, 'LYLO, ресторан Canary Beach', $2, $3)`,
            [PARTY_ID, MAP_LINK, NOTES],
        );
        await client.query(
            'insert into party_time (party_id, party_start_at, party_end_at, free_entry_before) values ($1, $2, $3, $4)',
            [PARTY_ID, PARTY_START, PARTY_END, FREE_ENTRY_BEFORE],
        );
        await insertGuest(client, {
            id: ulid(),
            wa_phone: phone,
            first_name: null,
            last_name: null,
            instagram: null,
            came_from: 'manual',
            came_at: toDateTime(new Date()),
            lang: null,
            instagram_asked_at: null,
            marketing_enable: true,
        });
        const guestId = (await client.query('select id from guests where wa_phone = $1', [phone]))
            .rows[0].id;
        await upsertWaChat(client, phone, guestId, new Date());
    } finally {
        client.release();
    }
};

const persist = async (owner: 'guest' | 'sema', text: string) => {
    const client = await pool.connect();
    try {
        const now = new Date();
        await insertWaMessage(client, {
            id: ulid(),
            wa_message_id: null,
            wa_chat_phone: phone,
            text,
            owner,
            status: 'idle',
            worker_status: owner === 'guest' ? 'processed' : null,
            concurrency_version: 0,
            sent_at: now,
        });
        if (owner === 'sema') {
            await updateWaChatLastSent(client, phone, now);
        }
    } finally {
        client.release();
    }
};

const selectEntry = async () => {
    const client = await pool.connect();
    try {
        return (
            await client.query(
                `select friends, table_offered_at, booked_table from party_guestlist
                where party_id = $1 and guest_id = (select id from guests where wa_phone = $2)`,
                [PARTY_ID, phone],
            )
        ).rows[0];
    } finally {
        client.release();
    }
};

const checkDb = async () => {
    const client = await pool.connect();
    try {
        const guest = (
            await client.query(
                'select first_name, last_name, instagram from guests where wa_phone = $1',
                [phone],
            )
        ).rows[0];
        const entry = await selectEntry();
        const nameOk = guest.first_name === 'Иван' && guest.last_name === 'Тестов';
        const friendsOk = entry?.friends?.length === 1 && entry.friends[0] === 'Мария Тестова';
        console.log(
            `${YELLOW}[БД] guests: ${guest.first_name} ${guest.last_name} → ${nameOk ? 'OK' : 'FAIL'}; instagram=${guest.instagram} → ${guest.instagram ? 'OK' : 'FAIL'}${RESET}`,
        );
        console.log(
            `${YELLOW}[БД] party_guestlist: ${entry ? 'в списке' : 'строки нет → FAIL'}; friends=${JSON.stringify(entry?.friends)} → ${friendsOk ? 'OK' : 'FAIL'}; booked_table=${entry?.booked_table} → ${entry?.booked_table === false ? 'OK' : 'FAIL'}${RESET}`,
        );
    } finally {
        client.release();
    }
};

const cleanup = async () => {
    const client = await pool.connect();
    try {
        await client.query('delete from wa_messages where wa_chat_phone = $1', [phone]);
        await client.query(
            'delete from party_guestlist where guest_id in (select id from guests where wa_phone = $1) or party_id = $2',
            [phone, PARTY_ID],
        );
        await client.query('delete from wa_chats where wa_phone = $1', [phone]);
        await client.query('delete from guests where wa_phone = $1', [phone]);
        await client.query('delete from party_time where party_id = $1', [PARTY_ID]);
        await client.query('delete from party where id = $1', [PARTY_ID]);
    } finally {
        client.release();
    }
};

process.once('SIGINT', async () => {
    console.log(`\n${GRAY}прервано — чищу тестовые данные${RESET}`);
    await cleanup();
    await pool.end();
    process.exit(130);
});

await seed();
try {
    console.log(
        `${GRAY}[тестовая вечеринка] ${PARTY_ID}, старт ${PARTY_START.toISOString()}${RESET}`,
    );
    let customOffer = false;
    let offerHasQuestion = false;
    let separateQuestion = false;
    let mapAfterList = false;
    let afterListMessage = false;
    let tableOfferedSameTurn = false;
    let endTimeNamed = false;
    let endTimePaused = false;
    const turnsArg = process.argv.find((arg) => arg.startsWith('--turns='));
    const turns = turnsArg ? Number(turnsArg.slice('--turns='.length)) : GUEST_LINES.length;
    for (const [index, line] of GUEST_LINES.slice(0, turns).entries()) {
        console.log(`\n${WHITE}гость: ${line}${RESET}`);
        await persist('guest', line);
        turnCalls = [];

        const start = process.hrtime.bigint();
        const replies = await new Agent(phone, create).do();
        const ms = Number(process.hrtime.bigint() - start) / 1e6;

        for (const reply of replies) {
            console.log(`${RED}бот:   ${reply.split('\n').join(`\n${RED}       `)}${RESET}`);
            await persist('sema', reply);
            if (index === OFFER_TURN && reply.includes('не гарантирует вход')) {
                customOffer = true;
                offerHasQuestion = reply.includes('Добавить тебя');
            }
            if (
                index === OFFER_TURN &&
                !reply.includes('не гарантирует вход') &&
                reply.includes('Добавить тебя и твоих друзей в гостевой список')
            ) {
                separateQuestion = true;
            }
            if (index === NAME_TURN && reply.includes(MAP_LINK)) {
                mapAfterList = true;
            }
            if (index === NAME_TURN && reply.includes('депозитной системой')) {
                afterListMessage = true;
            }
            if (index === END_TURN && /0?3[:.]00|трёх|три/i.test(reply)) {
                endTimeNamed = true;
            }
        }
        if (!replies.length) {
            console.log(`${RED}бот:   (молчит)${RESET}`);
        }
        if (index === END_TURN) {
            endTimePaused = turnCalls.some((call) => call.includes('pause_chat'));
        }
        if (index === NAME_TURN) {
            tableOfferedSameTurn = !!(await selectEntry())?.table_offered_at;
        }
        console.log(
            `${GRAY}${Math.floor(ms / 1000)}s ${Math.round(ms % 1000)}ms | шагов ${turnCalls.length}: ${turnCalls.join(' → ')}${RESET}`,
        );
    }
    await checkDb();
    console.log(
        `${YELLOW}[notes] фраза гест-листа из notes на «Запиши меня» → ${customOffer ? 'OK' : 'FAIL'}; вопрос отдельным сообщением → ${separateQuestion && !offerHasQuestion ? 'OK' : 'FAIL'}${RESET}`,
    );
    console.log(
        `${YELLOW}[notes] ссылка на карту после записи → ${mapAfterList ? 'OK' : 'FAIL'}; сообщение после записи (столы) → ${afterListMessage ? 'OK' : 'FAIL'}; table_offered в том же ходу → ${tableOfferedSameTurn ? 'OK' : 'FAIL'}${RESET}`,
    );
    console.log(
        `${YELLOW}[notes] конец вечеринки из notes на «до скольки» → ${endTimeNamed && !endTimePaused ? 'OK' : 'FAIL'} (назван ${endTimeNamed}, пауза ${endTimePaused})${RESET}`,
    );
    console.log(
        `${YELLOW}[токены] input=${usage.input} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite} output=${usage.output}${RESET}`,
    );
} finally {
    await cleanup();
    await pool.end();
}
