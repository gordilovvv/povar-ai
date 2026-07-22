// Диалоговая проба: гонит реплики гостя через реального Agent по очереди,
// печатает переписку в консоль (гость белый, бот красный) и время ответа.
// Запуск: pnpm exec tsx --conditions=development --env-file=.env.dev tests/probes/Dialog.ts
// Флаг --quiet глушит логгер (info/debug/warn), остаётся только переписка и ошибки.
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

const turnsArg = process.argv.find((arg) => arg.startsWith('--turns='));
const turns = turnsArg ? Number(turnsArg.split('=')[1]) : null;

const GUEST_LINES = [
    'Привет!',
    'А какие сегодня вечеринки есть?',
    'Сколько стоит вход?',
    'А где это находится?',
    'Запиши меня',
    'Иван Тестов',
    '@ivan_test',
    'Нет, стол не нужен',
];

const WHITE = '\x1b[97m';
const RED = '\x1b[91m';
const GRAY = '\x1b[90m';
const YELLOW = '\x1b[93m';
const RESET = '\x1b[0m';

if (env.WA_SEND === 'on') {
    console.error('WA_SEND=on — проба шлёт в реальный WhatsApp, запускай с WA_SEND=off');
    process.exit(1);
}

const phone = `dialog_${ulid()}`;

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const countingCreate = async (params: Anthropic.MessageCreateParamsNonStreaming) => {
    const response = await anthropic.messages.create(params);
    usage.input += response.usage.input_tokens;
    usage.output += response.usage.output_tokens;
    usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
    usage.cacheWrite += response.usage.cache_creation_input_tokens ?? 0;
    return response;
};

const seed = async () => {
    const client = await pool.connect();
    try {
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
        // прод ставит её при реальной отправке; без неё state-блок вечно видит «not greeted»
        if (owner === 'sema') {
            await updateWaChatLastSent(client, phone, now);
        }
    } finally {
        client.release();
    }
};

const checkGuestlist = async () => {
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
                'select party_id, joined_at from party_guestlist where guest_id = $1',
                [guest.id],
            )
        ).rows;
        const nameOk = guest.first_name === 'Иван' && guest.last_name === 'Тестов';
        const igOk = guest.instagram != null && guest.instagram !== '';
        const listed = entries.length > 0;
        console.log(
            `${YELLOW}[БД] guests: first_name=${guest.first_name} last_name=${guest.last_name} → ${nameOk ? 'OK' : 'FAIL'}${RESET}`,
        );
        console.log(
            `${YELLOW}[БД] guests: instagram=${guest.instagram} → ${igOk ? 'OK' : 'FAIL'}${RESET}`,
        );
        console.log(
            `${YELLOW}[БД] party_guestlist: ${listed ? `в списке (party_id=${entries[0].party_id}, joined_at=${entries[0].joined_at}) → OK` : 'строки нет → FAIL'}${RESET}`,
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
            'delete from party_guestlist where guest_id in (select id from guests where wa_phone = $1)',
            [phone],
        );
        await client.query('delete from wa_chats where wa_phone = $1', [phone]);
        await client.query('delete from guests where wa_phone = $1', [phone]);
    } finally {
        client.release();
    }
};

await seed();
try {
    for (const line of turns ? GUEST_LINES.slice(0, turns) : GUEST_LINES) {
        console.log(`\n${WHITE}гость: ${line}${RESET}`);
        await persist('guest', line);

        const start = process.hrtime.bigint();
        const replies = await new Agent(phone, countingCreate).do();
        const ms = Number(process.hrtime.bigint() - start) / 1e6;

        for (const reply of replies) {
            console.log(`${RED}бот:   ${reply.split('\n').join(`\n${RED}       `)}${RESET}`);
            await persist('sema', reply);
        }
        if (!replies.length) {
            console.log(`${RED}бот:   (молчит)${RESET}`);
        }
        console.log(`${GRAY}думал ${Math.floor(ms / 1000)}s ${Math.round(ms % 1000)}ms${RESET}`);
    }
    await checkGuestlist();
    console.log(
        `${YELLOW}[токены] input=${usage.input} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite} output=${usage.output} | всего=${usage.input + usage.cacheRead + usage.cacheWrite + usage.output}${RESET}`,
    );
} finally {
    await cleanup();
    await pool.end();
}
