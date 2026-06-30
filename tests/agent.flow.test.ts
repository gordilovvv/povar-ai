import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ulid } from 'ulid';
import { pool } from '../src/db/db.ts';
import { selectGuestlistByGuest } from '../src/db/guestlist.ts';
import { selectGuestByPhone } from '../src/db/guests.ts';
import type { PartyStorage } from '../src/db/party.ts';
import type { WaMessageStorage } from '../src/db/wa-messages.ts';
import { agent, type ChatContext } from '../src/intelligence/agent.ts';
import { toDateTime } from '../src/lib/fmt.ts';

const partyId = ulid();
const party: PartyStorage = {
    id: partyId,
    name: 'COYA',
    location: 'COYA, Dubai',
    google_map_link: null,
    price: '100',
};

before(async () => {
    const client = await pool.connect();
    try {
        await client.query(`insert into party (id, name, location, price) values ($1,$2,$3,$4)`, [
            partyId,
            party.name,
            party.location,
            party.price,
        ]);
        await client.query(
            `insert into party_time (party_id, party_start_at, free_entry_before)
             values ($1, now() + interval '2 days', now() + interval '2 days' + interval '2 hours')`,
            [partyId],
        );
    } finally {
        client.release();
    }
});

after(async () => {
    const client = await pool.connect();
    try {
        await client.query(`delete from party_time where party_id = $1`, [partyId]);
        await client.query(`delete from party where id = $1`, [partyId]);
    } finally {
        client.release();
    }
});

let seq = 0;
const guestMsg = (phone: string, text: string): WaMessageStorage => ({
    id: `g${seq++}`,
    wa_message_id: null,
    wa_chat_phone: phone,
    text,
    owner: 'guest',
    status: 'delivered',
    worker_status: 'processed',
    concurrency_version: 0,
    sent_at: toDateTime(Date.now()),
});

const botMsg = (phone: string, text: string): WaMessageStorage => ({
    id: `b${seq++}`,
    wa_message_id: null,
    wa_chat_phone: phone,
    text,
    owner: 'bot',
    status: 'sent',
    worker_status: 'processed',
    concurrency_version: 0,
    sent_at: toDateTime(Date.now()),
});

// Прогон сценария: создаём гостя, шлём сообщения по очереди, копим историю, логируем транскрипт.
const runScenario = async (name: string, script: string[]) => {
    const phone = `99999${seq}${Date.now()}`.slice(0, 15);
    const guestId = ulid();
    const client = await pool.connect();
    try {
        await client.query(
            `insert into guests (id, wa_phone, came_from, came_at) values ($1,$2,$3,$4)`,
            [guestId, phone, 'manual', toDateTime(Date.now())],
        );
    } finally {
        client.release();
    }

    const history: WaMessageStorage[] = [];
    const allReplies: string[] = [];
    console.log(`\n========== СЦЕНАРИЙ: ${name} (${phone}) ==========`);
    for (const text of script) {
        history.push(guestMsg(phone, text));

        const c = await pool.connect();
        let guest: Awaited<ReturnType<typeof selectGuestByPhone>>;
        let ownedGuestlist: Awaited<ReturnType<typeof selectGuestlistByGuest>>;
        try {
            guest = await selectGuestByPhone(c, phone);
            ownedGuestlist = await selectGuestlistByGuest(c, guestId);
        } finally {
            c.release();
        }
        assert.ok(guest, 'гость существует');

        const context: ChatContext = {
            guest,
            messages: history,
            ownedGuestlist,
            now: toDateTime(Date.now()),
        };
        const replies = await agent.do(context);
        console.log(`ГОСТЬ: ${text}`);
        for (const reply of replies) {
            console.log(`  БОТ: ${reply}`);
            history.push(botMsg(phone, reply));
            allReplies.push(reply);
        }
        assert.ok(replies.length > 0, `бот ответил на «${text}»`);
    }

    const c2 = await pool.connect();
    try {
        const guest = await selectGuestByPhone(c2, phone);
        const lists = await selectGuestlistByGuest(c2, guestId);
        console.log(`ИТОГ guest: ${JSON.stringify(guest)}`);
        console.log(`ИТОГ guestlist: ${JSON.stringify(lists)}`);
        return { guestId, phone, guest, lists, replies: allReplies };
    } finally {
        c2.release();
    }
};

const dropGuest = async (guestId: string) => {
    const client = await pool.connect();
    try {
        await client.query(`delete from party_guestlist where guest_id = $1`, [guestId]);
        await client.query(`delete from guests where id = $1`, [guestId]);
    } finally {
        client.release();
    }
};

test('ru: привет → small talk → когда тусовки → сбор данных → гест-лист → стол', async () => {
    const r = await runScenario('ru-happy-table', [
        'Привет',
        'Норм, ты как? Я в Дубае',
        'А когда тусовки?',
        'Давай, запиши меня',
        'Иван Петров',
        'инста @ivan_petrov',
        'Давай стол, нас четверо',
    ]);
    assert.equal(r.guest?.first_name, 'Иван', 'имя собралось');
    assert.ok(r.lists.length > 0, 'в гест-листе');
    assert.ok(
        r.lists.some((l) => l.booked_table),
        'стол забронирован',
    );
    await dropGuest(r.guestId);
});

test('en: ведёт диалог на английском', async () => {
    const r = await runScenario('en-smalltalk', [
        'Hi bro',
        'good, you? im in dubai',
        'what events?',
    ]);
    const joined = r.replies.join(' ');
    const cyrillic = (joined.match(/[а-яё]/gi) ?? []).length;
    assert.ok(cyrillic < 5, `должен вести на английском, кириллицы: ${cyrillic}`);
    await dropGuest(r.guestId);
});

test('нерелевантное → мягкий стоп, без тулзов', async () => {
    const r = await runScenario('irrelevant', ['дай рецепт борща']);
    assert.equal(r.lists.length, 0, 'в гест-лист не заносим');
    await dropGuest(r.guestId);
});

test('две вечеринки → анонсирует обе, спрашивает на какую', async () => {
    const party2 = ulid();
    const c = await pool.connect();
    try {
        await c.query(`insert into party (id, name, location, price) values ($1,$2,$3,$4)`, [
            party2,
            'LYLO',
            'LYLO, Palm Jumeirah',
            '0',
        ]);
        await c.query(
            `insert into party_time (party_id, party_start_at, free_entry_before)
             values ($1, now() + interval '4 days', now() + interval '4 days' + interval '2 hours')`,
            [party2],
        );
    } finally {
        c.release();
    }

    const r = await runScenario('two-parties', [
        'Привет',
        'в Дубае, всё ок. Какие вечеринки есть?',
    ]);
    const joined = r.replies.join(' ');
    assert.ok(/COYA/i.test(joined), 'упомянул COYA');
    assert.ok(/LYLO/i.test(joined), 'упомянул LYLO');

    await dropGuest(r.guestId);
    const c2 = await pool.connect();
    try {
        await c2.query(`delete from party_time where party_id = $1`, [party2]);
        await c2.query(`delete from party where id = $1`, [party2]);
    } finally {
        c2.release();
    }
});
