// Диалоговая проба гостя из рассылки: сажает в чат маркетинговый шаблон и афишу
// с деталями активной вечеринки, потом гонит новые реплики через реального Agent.
// Вердикт по переписке: бот не открывает разговор с нуля и не питчит вечеринку как невиданную,
// не здоровается холодной презентацией, не выдумывает party_id и не путает вечеринку,
// ведёт к гестлисту и собирает то, что требует src/Intelligence/system.md.
// Запуск: pnpm exec tsx --conditions=development --env-file=.env.dev tests/probes/MarketingDialog.ts
// Флаг --quiet глушит логгер (info/debug/warn), остаётся только переписка и ошибки.
import { ulid } from 'ulid';
import { insertGuest } from '#Db/Guests.js';
import { selectActivePartiesWithTimes } from '#Db/Party.js';
import { pool } from '#Db/Pool.js';
import { updateWaChatLastSent, upsertWaChat } from '#Db/WaChats.js';
import { insertWaMarketingSend } from '#Db/WaMarketingSends.js';
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

const GUEST_LINES = ['привет', 'да, хочу', 'запиши меня в гестлист'];

const BROADCAST_TEMPLATE = 'Сёма Повар зовёт на вечеринку. Нажми Info — пришлю детали.';
const HOUR_MS = 60 * 60 * 1000;

const WHITE = '\x1b[97m';
const RED = '\x1b[91m';
const GRAY = '\x1b[90m';
const YELLOW = '\x1b[93m';
const RESET = '\x1b[0m';

if (env.WA_SEND === 'on') {
    console.error('WA_SEND=on — проба шлёт в реальный WhatsApp, запускай с WA_SEND=off');
    process.exit(1);
}

const phone = `marketing_${ulid()}`;
const guestId = ulid();

const seed = async () => {
    const client = await pool.connect();
    try {
        const parties = await selectActivePartiesWithTimes(client);
        const party = parties[0];
        if (!party) {
            console.error('нет активных вечеринок — пробе не на что слать рассылку');
            process.exit(1);
        }

        const now = new Date();
        await insertGuest(client, {
            id: guestId,
            wa_phone: phone,
            first_name: null,
            last_name: null,
            instagram: null,
            came_from: 'manual',
            came_at: toDateTime(now),
            lang: null,
            instagram_asked_at: null,
            marketing_enable: true,
        });
        await upsertWaChat(client, phone, guestId, now);

        // рассылка ушла до диалога: шаблон, потом афиша по нажатию Info
        await persist('marketing', BROADCAST_TEMPLATE, new Date(now.getTime() - 2 * HOUR_MS));
        await persist(
            'marketing',
            `${party.name}\n${party.location}\nЖду тебя!`,
            new Date(now.getTime() - HOUR_MS),
        );
        await insertWaMarketingSend(client, party.id, phone, new Date(now.getTime() - HOUR_MS));

        console.log(
            `${YELLOW}[БД] рассылка по вечеринке: ${party.name} (party_id: ${party.id})${RESET}`,
        );
    } finally {
        client.release();
    }
};

const persist = async (owner: 'guest' | 'sema' | 'marketing', text: string, at = new Date()) => {
    const client = await pool.connect();
    try {
        await insertWaMessage(client, {
            id: ulid(),
            wa_message_id: null,
            wa_chat_phone: phone,
            text,
            owner,
            status: 'idle',
            worker_status: owner === 'guest' ? 'processed' : 'skipped',
            concurrency_version: 0,
            sent_at: at,
        });
        if (owner !== 'guest') {
            await updateWaChatLastSent(client, phone, at);
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
                'select first_name, last_name, instagram from guests where id = $1',
                [guestId],
            )
        ).rows[0];
        console.log(
            `${YELLOW}[БД] guests: first_name=${guest.first_name} last_name=${guest.last_name} instagram=${guest.instagram}${RESET}`,
        );
        const entries = (
            await client.query(
                'select party_id, joined_at, friends, booked_table, table_offered_at from party_guestlist where guest_id = $1 order by joined_at',
                [guestId],
            )
        ).rows;
        if (!entries.length) {
            console.log(`${YELLOW}[БД] party_guestlist: строки нет${RESET}`);
        }
        for (const entry of entries) {
            console.log(
                `${YELLOW}[БД] ${entry.party_id}: joined_at=${entry.joined_at} friends=${JSON.stringify(entry.friends)} booked_table=${entry.booked_table} table_offered_at=${entry.table_offered_at}${RESET}`,
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
        await client.query('delete from wa_marketing_sends where wa_phone = $1', [phone]);
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
