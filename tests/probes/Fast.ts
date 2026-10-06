// Запуск: pnpm exec tsx --conditions=development --env-file=.env.dev tests/probes/Fast.ts [--quiet] [--runs=N]
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

const runsArg = process.argv.find((arg) => arg.startsWith('--runs='));
const RUNS = runsArg ? Number(runsArg.split('=')[1]) : 1;
const TURN_BUDGET_MS = 5_000;

const GUEST_LINES = ['Привет! Добавь меня в гест-лист', 'Иван Тестов', '@ivan_test'];

const WHITE = '\x1b[97m';
const RED = '\x1b[91m';
const GRAY = '\x1b[90m';
const YELLOW = '\x1b[93m';
const GREEN = '\x1b[92m';
const RESET = '\x1b[0m';

if (env.WA_SEND === 'on') {
    console.error('WA_SEND=on — проба шлёт в реальный WhatsApp, запускай с WA_SEND=off');
    process.exit(1);
}

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

interface Step {
    ms: number;
    out: number;
    tools: string;
}
let steps: Step[] = [];

const create = async (params: Anthropic.MessageCreateParamsNonStreaming) => {
    const start = process.hrtime.bigint();
    const response = await anthropic.messages.create(params);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const tools = response.content.flatMap((block) =>
        block.type === 'tool_use' ? [block.name] : [],
    );
    steps.push({
        ms,
        out: response.usage.output_tokens,
        tools: tools.length ? tools.join('+') : '(text)',
    });
    return response;
};

const seed = async (phone: string) => {
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
    } finally {
        client.release();
    }
};

const persist = async (phone: string, owner: 'guest' | 'sema', text: string) => {
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

const checkDb = async (phone: string) => {
    const client = await pool.connect();
    try {
        const guest = (
            await client.query(
                'select id, first_name, last_name, instagram, instagram_asked_at from guests where wa_phone = $1',
                [phone],
            )
        ).rows[0];
        const listed =
            (await client.query('select 1 from party_guestlist where guest_id = $1', [guest.id]))
                .rowCount ?? 0;
        const ok =
            guest.first_name === 'Иван' &&
            guest.last_name === 'Тестов' &&
            !!guest.instagram &&
            !!guest.instagram_asked_at &&
            listed > 0;
        console.log(
            `${YELLOW}[БД] name=${guest.first_name} ${guest.last_name} ig=${guest.instagram} asked=${!!guest.instagram_asked_at} listed=${listed > 0} → ${ok ? 'OK' : 'FAIL'}${RESET}`,
        );
        return ok;
    } finally {
        client.release();
    }
};

const cleanup = async (phone: string) => {
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

const fmt = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

const turnTimes: number[] = [];
let dbFails = 0;
let activePhone: string | null = null;
process.once('SIGINT', async () => {
    console.log(`\n${GRAY}прервано — чищу тестовые данные${RESET}`);
    if (activePhone) {
        await cleanup(activePhone);
    }
    await pool.end();
    process.exit(130);
});

try {
    for (let run = 1; run <= RUNS; run++) {
        const phone = `fast_${ulid()}`;
        activePhone = phone;
        console.log(`\n${GRAY}=== прогон ${run}/${RUNS} ===${RESET}`);
        await seed(phone);
        try {
            for (const line of GUEST_LINES) {
                console.log(`\n${WHITE}гость: ${line}${RESET}`);
                await persist(phone, 'guest', line);
                steps = [];

                const start = process.hrtime.bigint();
                const replies = await new Agent(phone, create).do();
                const ms = Number(process.hrtime.bigint() - start) / 1e6;
                turnTimes.push(ms);

                for (const reply of replies) {
                    console.log(
                        `${RED}бот:   ${reply.split('\n').join(`\n${RED}       `)}${RESET}`,
                    );
                    await persist(phone, 'sema', reply);
                }
                if (!replies.length) {
                    console.log(`${RED}бот:   (молчит)${RESET}`);
                }
                const color = ms <= TURN_BUDGET_MS ? GREEN : RED;
                const trace = steps
                    .map((step) => `${step.tools} ${fmt(step.ms)}/${step.out}tok`)
                    .join(' → ');
                console.log(`${color}ход ${fmt(ms)}${RESET} ${GRAY}[${trace}]${RESET}`);
            }
            if (!(await checkDb(phone))) {
                dbFails++;
            }
        } finally {
            await cleanup(phone);
            activePhone = null;
        }
    }
    const over = turnTimes.filter((ms) => ms > TURN_BUDGET_MS).length;
    const max = Math.max(...turnTimes);
    const avg = turnTimes.reduce((sum, ms) => sum + ms, 0) / turnTimes.length;
    console.log(
        `\n${YELLOW}[итог] ходов=${turnTimes.length} avg=${fmt(avg)} max=${fmt(max)} >${TURN_BUDGET_MS / 1000}s: ${over} | БД FAIL: ${dbFails}/${RUNS}${RESET}`,
    );
} finally {
    await pool.end();
}
