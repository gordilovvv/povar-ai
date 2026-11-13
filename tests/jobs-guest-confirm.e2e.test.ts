import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { env } from '#environment.js';
import { runTick } from '#Jobs/GuestConfirmEntry.js';
import { Marketing } from '#Marketing/index.js';
import { closePool, dbQuery, fmt, measure, withClient } from './helpers/e2e.ts';

const CONFIG = {
    databaseUrl: process.env.DATABASE_URL ?? '',
    waToken: 'E2E_WA_TOKEN',
    waPhoneId: 'E2E_PHONE_ID',
    waSend: 'on' as const,
};

// Дубай = UTC+4. Старт 22:00 Дубай = 18:00Z; порог 19:00 Дубай того же дня = 15:00Z.
const PARTY_START = '2032-06-15T18:00:00Z';
const CONFIRM_AT = '2032-06-15T15:00:00Z';
const NOW_DUE = '2032-06-15T15:30:00Z'; // 19:30 Дубай: после порога, до старта
const NOW_BEFORE_DUE = '2032-06-15T14:59:59Z';
const NOW_AFTER_START = '2032-06-15T19:00:00Z';
// 00:00 Дубай дня вечеринки = 2032-06-14T20:00Z; записавшиеся с этого момента опрос не получают.
const JOINED_EVE_2359 = '2032-06-14T19:59:00Z';
const JOINED_DAY_0000 = '2032-06-14T20:00:00Z';
const JOINED_DAY_1859 = '2032-06-15T14:59:00Z';

const PARTY_ID = 'E2E_GUEST_CONFIRM_PARTY';
const G_EARLY = 'E2E_GUEST_CONFIRM_G1';
const G_LATE = 'E2E_GUEST_CONFIRM_G2';
const G_NO_PHONE = 'E2E_GUEST_CONFIRM_G3';
const G_EVE = 'E2E_GUEST_CONFIRM_G4';
const G_MIDNIGHT = 'E2E_GUEST_CONFIRM_G5';
const G_SAME_DAY = 'E2E_GUEST_CONFIRM_G6';

interface FetchCall {
    url: string;
    body: {
        to: string;
        text?: { body: string };
        template: {
            name: string;
            components: { type: string; parameters: { text?: string; payload?: string }[] }[];
        };
    };
}

let sent: FetchCall[] = [];
let waOk = true;
const realFetch = globalThis.fetch;

const stubFetch = () => {
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
        sent.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') });
        return {
            ok: waOk,
            status: waOk ? 200 : 500,
            text: async () => 'stub',
            json: async () => ({ messages: [{ id: `wamid.${sent.length}` }] }),
        } as Response;
    }) as typeof fetch;
};

const cleanup = async () => {
    await dbQuery(`delete from wa_messages where wa_chat_phone like 'wa_E2E_GUEST_CONFIRM_%'`);
    await dbQuery(`delete from wa_chats where wa_phone like 'wa_E2E_GUEST_CONFIRM_%'`);
    await dbQuery(`delete from party_guestlist where party_id = $1`, [PARTY_ID]);
    await dbQuery(`delete from party_time where party_id = $1`, [PARTY_ID]);
    await dbQuery(`delete from party where id = $1`, [PARTY_ID]);
    await dbQuery(`delete from guests where id = any($1)`, [
        [G_EARLY, G_LATE, G_NO_PHONE, G_EVE, G_MIDNIGHT, G_SAME_DAY],
    ]);
};

const seed = async () => {
    await cleanup();
    await dbQuery(
        `insert into party (id, type, name, location) values ($1,'owned','Neon Night','Dubai')`,
        [PARTY_ID],
    );
    await dbQuery(
        `insert into party_time (party_id, party_start_at, guestlist_alert_at, guest_confirm_at) values ($1,$2,$2,$3)`,
        [PARTY_ID, PARTY_START, CONFIRM_AT],
    );
    for (const [id, phone, first] of [
        [G_EARLY, `wa_${G_EARLY}`, 'Anna'],
        [G_LATE, `wa_${G_LATE}`, 'Boris'],
        [G_NO_PHONE, null, 'Clara'],
    ] as const) {
        await dbQuery(`insert into guests (id, wa_phone, first_name) values ($1,$2,$3)`, [
            id,
            phone,
            first,
        ]);
        if (phone) {
            await dbQuery(`insert into wa_chats (wa_phone, guest_id) values ($1,$2)`, [phone, id]);
        }
    }
    await dbQuery(
        `insert into party_guestlist (party_id, guest_id, joined_at) values ($1,$2,$3),($1,$4,$5),($1,$6,$3)`,
        [PARTY_ID, G_EARLY, '2032-06-10T10:00:00Z', G_LATE, '2032-06-15T15:10:00Z', G_NO_PHONE],
    );
};

const addGuest = async (id: string, first: string, joinedAt: string) => {
    const phone = `wa_${id}`;
    await dbQuery(`insert into guests (id, wa_phone, first_name) values ($1,$2,$3)`, [
        id,
        phone,
        first,
    ]);
    await dbQuery(`insert into wa_chats (wa_phone, guest_id) values ($1,$2)`, [phone, id]);
    await dbQuery(`insert into party_guestlist (party_id, guest_id, joined_at) values ($1,$2,$3)`, [
        PARTY_ID,
        id,
        joinedAt,
    ]);
};

