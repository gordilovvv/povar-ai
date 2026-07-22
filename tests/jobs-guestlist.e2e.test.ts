import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { buildMessage, runTick } from '#Jobs/GuestlistEntry.js';
import { closePool, dbQuery, fmt, measure } from './helpers/e2e.ts';

const CONFIG = {
    databaseUrl: process.env.DATABASE_URL ?? '',
    telegramBotToken: 'E2E_TOKEN',
    telegramGroupId: 'E2E_GROUP',
};

// Дубай = UTC+4. Вечеринка стартует 22:00 по Дубаю (18:00Z); 18:00-порог того же дня = 14:00Z.
const PARTY_START = '2030-06-15T18:00:00Z';
const NOW_DUE = '2030-06-15T15:00:00Z'; // 19:00 Дубай: после 18:00, до старта
const NOW_BEFORE_18 = '2030-06-15T09:00:00Z'; // 13:00 Дубай: порог не наступил
const NOW_AFTER_START = '2030-06-15T19:00:00Z'; // 23:00 Дубай: вечеринка уже началась

const PARTY_ID = 'E2E_JOBS_PARTY';
const G1 = 'E2E_JOBS_G1';
const G2 = 'E2E_JOBS_G2';
const G3 = 'E2E_JOBS_G3';
const G4 = 'E2E_JOBS_G4';

interface FetchCall {
    url: string;
    body: { chat_id: string; text: string; parse_mode?: string };
}

let sent: FetchCall[] = [];
let telegramOk = true;
const realFetch = globalThis.fetch;

const stubFetch = () => {
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
        sent.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') });
        return { json: async () => ({ ok: telegramOk, description: 'stub' }) } as Response;
    }) as typeof fetch;
};

const seed = async () => {
    await cleanup();
    await dbQuery(
        `insert into party (id, type, name, location) values ($1,'owned','Neon Night','Dubai')`,
        [PARTY_ID],
    );
    await dbQuery(`insert into party_time (party_id, party_start_at) values ($1,$2)`, [
        PARTY_ID,
        PARTY_START,
    ]);
    for (const [id, first, last] of [
        [G1, 'Anna', 'Ivanova'],
        [G2, 'Boris', 'Petrov'],
        [G3, 'Clara', 'Sidorova'],
        [G4, 'Dmitry', 'Orlov'],
    ] as const) {
        await dbQuery(
            `insert into guests (id, wa_phone, first_name, last_name) values ($1,$2,$3,$4)`,
            [id, `wa_${id}`, first, last],
        );
    }
};

const addGuestlistEntry = async (
    guestId: string,
    friends: string[] | null,
    joinedAt: string,
    alertedAt: string | null,
) => {
    await dbQuery(
        `insert into party_guestlist (party_id, guest_id, joined_at, friends, telegram_alert_at)
         values ($1,$2,$3,$4,$5)`,
        [PARTY_ID, guestId, joinedAt, friends, alertedAt],
    );
};

const alertedAtOf = async (guestId: string): Promise<string | null> => {
    const rows = await dbQuery<{ telegram_alert_at: Date | null }>(
        `select telegram_alert_at from party_guestlist where party_id = $1 and guest_id = $2`,
        [PARTY_ID, guestId],
    );
    const value = rows[0]?.telegram_alert_at ?? null;
    return value ? value.toISOString() : null;
};

const cleanup = async () => {
    await dbQuery(`delete from party_guestlist where party_id = $1`, [PARTY_ID]);
    await dbQuery(`delete from party_time where party_id = $1`, [PARTY_ID]);
    await dbQuery(`delete from party where id = $1`, [PARTY_ID]);
    await dbQuery(`delete from guests where id = any($1)`, [[G1, G2, G3, G4]]);
};

