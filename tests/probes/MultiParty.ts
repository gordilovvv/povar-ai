// Проба: несколько вечеринок в промте, гость выбирает тестовую и доходит до конца воронки.
// Заводит тестовую вечеринку (party + party_time на сегодня) и удаляет её с гостем в finally и по SIGINT.
// Запуск: pnpm exec tsx --conditions=development --env-file=.env.dev tests/probes/MultiParty.ts [--quiet]
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

const HOUR = 60 * 60 * 1000;
const PARTY_ID = `test_loft_${ulid().toLowerCase()}`;
const PARTY_NAME = 'Test Loft';
const MAP_LINK = 'https://maps.app.goo.gl/test-loft';
const PARTY_START = new Date(Date.now() + 2 * HOUR);
const FREE_ENTRY_BEFORE = new Date(PARTY_START.getTime() + HOUR);

const GUEST_LINES = [
    'Привет! Какие вечеринки на этой неделе?',
    `Давай в ${PARTY_NAME}, запиши меня`,
    'Иван Тестов',
    '@ivan_test',
    'Нет, стол не нужен',
];
const NAME_TURN = GUEST_LINES.indexOf('Иван Тестов');

const WHITE = '\x1b[97m';
const RED = '\x1b[91m';
const GRAY = '\x1b[90m';
const YELLOW = '\x1b[93m';
const RESET = '\x1b[0m';

if (env.WA_SEND === 'on') {
    console.error('WA_SEND=on — проба шлёт в реальный WhatsApp, запускай с WA_SEND=off');
    process.exit(1);
}

const phone = `multiparty_${ulid()}`;

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
            values ($1, 'owned', $2, 50, 'Test Loft, Al Quoz', $3, $4)`,
            [
                PARTY_ID,
                PARTY_NAME,
                MAP_LINK,
                `Тестовая вечеринка. Старт через два часа, конец 03:00. Гест-лист работает первый час после старта, потом вход 50 AED. Дресс-код: любой. Инструкция для бота: как только добавил гостя в гест-лист — обязательно пришли ему адрес и ссылку на google maps (${MAP_LINK}).`,
            ],
        );
        await client.query(
            'insert into party_time (party_id, party_start_at, free_entry_before) values ($1, $2, $3)',
            [PARTY_ID, PARTY_START, FREE_ENTRY_BEFORE],
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

const checkDb = async () => {
    const client = await pool.connect();
    try {
        const guest = (
            await client.query(
                'select id, first_name, last_name, instagram from guests where wa_phone = $1',
                [phone],
            )
        ).rows[0];
        const entries = (
            await client.query(
                'select party_id, booked_table from party_guestlist where guest_id = $1',
                [guest.id],
            )
        ).rows;
        const nameOk = guest.first_name === 'Иван' && guest.last_name === 'Тестов';
        const igOk = guest.instagram != null && guest.instagram !== '';
        const onTest = entries.some((row) => row.party_id === PARTY_ID);
        const onlyTest = entries.length === 1 && onTest;
        const tableOk = entries[0]?.booked_table === false;
        console.log(
            `${YELLOW}[БД] guests: ${guest.first_name} ${guest.last_name} → ${nameOk ? 'OK' : 'FAIL'}; instagram=${guest.instagram} → ${igOk ? 'OK' : 'FAIL'}${RESET}`,
        );
        console.log(
            `${YELLOW}[БД] party_guestlist: ${entries.map((row) => row.party_id).join(', ') || 'нет'} → ${onlyTest ? 'OK (только тестовая)' : 'FAIL'}; booked_table=${entries[0]?.booked_table} → ${tableOk ? 'OK' : 'FAIL'}${RESET}`,
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
    let mapSentAfterList = false;
    for (const [index, line] of GUEST_LINES.entries()) {
        console.log(`\n${WHITE}гость: ${line}${RESET}`);
        await persist('guest', line);
        turnCalls = [];

        const start = process.hrtime.bigint();
        const replies = await new Agent(phone, create).do();
        const ms = Number(process.hrtime.bigint() - start) / 1e6;

        for (const reply of replies) {
            console.log(`${RED}бот:   ${reply.split('\n').join(`\n${RED}       `)}${RESET}`);
            await persist('sema', reply);
            // ссылка по инструкции из notes: только после хода с именем (гость уже в списке)
            if (index >= NAME_TURN && reply.includes(MAP_LINK)) {
                mapSentAfterList = true;
            }
        }
        if (!replies.length) {
            console.log(`${RED}бот:   (молчит)${RESET}`);
        }
        console.log(
            `${GRAY}${Math.floor(ms / 1000)}s ${Math.round(ms % 1000)}ms | шагов ${turnCalls.length}: ${turnCalls.join(' → ')}${RESET}`,
        );
    }
    await checkDb();
    console.log(
        `${YELLOW}[notes] ссылка на карту после добавления в гест-лист → ${mapSentAfterList ? 'OK' : 'FAIL'}${RESET}`,
    );
    console.log(
        `${YELLOW}[токены] input=${usage.input} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite} output=${usage.output}${RESET}`,
    );
} finally {
    await cleanup();
    await pool.end();
}