const sentTo = (id: string) => sent.filter((call) => call.body.to === `wa_${id}`).length;

const answerOf = async (guestId: string) => {
    const rows = await dbQuery<{ guest_confirm_answer: string | null }>(
        `select guest_confirm_answer from party_guestlist where party_id = $1 and guest_id = $2`,
        [PARTY_ID, guestId],
    );
    return rows[0]?.guest_confirm_answer ?? null;
};

describe('e2e: jobs-guest-confirm', () => {
    let pool: pg.Pool;

    before(async () => {
        pool = new pg.Pool({ connectionString: CONFIG.databaseUrl });
        stubFetch();
    });

    after(async () => {
        globalThis.fetch = realFetch;
        await cleanup();
        await pool.end();
        await closePool();
    });

    test('в 19:00 шлём шаблон только тем, кто записался до порога и имеет телефон', async () => {
        await seed();
        sent = [];
        waOk = true;

        const { ms } = await measure('runTick guest-confirm', () => runTick(pool, CONFIG, NOW_DUE));

        assert.equal(sent.length, 1, 'ровно один шаблон');
        const call = sent[0];
        assert.match(call?.url ?? '', /graph\.facebook\.com\/v[\d.]+\/E2E_PHONE_ID\/messages/);
        assert.equal(call?.body.to, `wa_${G_EARLY}`);
        assert.equal(call?.body.template.name, 'event_rsvp_confirmation');
        const [body, yes, no] = call?.body.template.components ?? [];
        assert.deepEqual(
            body?.parameters.map((p) => p.text),
            ['Anna', 'June 15'],
        );
        assert.equal(yes?.parameters[0]?.payload, `guest_confirm:yes:${PARTY_ID}`);
        assert.equal(no?.parameters[0]?.payload, `guest_confirm:no:${PARTY_ID}`);

        assert.equal(await answerOf(G_EARLY), 'pending');
        assert.equal(await answerOf(G_LATE), null, 'поздний гость не спрошен');
        assert.equal(await answerOf(G_NO_PHONE), null, 'без телефона не спрошен');

        const history = await dbQuery<{ text: string; owner: string }>(
            `select text, owner from wa_messages where wa_chat_phone = $1`,
            [`wa_${G_EARLY}`],
        );
        assert.equal(history.length, 1);
        assert.equal(history[0]?.owner, 'marketing');
        assert.match(
            history[0]?.text ?? '',
            /^Hi Anna, are you coming to the event tonight, June 15\?/,
        );
        console.log(`[e2e] guest-confirm broadcast — ${fmt(ms)}`);
    });

    test('идемпотентность: повторный тик ничего не шлёт', async () => {
        sent = [];
        await runTick(pool, CONFIG, NOW_DUE);
        assert.equal(sent.length, 0);
    });

    test('до порога и после старта — молчим', async () => {
        await seed();
        sent = [];
        await runTick(pool, CONFIG, NOW_BEFORE_DUE);
        await runTick(pool, CONFIG, NOW_AFTER_START);
        assert.equal(sent.length, 0);
        assert.equal(await answerOf(G_EARLY), null);
    });

    test('guest_confirm_at null: опрос выключен, никому не шлём', async () => {
        await seed();
        await dbQuery(`update party_time set guest_confirm_at = null where party_id = $1`, [
            PARTY_ID,
        ]);
        sent = [];
        await runTick(pool, CONFIG, NOW_DUE);
        assert.equal(sent.length, 0);
        assert.equal(await answerOf(G_EARLY), null);
    });

    test('ошибка WhatsApp: помечается failed, повторов нет', async () => {
        await seed();
        sent = [];
        waOk = false;
        await runTick(pool, CONFIG, NOW_DUE);
        assert.equal(sent.length, 1);
        assert.equal(await answerOf(G_EARLY), 'failed');

        waOk = true;
        await runTick(pool, CONFIG, NOW_DUE);
        assert.equal(sent.length, 1, 'failed не ретраится');
    });

    test('WA_SEND=off: помечаем, но не шлём', async () => {
        await seed();
        sent = [];
        await runTick(pool, { ...CONFIG, waSend: 'off' }, NOW_DUE);
        assert.equal(sent.length, 0);
        assert.equal(await answerOf(G_EARLY), 'pending');
    });

    test('записался в 23:59 Дубай накануне — опрос уходит', async () => {
        await seed();
        await addGuest(G_EVE, 'Eva', JOINED_EVE_2359);
        sent = [];
        waOk = true;
        await runTick(pool, CONFIG, NOW_DUE);
        assert.equal(sentTo(G_EVE), 1);
        assert.equal(await answerOf(G_EVE), 'pending');
    });

    test('записался ровно в 00:00 Дубай дня вечеринки — опрос не уходит', async () => {
        await seed();
        await addGuest(G_MIDNIGHT, 'Mark', JOINED_DAY_0000);
        sent = [];
        waOk = true;
        await runTick(pool, CONFIG, NOW_DUE);
        assert.equal(sentTo(G_MIDNIGHT), 0);
        assert.equal(await answerOf(G_MIDNIGHT), null);
    });

    test('записался в день вечеринки до 19:00 Дубай — опрос не уходит', async () => {
        await seed();
        await addGuest(G_SAME_DAY, 'Sara', JOINED_DAY_1859);
        sent = [];
        waOk = true;
        await runTick(pool, CONFIG, NOW_DUE);
        assert.equal(sentTo(G_SAME_DAY), 0);
        assert.equal(await answerOf(G_SAME_DAY), null);
    });

    test('смесь: опрос уходит только записавшимся до дня вечеринки', async () => {
        await seed();
        await addGuest(G_EVE, 'Eva', JOINED_EVE_2359);
        await addGuest(G_MIDNIGHT, 'Mark', JOINED_DAY_0000);
        await addGuest(G_SAME_DAY, 'Sara', JOINED_DAY_1859);
        sent = [];
        waOk = true;
        await runTick(pool, CONFIG, NOW_DUE);
        assert.deepEqual(sent.map((call) => call.body.to).sort(), [`wa_${G_EARLY}`, `wa_${G_EVE}`]);
        assert.equal(await answerOf(G_EARLY), 'pending');
        assert.equal(await answerOf(G_EVE), 'pending');
        assert.equal(await answerOf(G_MIDNIGHT), null);
        assert.equal(await answerOf(G_SAME_DAY), null);
        assert.equal(await answerOf(G_LATE), null);
    });

    test('тап Yes/No: ставит ответ, пишет историю, отвечает текстом; агент не вызывается', async () => {
        await seed();
        sent = [];
        waOk = true;
        await runTick(pool, CONFIG, NOW_DUE);
        sent = [];

        const tap = (id: string, answer: 'yes' | 'no') => ({
            id,
            from: `wa_${G_EARLY}`,
            type: 'button',
            button: {
                payload: `guest_confirm:${answer}:${PARTY_ID}`,
                text: answer === 'yes' ? 'Yes' : 'No',
            },
        });
        const handled = await withClient((client) =>
            Marketing.handleMessage(client, tap('wamid.E2E_GUEST_CONFIRM_TAP1', 'yes'), new Date()),
        );
        assert.equal(handled, true);
        assert.equal(await answerOf(G_EARLY), 'yes');

        const history = await dbQuery<{ text: string; owner: string }>(
            `select text, owner from wa_messages where wa_chat_phone = $1 order by id`,
            [`wa_${G_EARLY}`],
        );
        assert.deepEqual(
            history.slice(1).map((row) => [row.owner, row.text]),
            env.WA_SEND === 'on'
                ? [
                      ['guest', 'Yes'],
                      ['marketing', 'Great, see you at the party! 🎉'],
                  ]
                : [['guest', 'Yes']],
        );
        if (env.WA_SEND === 'on') {
            assert.equal(sent.length, 1);
            assert.equal(sent[0]?.body.text?.body, 'Great, see you at the party! 🎉');
        }

        // передумал: последний ответ побеждает
        await withClient((client) =>
            Marketing.handleMessage(client, tap('wamid.E2E_GUEST_CONFIRM_TAP2', 'no'), new Date()),
        );
        assert.equal(await answerOf(G_EARLY), 'no');
    });

    test('тап после того как вечеринка прошла: ответ пишем, но отвечаем «уже прошла»', async () => {
        await seed();
        sent = [];
        waOk = true;
        await runTick(pool, CONFIG, NOW_DUE);
        await dbQuery(
            `update party_time set party_start_at = now() - interval '1 day' where party_id = $1`,
            [PARTY_ID],
        );
        sent = [];
        const handled = await withClient((client) =>
            Marketing.handleMessage(
                client,
                {
                    id: 'wamid.E2E_GUEST_CONFIRM_TAP_PAST',
                    from: `wa_${G_EARLY}`,
                    type: 'button',
                    button: { payload: `guest_confirm:yes:${PARTY_ID}`, text: 'Yes' },
                },
                new Date(),
            ),
        );
        assert.equal(handled, true);
        assert.equal(await answerOf(G_EARLY), 'yes');
        if (env.WA_SEND === 'on') {
            assert.equal(sent.length, 1);
            assert.match(sent[0]?.body.text?.body ?? '', /already happened/);
        }
    });

    test('тап без переклички (поздний гость): проглатываем, ничего не шлём', async () => {
        sent = [];
        const handled = await withClient((client) =>
            Marketing.handleMessage(
                client,
                {
                    id: 'wamid.E2E_GUEST_CONFIRM_TAP3',
                    from: `wa_${G_LATE}`,
                    type: 'button',
                    button: { payload: `guest_confirm:yes:${PARTY_ID}`, text: 'Yes' },
                },
                new Date(),
            ),
        );
        assert.equal(handled, true);
        assert.equal(await answerOf(G_LATE), null);
        assert.equal(sent.length, 0);
    });
});