describe('e2e: jobs-guestlist', () => {
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

    test('первичная рассылка: один список всей гостей + друзей после 18:00', async () => {
        await seed();
        sent = [];
        telegramOk = true;
        // Anna c двумя друзьями, Boris без, Clara с одним. joined_at задаёт порядок.
        await addGuestlistEntry(G1, ['Eve Frolova', 'Fred Kim'], '2030-06-10T10:00:00Z', null);
        await addGuestlistEntry(G2, null, '2030-06-10T11:00:00Z', null);
        await addGuestlistEntry(G3, ['Greg Lee'], '2030-06-10T12:00:00Z', null);

        const { ms } = await measure('runTick broadcast', () => runTick(pool, CONFIG, NOW_DUE));

        assert.equal(sent.length, 1, 'ровно одно сообщение в группу');
        assert.equal(sent[0]?.body.chat_id, 'E2E_GROUP');
        assert.equal(sent[0]?.body.parse_mode, 'MarkdownV2');
        assert.match(sent[0]?.url ?? '', /api\.telegram\.org\/botE2E_TOKEN\/sendMessage/);
        const text = sent[0]?.body.text ?? '';
        assert.equal(
            text,
            '*Neon Night*\nГест\\-лист\n\n```\nAnna Ivanova\nEve Frolova\nFred Kim\nBoris Petrov\nClara Sidorova\nGreg Lee\n```',
        );

        for (const g of [G1, G2, G3]) {
            assert.notEqual(await alertedAtOf(g), null, `${g} помечен telegram_alert_at`);
        }
        console.log(`[e2e] broadcast — ${fmt(ms)}`);
    });

    test('идемпотентность: повторный прогон не шлёт и не переписывает', async () => {
        // состояние после предыдущего теста: G1..G3 уже помечены
        const before1 = await alertedAtOf(G1);
        sent = [];
        await runTick(pool, CONFIG, NOW_DUE);
        assert.equal(sent.length, 0, 'помеченным повторно не шлём');
        assert.equal(await alertedAtOf(G1), before1, 'telegram_alert_at не переписан');
    });

    test('поздний гость: досылается поштучно после первичной рассылки', async () => {
        // G1..G3 уже alerted -> already_alerted>0 -> per-guest ветка
        await addGuestlistEntry(G4, ['Hugo Mann'], '2030-06-14T10:00:00Z', null);
        sent = [];
        await runTick(pool, CONFIG, NOW_DUE);

        assert.equal(sent.length, 1, 'одно сообщение — только новому гостю');
        assert.equal(
            sent[0]?.body.text,
            '*Neon Night*\nДобавился в гест\\-лист\n\n```\nDmitry Orlov\nHugo Mann\n```',
        );
        assert.notEqual(await alertedAtOf(G4), null, 'G4 помечен');
    });

    test('до 18:00 не шлём', async () => {
        await seed();
        sent = [];
        await addGuestlistEntry(G1, null, '2030-06-10T10:00:00Z', null);
        await runTick(pool, CONFIG, NOW_BEFORE_18);
        assert.equal(sent.length, 0, 'порог 18:00 не наступил');
        assert.equal(await alertedAtOf(G1), null, 'ничего не помечено');
    });

    test('после старта вечеринки не шлём', async () => {
        await seed();
        sent = [];
        await addGuestlistEntry(G1, null, '2030-06-10T10:00:00Z', null);
        await runTick(pool, CONFIG, NOW_AFTER_START);
        assert.equal(sent.length, 0, 'вечеринка уже началась — окно закрыто');
        assert.equal(await alertedAtOf(G1), null);
    });

    test('сбой Telegram: гости остаются непомеченными, без throw', async () => {
        await seed();
        sent = [];
        telegramOk = false;
        await addGuestlistEntry(G1, null, '2030-06-10T10:00:00Z', null);
        await runTick(pool, CONFIG, NOW_DUE); // не бросает — ловится по-вечериночно
        assert.equal(sent.length, 1, 'попытка отправки была');
        assert.equal(await alertedAtOf(G1), null, 'не помечен — досыл на следующем тике');
        telegramOk = true;
    });

    test('buildMessage: заголовок + code-block, спецсимволы экранированы', () => {
        assert.equal(
            buildMessage('P', 'Гест-лист', [{ first_name: 'X', last_name: null, friends: null }]),
            '*P*\nГест\\-лист\n\n```\nX\n```',
        );
        // спецсимволы в названии экранируются для MarkdownV2, имена в code-block — как есть
        assert.equal(
            buildMessage('A.B*C', 'H', [{ first_name: 'Sam', last_name: 'Lee', friends: null }]),
            '*A\\.B\\*C*\nH\n\n```\nSam Lee\n```',
        );
    });

    test('buildMessage: кириллица имён → латиница, латиница как есть', () => {
        assert.equal(
            buildMessage('Surf Club', 'Гест-лист', [
                { first_name: 'Иван', last_name: 'Петров', friends: ['Щукин Юрий'] },
                { first_name: 'Emma', last_name: 'Johnson', friends: null },
            ]),
            '*Surf Club*\nГест\\-лист\n\n```\nIvan Petrov\nShchukin Yurii\nEmma Johnson\n```',
        );
    });
});
