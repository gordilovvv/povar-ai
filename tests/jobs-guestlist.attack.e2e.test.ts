// Attack-приёмка: GuestlistEntry.runTick (фоновый тред Telegram-рассылки guest-list).
// Каждая проба бьёт runTick напрямую и сверяется с фактом в БД, Telegram мокаем через
// globalThis.fetch (реальный api.telegram.org дёргать нельзя). Чистим строго свои E2E_atk_gl_*.
//
// Новый контракт (MarkdownV2): buildMessage → `*escapeMd(name)*\n{header}\n\n```\nname\n...\n````
// (список БЕЗ нумерации — просто escapeCode(name) построчно).
// escapeMd (полный набор спецсимволов MarkdownV2) — только к НАЗВАНИЮ в `*...*`;
// escapeCode (только ` и \) — к именам ВНУТРИ code-block.
//
// Векторы:
//   - экранирование/breakout: имя/друг/название с backtick `, с ``` и с \ — гость НЕ может
//     закрыть code-block и подделать разметку (escapeCode), название с MarkdownV2-спецсимволами
//     экранируется в заголовке (escapeMd);
//   - инъекция: SQL-мета (' " ) ; %L drop) в имени/друге/названии — не ломает запрос
//     (таблицы целы через to_regclass) и уходит как данные;
//   - гонка/идемпотентность: два параллельных runTick на одну вечеринку НЕ задваивают отправку;
//   - граница 18:00 Дубая: за секунду до порога не шлём, ровно в порог — шлём;
//   - гость без имени и без друзей: пустых строк в code-block нет.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { runTick } from '#Jobs/GuestlistEntry.js';
import { closePool, dbOne, dbQuery } from './helpers/e2e.ts';

const CONFIG = {
    databaseUrl: process.env.DATABASE_URL ?? '',
    telegramBotToken: 'E2E_atk_gl_token',
    telegramGroupId: 'E2E_atk_gl_group',
};

// Дубай = UTC+4. Старт 22:00 Дубай = 18:00Z; порог 18:00 Дубай того же дня = 14:00Z.
const PARTY_START = '2031-06-15T18:00:00Z';
const NOW_DUE = '2031-06-15T15:00:00Z'; // 19:00 Дубай: после порога, до старта

// Отдельные party_id под каждый кейс, чтобы кейсы не мешали друг другу.
const P_INJ = 'E2E_atk_gl_inj';
const P_ESC = 'E2E_atk_gl_esc';
const P_RACE = 'E2E_atk_gl_race';
const P_EDGE = 'E2E_atk_gl_edge';
const P_EMPTY = 'E2E_atk_gl_empty';
const P_TRL = 'E2E_atk_gl_trl';
const ALL_PARTIES = [P_INJ, P_ESC, P_RACE, P_EDGE, P_EMPTY, P_TRL];

const guestId = (party: string, n: number) => `${party}_g${n}`;

interface FetchCall {
    url: string;
    body: { chat_id: string; text: string; parse_mode?: string };
}

let sent: FetchCall[] = [];
let sendDelayMs = 0;
const realFetch = globalThis.fetch;

const stubFetch = () => {
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
        const body = JSON.parse(init?.body ?? '{}');
        if (sendDelayMs > 0) {
            await new Promise((r) => setTimeout(r, sendDelayMs));
        }
        sent.push({ url: String(url), body });
        return { json: async () => ({ ok: true, description: 'stub' }) } as Response;
    }) as typeof fetch;
};

const seedParty = async (partyId: string, name: string, startAt: string) => {
    await dbQuery(`insert into party (id, type, name, location) values ($1,'owned',$2,'Dubai')`, [
        partyId,
        name,
    ]);
    await dbQuery(`insert into party_time (party_id, party_start_at) values ($1,$2)`, [
        partyId,
        startAt,
    ]);
};

