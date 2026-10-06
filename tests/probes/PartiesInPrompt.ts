// Проба скорости: вечеринки в system-промте, без тула. Считает шаги, вызовы тулов и время на ход.
// Запуск: pnpm exec tsx --conditions=development --env-file=.env.dev tests/probes/PartiesInPrompt.ts [--exception] [--quiet]
//   --exception — на время прогона дописывает в notes LYLO инструкцию «списки закрыты, сделаю исключение»
//                 и гонит сценарий записи; notes откатываются в finally
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

const exception = process.argv.includes('--exception');

const EXCEPTION_PARTY = 'we_are_lylo_08_29';
const EXCEPTION_NOTE =
    'ВАЖНО, инструкция для бота: до 23:00 вход свободный для всех, даже вне списков. Список всё равно собирай (имя, фамилия, инстаграм — как обычно), но гостю на просьбу записать отвечай ровно так: «Списки уже закрыты, но я сделаю исключение для тебя, учти что после 11-ти вход будет платным, успевай».';

const GUEST_LINES = exception
    ? ['Привет! Запиши меня в субботу в LYLO', 'Иван Тестов', '@ivan_test']
    : [
          'Привет! Какие вечеринки на этой неделе?',
          'Сколько стоит вход в LYLO и где это?',
          'А во сколько начало в Penthouse?',
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

const phone = `parties_${ulid()}`;

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
        if (exception) {
            await client.query("update party set notes = notes || E'\\n' || $2 where id = $1", [
                EXCEPTION_PARTY,
                EXCEPTION_NOTE,
            ]);
        }
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
            await client.query('select party_id from party_guestlist where guest_id = $1', [
                guest.id,
            ])
        ).rows;
        console.log(
            `${YELLOW}[БД] guests: ${guest.first_name} ${guest.last_name} insta=${guest.instagram} | guestlist: ${entries.map((row) => row.party_id).join(', ') || 'нет'}${RESET}`,
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
        if (exception) {
            await client.query(
                "update party set notes = replace(notes, E'\\n' || $2, '') where id = $1",
                [EXCEPTION_PARTY, EXCEPTION_NOTE],
            );
        }
    } finally {
        client.release();
    }
};

await seed();
try {
    console.log(`${GRAY}[mode] prompt${exception ? ' + exception' : ''}${RESET}`);

    let totalMs = 0;
    for (const line of GUEST_LINES) {
        console.log(`\n${WHITE}гость: ${line}${RESET}`);
        await persist('guest', line);
        turnCalls = [];

        const start = process.hrtime.bigint();
        const replies = await new Agent(phone, create).do();
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        totalMs += ms;

        for (const reply of replies) {
            console.log(`${RED}бот:   ${reply.split('\n').join(`\n${RED}       `)}${RESET}`);
            await persist('sema', reply);
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
        `${YELLOW}[итог] ${Math.round(totalMs / 1000)}s на ${GUEST_LINES.length} хода | input=${usage.input} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite} output=${usage.output}${RESET}`,
    );
} finally {
    await cleanup();
    await pool.end();
}
