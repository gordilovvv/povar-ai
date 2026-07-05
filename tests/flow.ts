import { ulid } from 'ulid';
import { pool } from '../src/db/db.ts';
import { selectGuestlistByGuest } from '../src/db/guestlist.ts';
import { type GuestStorage, insertGuest, selectGuestByPhone } from '../src/db/guests.ts';
import type { WaMessageStorage } from '../src/db/wa-messages.ts';
import { Agent, type ChatContext } from '../src/intelligence/agent.ts';
import { getDubaiTime } from '../src/lib/time.ts';

interface Scenario {
    category: string;
    phone: string;
    came_from: 'ad' | 'manual';
    known?: { first_name: string; last_name: string; instagram_url: string };
    messages: string[];
}

// Моковые реплики гостя. Одна категория = один сценарий. Запуск: node --env-file=.env.dev tests/flow.ts <category>
const scenarios: Scenario[] = [
    {
        category: 'guestlist',
        phone: '+000000000001',
        came_from: 'manual',
        messages: ['привет, хочу к вам на вечеринку', 'на COYA', 'Alexander User', '@alex'],
    },
    {
        category: 'table',
        phone: '+000000000002',
        came_from: 'manual',
        messages: [
            'хочу на вечеринку, есть столы?',
            'на COYA',
            'Дима Лебедев',
            '@dima_l',
            'беру стол',
            'нас четверо',
        ],
    },
    {
        category: 'known',
        phone: '+000000000003',
        came_from: 'manual',
        known: { first_name: 'Саша', last_name: 'Смирнов', instagram_url: '@sasha_smr' },
        messages: ['привет, ты как?'],
    },
    {
        category: 'no-parties',
        phone: '+000000000004',
        came_from: 'manual',
        messages: ['хочу на вечеринку', 'а какие сейчас есть?', 'а когда следующая будет?'],
    },
];

const main = async () => {
    const category = process.argv[2];
    if (!category) {
        process.stdout.write(`укажи категорию: ${scenarios.map((s) => s.category).join(' | ')}\n`);
        return;
    }
    const scenario = scenarios.find((s) => s.category === category);
    if (!scenario) {
        process.stdout.write(
            `нет категории «${category}». есть: ${scenarios.map((s) => s.category).join(' | ')}\n`,
        );
        return;
    }

    hijackInternalLogs();
    await runScenario(scenario);
    await pool.end();
};

const runScenario = async (scenario: Scenario) => {
    printHeader(scenario.category);
    await resetGuest(scenario);
    const history: WaMessageStorage[] = [];

    for (const text of scenario.messages) {
        printGuest(text);
        history.push(mockMessage(scenario.phone, text, 'guest'));

        const context = await buildContext(scenario.phone, history);
        const replies = await Agent.do(context);

        for (const reply of replies) {
            printSema(reply);
            history.push(mockMessage(scenario.phone, reply, 'sema'));
        }
    }
};

const buildContext = async (phone: string, history: WaMessageStorage[]): Promise<ChatContext> => {
    const client = await pool.connect();
    try {
        const guest = await selectGuestByPhone(client, phone);
        if (!guest) {
            throw new Error(`test guest ${phone} vanished`);
        }
        const ownedGuestlist = await selectGuestlistByGuest(client, guest.id);
        const now = getDubaiTime().format('YYYY-MM-DD HH:mm:ss');
        return { guest, messages: history, ownedGuestlist, now };
    } finally {
        client.release();
    }
};

const resetGuest = async (scenario: Scenario): Promise<GuestStorage> => {
    const client = await pool.connect();
    try {
        const existing = await selectGuestByPhone(client, scenario.phone);
        if (existing) {
            await client.query('delete from party_guestlist where guest_id = $1', [existing.id]);
            await client.query('delete from guests where id = $1', [existing.id]);
        }
        const guest: GuestStorage = {
            id: ulid(),
            wa_phone: scenario.phone,
            first_name: scenario.known?.first_name ?? null,
            last_name: scenario.known?.last_name ?? null,
            instagram_url: scenario.known?.instagram_url ?? null,
            came_from: scenario.came_from,
            came_at: null,
            lang: null,
        };
        await insertGuest(client, guest);
        return guest;
    } finally {
        client.release();
    }
};

let messageSeq = 0;

const mockMessage = (phone: string, text: string, owner: 'guest' | 'sema'): WaMessageStorage => ({
    id: `mock-${String(messageSeq++).padStart(6, '0')}`,
    wa_message_id: null,
    wa_chat_phone: phone,
    text,
    owner,
    status: 'sent',
    worker_status: null,
    concurrency_version: 0,
    sent_at: new Date().toISOString(),
});

const RESET = '\x1b[0m';
const WHITE = '\x1b[1;97m';
const PURPLE = '\x1b[0;35m';
const DIM = '\x1b[2;37m';
const HEADER = '\x1b[1;95m';

const printHeader = (name: string) => {
    process.stdout.write(`\n${HEADER}━━━ ${name} ━━━${RESET}\n`);
};

const printGuest = (text: string) => {
    process.stdout.write(`${WHITE}гость │ ${text}${RESET}\n`);
};

const printSema = (text: string) => {
    process.stdout.write(`${PURPLE}сёма  │ ${text}${RESET}\n`);
};

// Внутренние логи агента/тулзов ([agent]/[tool]) тушим в тусклый — это «то что внутри».
const hijackInternalLogs = () => {
    const original = console.log.bind(console);
    console.log = (...args: unknown[]) => {
        const first = typeof args[0] === 'string' ? args[0] : '';
        if (first.startsWith('[')) {
            original(`${DIM}${args.join(' ')}${RESET}`);
            return;
        }
        original(...args);
    };
};

await main();