const seedGuest = async (
    id: string,
    partyId: string,
    first: string | null,
    last: string | null,
    friends: string[] | null,
    joinedAt: string,
) => {
    await dbQuery(`insert into guests (id, wa_phone, first_name, last_name) values ($1,$2,$3,$4)`, [
        id,
        `wa_${id}`,
        first,
        last,
    ]);
    await dbQuery(
        `insert into party_guestlist (party_id, guest_id, joined_at, friends, telegram_alert_at)
         values ($1,$2,$3,$4,null)`,
        [partyId, id, joinedAt, friends],
    );
};

const cleanup = async () => {
    await dbQuery(`delete from party_guestlist where party_id = any($1)`, [ALL_PARTIES]);
    await dbQuery(`delete from party_time where party_id = any($1)`, [ALL_PARTIES]);
    await dbQuery(`delete from party where id = any($1)`, [ALL_PARTIES]);
    await dbQuery(`delete from guests where id like 'E2E_atk_gl_%'`);
};

describe('attack: jobs-guestlist', () => {
    let pool: pg.Pool;

    before(async () => {
        pool = new pg.Pool({ connectionString: CONFIG.databaseUrl });
        stubFetch();
        await cleanup();
    });

    after(async () => {
        globalThis.fetch = realFetch;
        await cleanup();
        await pool.end();
        await closePool();
    });

    test('экранирование: backtick/``` /\\ у гостя не ломают code-block; спецсимволы названия экранируются', async () => {
        // Название с MarkdownV2-спецсимволами -> escapeMd в заголовке `*...*`.
        // escapeMd('Rave.*') = 'Rave\\.\\*'
        await seedParty(P_ESC, 'Rave.*', PARTY_START);
        // Гость 1 (раньше): backtick в фамилии.  Гость 2 (позже): backslash + попытка ``` breakout.
        await seedGuest(guestId(P_ESC, 1), P_ESC, 'Neo', '`root`', null, '2031-06-10T10:00:00Z');
        await seedGuest(
            guestId(P_ESC, 2),
            P_ESC,
            'C:\\path',
            null,
            ['```evil```'],
            '2031-06-10T11:00:00Z',
        );

        sent = [];
        await runTick(pool, CONFIG, NOW_DUE);

        assert.equal(sent.length, 1, 'одно широковещательное сообщение');
        assert.equal(sent[0]?.body.parse_mode, 'MarkdownV2', 'parse_mode MarkdownV2');
        const text = sent[0]?.body.text ?? '';

        // Точный ожидаемый текст: название экранировано escapeMd, имена — escapeCode (только ` и \).
        const expected =
            '*Rave\\.\\**\nГест\\-лист\n\n```\nNeo \\`root\\`\nC:\\\\path\n\\`\\`\\`evil\\`\\`\\`\n```';
        assert.equal(text, expected, 'MarkdownV2 экранирование посимвольно совпадает');

        // Ключевой инвариант breakout: НЕэкранированных code-fence (```) ровно два — открытие и
        // закрытие. Если бы escapeCode не срабатывал, друг '```evil```' добавил бы ещё фенсы.
        assert.equal(
            text.split('```').length - 1,
            2,
            'ровно два code-fence — гость не вышел из блока',
        );
    });

    test('инъекция: SQL-мета в имени/друге/названии не ломает запрос и уходит как данные', async () => {
        // Без backtick/backslash -> escapeCode внутри блока оставляет имена verbatim.
        const evilName = `Neon');DROP TABLE guests;-- %L`;
        const evilFirst = `Bob');DROP TABLE guests;--`;
        const evilFriend = `Eve');delete from party_guestlist;--`;
        await seedParty(P_INJ, evilName, PARTY_START);
        await seedGuest(
            guestId(P_INJ, 1),
            P_INJ,
            evilFirst,
            null,
            [evilFriend],
            '2031-06-10T10:00:00Z',
        );

        sent = [];
        await runTick(pool, CONFIG, NOW_DUE);

        // Таблицы целы — инъекция не выполнилась.
        const g = await dbOne<{ r: string | null }>(`select to_regclass('public.guests') as r`);
        const pl = await dbOne<{ r: string | null }>(
            `select to_regclass('public.party_guestlist') as r`,
        );
        assert.notEqual(g?.r, null, 'guests таблица цела');
        assert.notEqual(pl?.r, null, 'party_guestlist таблица цела');

        // Данные без ` и \ уходят в code-block verbatim.
        assert.equal(sent.length, 1, 'одно сообщение');
        const text = sent[0]?.body.text ?? '';
        assert.ok(text.startsWith('*'), 'название в bold (*...*)');
        assert.ok(text.includes(evilFirst), 'имя гостя verbatim в code-block');
        assert.ok(text.includes(evilFriend), 'имя друга verbatim в code-block');

        // Ничего не удалено сторонним DELETE.
        const cnt = await dbOne<{ c: string }>(
            `select count(*)::text as c from party_guestlist where party_id = $1`,
            [P_INJ],
        );
        assert.equal(cnt?.c, '1', 'запись гостя на месте');
    });

    test('ГОНКА: два параллельных runTick не задваивают широковещательную отправку', async () => {
        await seedParty(P_RACE, 'Race Party', PARTY_START);
        await seedGuest(guestId(P_RACE, 1), P_RACE, 'Anna', 'Race', null, '2031-06-10T10:00:00Z');
        await seedGuest(guestId(P_RACE, 2), P_RACE, 'Boris', 'Race', null, '2031-06-10T11:00:00Z');

        // Прогреваем пул: оба runTick должны переиспользовать idle-клиентов и реально
        // выполнить select одновременно (иначе один платит латентность нового коннекта и
        // читает уже помеченное состояние — гонка не воспроизводится).
        await Promise.all(Array.from({ length: 6 }, () => pool.query('select pg_sleep(0.05)')));

        sent = [];
        sendDelayMs = 300; // держим отправку, чтобы оба select точно прочитали already_alerted=0
        const results = await Promise.allSettled([
            runTick(pool, CONFIG, NOW_DUE),
            runTick(pool, CONFIG, NOW_DUE),
        ]);
        sendDelayMs = 0;
        for (const r of results) {
            assert.equal(r.status, 'fulfilled', 'runTick не должен падать');
        }

        // ИНВАРИАНТ: гостям Race Party ушла РОВНО ОДНА рассылка, а не две.
        const raceSends = sent.filter((s) => s.body.text.startsWith('*Race Party*\n'));
        assert.equal(
            raceSends.length,
            1,
            `задвоение отправки: в группу ушло ${raceSends.length} широковещательных сообщений вместо 1`,
        );

        // DB-инвариант: оба гостя помечены ровно один раз (guard на записи держит).
        const marked = await dbQuery<{ guest_id: string }>(
            `select guest_id from party_guestlist
             where party_id = $1 and telegram_alert_at is not null`,
            [P_RACE],
        );
        assert.equal(marked.length, 2, 'оба гостя помечены');
    });

    test('граница 18:00 Дубая: за секунду до порога — молчим, ровно в порог — шлём', async () => {
        await seedParty(P_EDGE, 'Edge Party', PARTY_START);
        await seedGuest(guestId(P_EDGE, 1), P_EDGE, 'Edge', 'Guest', null, '2031-06-10T10:00:00Z');

        // Порог = 14:00Z (18:00 Дубай). За секунду до — 13:59:59Z.
        sent = [];
        await runTick(pool, CONFIG, '2031-06-15T13:59:59Z');
        assert.equal(sent.length, 0, 'за секунду до 18:00 не шлём');
        assert.equal(await alertedCount(P_EDGE), 0, 'ничего не помечено до порога');

        // Ровно в порог — 14:00:00Z.
        sent = [];
        await runTick(pool, CONFIG, '2031-06-15T14:00:00Z');
        assert.equal(sent.length, 1, 'ровно в 18:00 Дубая шлём');
        assert.equal(await alertedCount(P_EDGE), 1, 'гость помечен');
    });

    test('транслит: кириллица + backtick/``` /\\ вперемешку не ломают code-block (escapeCode ПОСЛЕ transform)', async () => {
        // Транслит идёт ДО escapeCode. Вектор: может ли кириллица/юникод после transform дать
        // символ, закрывающий code-block в обход escapeCode? Нет: transform не порождает ` и \ из
        // кириллицы (ь->', ъ->''), а существующие ` и \ доносит до escapeCode, который их и режет.
        // Название кириллицей НЕ транслитерируется (только escapeMd) — остаётся 'Клуб'.
        await seedParty(P_TRL, 'Клуб', PARTY_START);
        // Гость 1 (раньше): чистая кириллица -> латиница; друг с щ/ю -> Shchukin Yurii.
        await seedGuest(
            guestId(P_TRL, 1),
            P_TRL,
            'Иван',
            'Петров',
            ['Щукин Юрий'],
            '2031-06-10T10:00:00Z',
        );
        // Гость 2 (позже): кириллица вперемешку с ```, \ и backtick — попытка breakout ПОСЛЕ транслита.
        await seedGuest(
            guestId(P_TRL, 2),
            P_TRL,
            'Зло',
            null,
            ['```Аня```', 'C:\\Юра', 'Костя`;DROP'],
            '2031-06-10T11:00:00Z',
        );

        sent = [];
        await runTick(pool, CONFIG, NOW_DUE);

        assert.equal(sent.length, 1, 'одно широковещательное сообщение');
        assert.equal(sent[0]?.body.parse_mode, 'MarkdownV2', 'parse_mode MarkdownV2');
        const text = sent[0]?.body.text ?? '';

        // Посимвольно: кириллица имён -> латиница (transform), затем ` и \ экранированы (escapeCode).
        const expected =
            '*Клуб*\nГест\\-лист\n\n```\nIvan Petrov\nShchukin Yurii\nZlo\n\\`\\`\\`Anya\\`\\`\\`\nC:\\\\Yura\nKostya\\`;DROP\n```';
        assert.equal(text, expected, 'транслит+escapeCode посимвольно совпадает');

        // Транслит реально сработал: кириллицы в именах не осталось, латиница на месте.
        const list = text.split('```')[1] ?? '';
        assert.ok(!/[А-Яа-яЁё]/.test(list), 'в code-block нет кириллицы — имена транслитерированы');
        assert.ok(list.includes('Shchukin Yurii'), 'Щукин Юрий -> Shchukin Yurii');

        // Breakout-инвариант: НЕэкранированных code-fence ровно два (открытие/закрытие). Друг
        // '```Аня```' после transform даёт сырые ```, но escapeCode (ПОСЛЕ) их режет в \`\`\`.
        assert.equal(
            text.split('```').length - 1,
            2,
            'ровно два code-fence — транслит не открыл дыру в обход escapeCode',
        );
    });

    test('гость без имени и без друзей: пустые строки не создают пункт "N. "', async () => {
        await seedParty(P_EMPTY, 'Empty Party', PARTY_START);
        // Named-гость + гость с пустыми полями и пустыми друзьями.
        await seedGuest(guestId(P_EMPTY, 1), P_EMPTY, 'Named', 'One', null, '2031-06-10T10:00:00Z');
        await seedGuest(guestId(P_EMPTY, 2), P_EMPTY, '', '', ['', '   '], '2031-06-10T11:00:00Z');

        sent = [];
        await runTick(pool, CONFIG, NOW_DUE);
        assert.equal(sent.length, 1, 'одно сообщение');
        const text = sent[0]?.body.text ?? '';
        // Ровно одно имя (Named One); пустой гость/друзья не создают строк.
        assert.equal(text, '*Empty Party*\nГест\\-лист\n\n```\nNamed One\n```');
        // Инвариант: в code-block нет пустых строк (пустой гость просочился бы как пустая строка).
        const listBody = (text.split('```')[1] ?? '').replace(/^\n/, '').replace(/\n$/, '');
        assert.ok(
            !listBody.split('\n').some((line) => line.trim() === ''),
            'нет пустой строки в code-block от пустого гостя/друга',
        );
        assert.equal(listBody.split('\n').length, 1, 'ровно одна строка-имя в списке');
    });

    const alertedCount = async (partyId: string): Promise<number> => {
        const row = await dbOne<{ c: string }>(
            `select count(*)::text as c from party_guestlist
             where party_id = $1 and telegram_alert_at is not null`,
            [partyId],
        );
        return Number(row?.c ?? '0');
    };
});
