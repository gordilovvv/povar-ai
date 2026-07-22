// Диалоговая проба: гость спрашивает про столы → у агента нет факта → pause_chat.
// Запуск: pnpm exec tsx --conditions=development --env-file=.env.dev tests/probes/Tables.ts --quiet
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

const GUEST_LINES = [
    'Привет!',
    'Сколько стоит вход?',
    'А можно забронировать стол? Сколько стоит?',
];

const WHITE = '\x1b[97m';
const RED = '\x1b[91m';
const GRAY = '\x1b[90m';
const RESET = '\x1b[0m';

if (env.WA_SEND === 'on') {
    console.error('WA_SEND=on — проба шлёт в реальный WhatsApp, запускай с WA_SEND=off');
    process.exit(1);
}

const phone = `tables_${ulid()}`;

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
        if (owner === 'sema') {
            await updateWaChatLastSent(client, phone, now);
        }
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
    let lastReplies: string[] = [];
    for (const line of GUEST_LINES) {
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
        lastReplies = replies;
    }

    const pausedAt = (
        await pool.query('select paused_at from wa_chats where wa_phone = $1', [phone])
    ).rows[0]?.paused_at;
    console.log(`\nвердикт: ${pausedAt ? `PAUSED (paused_at=${pausedAt})` : 'NOT PAUSED'}`);
    console.log(`бот на последней реплике: ${lastReplies.length ? 'писал' : 'молчал'}`);
} finally {
    await cleanup();
    await pool.end();
}
