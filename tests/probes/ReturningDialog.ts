// Диалоговая проба повторного гостя: сажает в базу прошлую вечеринку с записью гостя
// и переписку той воронки, потом гонит новые реплики через реального Agent.
// Запуск: pnpm exec tsx --conditions=development --env-file=.env.dev tests/probes/ReturningDialog.ts
// Флаг --quiet глушит логгер (info/debug/warn), остаётся только переписка и ошибки.
import { ulid } from 'ulid';
import { insertGuestlistEntry, updateGuestlistTableAnswer } from '#Db/Guestlist.js';
import { insertGuest } from '#Db/Guests.js';
import { selectPastPartiesByGuest } from '#Db/Party.js';
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
    'Йо, какие тусовки будут?',
    'давай',
    'с друзьями, нас трое',
    'Анна и Макс',
    'Анна Петрова, Макс Иванов',
    'не, стол не нужен',
];

// прошлая воронка целиком: её питч, запись и отказ от стола относятся к прошедшей вечеринке
const PAST_CHAT: { owner: 'guest' | 'sema'; text: string }[] = [
    { owner: 'guest', text: 'Привет' },
    { owner: 'sema', text: 'Привет! Это AI-бот — помощник Сёмы Повара.' },
    { owner: 'guest', text: 'Какие вечеринки будут' },
    { owner: 'sema', text: 'На этой неделе я выступаю в Surf Club\nсуббота, 25 июля, 22:30' },
    { owner: 'guest', text: 'Добавь в списки пожалуйста' },
    { owner: 'sema', text: 'Запишу тебя в гест-лист, пришли имя и фамилию' },
    { owner: 'guest', text: 'Test User' },
    { owner: 'sema', text: 'Test, ты в гест-листе на Surf Club. Вход бесплатный — до 22:30.' },
    { owner: 'sema', text: 'Пришли ещё свой инстаграм' },
    { owner: 'guest', text: '@testuser' },
    { owner: 'sema', text: 'Кстати, может хочешь столик?' },
    { owner: 'guest', text: 'Нет, спасибо' },
];

const PAST_PARTY_ID = 'surf_club';
const DAY_MS = 24 * 60 * 60 * 1000;

const WHITE = '\x1b[97m';
const RED = '\x1b[91m';
const GRAY = '\x1b[90m';
const YELLOW = '\x1b[93m';
const RESET = '\x1b[0m';

if (env.WA_SEND === 'on') {
    console.error('WA_SEND=on — проба шлёт в реальный WhatsApp, запускай с WA_SEND=off');
    process.exit(1);
}

const phone = `returning_${ulid()}`;
const guestId = ulid();

const seed = async () => {
    const client = await pool.connect();
    try {
        const joinedAt = toDateTime(Date.now() - 20 * DAY_MS);
        await insertGuest(client, {
            id: guestId,
            wa_phone: phone,
            first_name: 'Test',
            last_name: 'User',
            instagram: '@testuser',
            came_from: 'manual',
            came_at: joinedAt,
            lang: 'ru',
            instagram_asked_at: joinedAt,
        });
        await insertGuestlistEntry(client, PAST_PARTY_ID, guestId, joinedAt);
        await updateGuestlistTableAnswer(client, PAST_PARTY_ID, guestId, false, joinedAt);

        // прошлая переписка ложится вчерашним днём: приветствие должно вернуться в новых сутках
        const base = Date.now() - DAY_MS;
        await upsertWaChat(client, phone, guestId, new Date(base));
        for (const [index, message] of PAST_CHAT.entries()) {
            await persist(message.owner, message.text, new Date(base + index * 60_000));
        }

        const past = await selectPastPartiesByGuest(client, guestId);
        console.log(
            `${YELLOW}[БД] прошлые вечеринки гостя: ${past.map((party) => party.name).join(', ') || 'нет'}${RESET}`,
        );
    } finally {
        client.release();
    }
};

const persist = async (owner: 'guest' | 'sema', text: string, at = new Date()) => {
    const client = await pool.connect();
    try {
        await insertWaMessage(client, {
            id: ulid(),
            wa_message_id: null,
            wa_chat_phone: phone,
            text,
            owner,
            status: 'idle',
            worker_status: owner === 'guest' ? 'processed' : null,
            concurrency_version: 0,
            sent_at: at,
        });
        if (owner === 'sema') {
            await updateWaChatLastSent(client, phone, at);
        }
    } finally {
        client.release();
    }
};

const checkGuestlist = async () => {
    const client = await pool.connect();
    try {
        const entries = (
            await client.query(
                'select party_id, friends, booked_table, table_offered_at from party_guestlist where guest_id = $1 order by joined_at',
                [guestId],
            )
        ).rows;
        for (const entry of entries) {
            console.log(
                `${YELLOW}[БД] ${entry.party_id}: friends=${JSON.stringify(entry.friends)} booked_table=${entry.booked_table} table_offered_at=${entry.table_offered_at}${RESET}`,
            );
        }
    } finally {
        client.release();
    }
};

const cleanup = async () => {
    const client = await pool.connect();
    try {
        await client.query('delete from wa_messages where wa_chat_phone = $1', [phone]);
        await client.query('delete from party_guestlist where guest_id = $1', [guestId]);
        await client.query('delete from wa_chats where wa_phone = $1', [phone]);
        await client.query('delete from guests where id = $1', [guestId]);
    } finally {
        client.release();
    }
};

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, async () => {
        await cleanup();
        await pool.end();
        process.exit(1);
    });
}

try {
    await seed();
    for (const line of turns ? GUEST_LINES.slice(0, turns) : GUEST_LINES) {
        console.log(`\n${WHITE}гость: ${line}${RESET}`);
        await persist('guest', line);

        const start = process.hrtime.bigint();
        const replies = await new Agent(phone).do();
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
} finally {
    await cleanup();
    await pool.end();
}
