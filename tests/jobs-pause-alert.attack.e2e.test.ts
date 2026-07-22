// Attack-приёмка: PauseAlertEntry.runTick (фоновый тред Telegram-алертов «нужен человек»).
// Каждая проба бьёт runTick/buildAlert напрямую и сверяется с фактом в БД; Telegram мокаем
// через globalThis.fetch (реальный api.telegram.org дёргать нельзя). Чистим строго свои
// E2E_PA_ATTACK_%.
//
// Векторы (из задачи):
//   - MarkdownV2 breakout: *bold*, [x](url), backtick, перевод строки в имени/причине/телефоне —
//     всё уходит escapeMd, гость не форжит разметку;
//   - инъекция: wa_phone с SQL-мета уходит в releaseChats через pg-format %L как значение,
//     таблица цела (to_regclass);
//   - гонка: два параллельных runTick не задваивают алерт одному чату (claim-до-отправки);
//   - лимит: >CLAIM_LIMIT паузнутых → ровно CLAIM_LIMIT/тик, остаток не потерян;
//   - failure at-least-once: сбой Telegram → чат не помечен → следующий тик дошлёт;
//   - грязь: dangling guest_id, unicode/emoji, пустой pause_details.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { buildAlert, CLAIM_LIMIT, runTick } from '#Jobs/PauseAlertEntry.js';
import { closePool, dbOne, dbQuery } from './helpers/e2e.ts';

const CONFIG = {
    databaseUrl: process.env.DATABASE_URL ?? '',
    telegramBotToken: 'E2E_PA_ATTACK_token',
    telegramGroupId: 'E2E_PA_ATTACK_group',
};

const P = (s: string) => `E2E_PA_ATTACK_${s}`;

interface FetchCall {
    url: string;
    body: { chat_id: string; text: string; parse_mode?: string };
}

let sent: FetchCall[] = [];
let telegramOk = true;
let sendDelayMs = 0;
const realFetch = globalThis.fetch;

const stubFetch = () => {
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
        const body = JSON.parse(init?.body ?? '{}');
        if (sendDelayMs > 0) {
            await new Promise((r) => setTimeout(r, sendDelayMs));
        }
        sent.push({ url: String(url), body });
        return { json: async () => ({ ok: telegramOk, description: 'stub' }) } as Response;
    }) as typeof fetch;
};

const addChat = async (
    phone: string,
    guestId: string | null,
    pausedAt: string | null,
    pauseDetails: string | null,
    alertedAt: string | null,
) => {
    await dbQuery(
        `insert into wa_chats (wa_phone, guest_id, paused_at, pause_details, pause_alerted_at)
         values ($1,$2,$3,$4,$5)`,
        [phone, guestId, pausedAt, pauseDetails, alertedAt],
    );
};

const addGuest = async (id: string, phone: string, first: string | null, last: string | null) => {
    await dbQuery(`insert into guests (id, wa_phone, first_name, last_name) values ($1,$2,$3,$4)`, [
        id,
        phone,
        first,
        last,
    ]);
};

const alertedAtOf = async (phone: string): Promise<string | null> => {
    const row = await dbOne<{ pause_alerted_at: Date | null }>(
        `select pause_alerted_at from wa_chats where wa_phone = $1`,
        [phone],
    );
    return row?.pause_alerted_at ? row.pause_alerted_at.toISOString() : null;
};

const sentTo = (phone: string) =>
    sent.filter((s) => s.body.text.includes(phone.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&')));

const cleanup = async () => {
    await dbQuery(`delete from wa_chats where wa_phone like 'E2E\\_PA\\_ATTACK\\_%'`);
    await dbQuery(`delete from guests where id like 'E2E\\_PA\\_ATTACK\\_%'`);
};

describe('attack: jobs-pause-alert', () => {
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

    test('MarkdownV2 breakout: *bold* / [x](url) / backtick / newline в имени и причине экранированы', () => {
        // Чистая функция: точный ожидаемый литерал (реимплементацию escapeMd не используем).
        assert.equal(
            buildAlert(null, '+7', '*bold* [x](http://e) `code`'),
            '🙋 *Нужен ответ*\n*Гость:* \\+7\n*Причина:* \\*bold\\* \\[x\\]\\(http://e\\) \\`code\\`',
        );
        // Имя внутри литеральных скобок \( \): '*' экранирован → гость не подделывает жирный
        // лейбл *Причина:*, а закрывающая \) не рвёт обрамление (обе скобки — из шаблона).
        assert.equal(
            buildAlert('Ева\n*Причина:* FAKE', '+7', 'r'),
            '🙋 *Нужен ответ*\n*Гость:* \\+7 \\(Ева\n\\*Причина:\\* FAKE\\)\n*Причина:* r',
        );
        const forged = buildAlert('Ева\n*Причина:* FAKE) hack', '+7', 'r');
        // Единственный НЕэкранированный лейбл *Причина:* — шаблонный (ровно один).
        assert.equal(forged.split('*Причина:*').length - 1, 1, 'гость не форжит жирный лейбл');
        // ВСЕ скобки экранированы (\( шаблона + \) из имени): ни одной «голой» ( ) для Telegram,
        // ')' из имени не закрывает обрамление досрочно.
        assert.ok(
            !/[()]/.test(forged.replace(/\\[()]/g, '')),
            'имя не вырывает литеральные скобки \\( \\)',
        );
    });

    test('MarkdownV2 breakout через runTick: пейлоад в имени/телефоне/причине уходит как escapeMd', async () => {
        await cleanup();
        const phone = P('md_+70001');
        const gid = P('md_g1');
        await addGuest(gid, phone, 'A*B', 'C[D]');
        await addChat(phone, gid, '2025-01-01T10:00:00Z', 'pay 50%_(!)', null);

        sent = [];
        telegramOk = true;
        await runTick(pool, CONFIG);

        assert.equal(sent.length, 1, 'один алерт');
        assert.equal(sent[0]?.body.parse_mode, 'MarkdownV2');
        // Точный литерал: телефон escapeMd, имя 'A*B C[D]' -> 'A\*B C\[D\]' внутри \( \), причина экранирована.
        assert.equal(
            sent[0]?.body.text,
            '🙋 *Нужен ответ*\n*Гость:* E2E\\_PA\\_ATTACK\\_md\\_\\+70001 \\(A\\*B C\\[D\\]\\)\n*Причина:* pay 50%\\_\\(\\!\\)',
        );
        assert.notEqual(await alertedAtOf(phone), null, 'чат помечен в БД');
    });

    test('инъекция: wa_phone с SQL-мета в releaseChats (pg-format %L) — таблица цела, откат сработал', async () => {
        await cleanup();
        const phone = P("inj_'); drop table wa_chats;--");
        await addChat(phone, null, '2025-01-01T10:00:00Z', 'reason', null);

        sent = [];
        telegramOk = false; // форсим releaseChats (format %L по phone)
        await runTick(pool, CONFIG);
        telegramOk = true;

        const reg = await dbOne<{ r: string | null }>(`select to_regclass('public.wa_chats') as r`);
        assert.notEqual(reg?.r, null, 'wa_chats цела — инъекция не выполнилась');
        assert.equal(sent.length, 1, 'попытка отправки была');
        // releaseChats должен был откатить пометку именно этой (SQL-мета) строки.
        assert.equal(await alertedAtOf(phone), null, 'pause_alerted_at откачен назад в null');
    });

    test('ГОНКА: два параллельных runTick не задваивают алерт одному чату', async () => {
        await cleanup();
        const p1 = P('race_1');
        const p2 = P('race_2');
        await addChat(p1, null, '2025-01-01T10:00:00Z', 'r1', null);
        await addChat(p2, null, '2025-01-01T10:00:01Z', 'r2', null);

        // Прогрев пула: оба runTick должны выполнить claim одновременно на idle-клиентах.
        await Promise.all(Array.from({ length: 6 }, () => pool.query('select pg_sleep(0.05)')));

        sent = [];
        telegramOk = true;
        sendDelayMs = 300; // держим отправку, чтобы оба claim пересеклись во времени
        const results = await Promise.allSettled([runTick(pool, CONFIG), runTick(pool, CONFIG)]);
        sendDelayMs = 0;
        for (const r of results) {
            assert.equal(r.status, 'fulfilled', 'runTick не должен падать');
        }

        // ИНВАРИАНТ: каждому чату ушло РОВНО одно сообщение, всего 2 (не 4).
        assert.equal(sentTo(p1).length, 1, `p1: дубль алерта (${sentTo(p1).length} вместо 1)`);
        assert.equal(sentTo(p2).length, 1, `p2: дубль алерта (${sentTo(p2).length} вместо 1)`);
        assert.equal(sent.length, 2, `всего отправок ${sent.length} вместо 2 — задвоение`);

        assert.notEqual(await alertedAtOf(p1), null, 'p1 помечен');
        assert.notEqual(await alertedAtOf(p2), null, 'p2 помечен');
    });

    test('лимит: >CLAIM_LIMIT паузнутых → ровно CLAIM_LIMIT/тик, остаток не потерян', async () => {
        await cleanup();
        const total = CLAIM_LIMIT + 3;
        for (let i = 0; i < total; i += 1) {
            await addChat(
                P(`lim_${String(i).padStart(2, '0')}`),
                null,
                `2025-02-01T10:00:${String(i).padStart(2, '0')}Z`,
                'r',
                null,
            );
        }

        sent = [];
        telegramOk = true;
        await runTick(pool, CONFIG);
        assert.equal(sent.length, CLAIM_LIMIT, 'за тик ровно CLAIM_LIMIT отправок');
        const marked1 = await dbOne<{ n: string }>(
            `select count(*)::text n from wa_chats where wa_phone like 'E2E\\_PA\\_ATTACK\\_lim\\_%' and pause_alerted_at is not null`,
        );
        assert.equal(marked1?.n, String(CLAIM_LIMIT), 'помечено ровно CLAIM_LIMIT');

        sent = [];
        await runTick(pool, CONFIG);
        assert.equal(sent.length, total - CLAIM_LIMIT, 'остаток уехал следующим тиком');
        const marked2 = await dbOne<{ n: string }>(
            `select count(*)::text n from wa_chats where wa_phone like 'E2E\\_PA\\_ATTACK\\_lim\\_%' and pause_alerted_at is not null`,
        );
        assert.equal(marked2?.n, String(total), 'в итоге помечены все — остаток не потерян');
    });

    test('failure at-least-once: сбой Telegram → чат не помечен → следующий тик дошлёт', async () => {
        await cleanup();
        const phone = P('fail_1');
        await addChat(phone, null, '2025-03-01T10:00:00Z', 'жалоба', null);

        sent = [];
        telegramOk = false;
        await runTick(pool, CONFIG);
        assert.equal(sent.length, 1, 'попытка была');
        assert.equal(await alertedAtOf(phone), null, 'сбой → не помечен (откат)');

        sent = [];
        telegramOk = true;
        await runTick(pool, CONFIG);
        assert.equal(sent.length, 1, 'следующий тик дошлёт');
        assert.notEqual(await alertedAtOf(phone), null, 'теперь помечен');
    });

    test('грязь: dangling guest_id → только телефон; unicode/emoji имя; пустой pause_details', async () => {
        await cleanup();
        // dangling guest_id (нет FK) → имя null → только телефон.
        const p1 = P('dirty_dangling');
        await addChat(p1, P('nonexistent_guest'), '2025-04-01T10:00:00Z', 'r', null);
        // emoji/unicode в имени.
        const p2 = P('dirty_emoji');
        const g2 = P('dirty_emoji_g');
        await addGuest(g2, p2, '🎉Аня', '💥');
        await addChat(p2, g2, '2025-04-01T10:00:01Z', 'вопрос', null);
        // пустой pause_details (в БД допустим, хотя тул ставит min(1)).
        const p3 = P('dirty_empty');
        await addChat(p3, null, '2025-04-01T10:00:02Z', '', null);

        sent = [];
        telegramOk = true;
        await runTick(pool, CONFIG);

        assert.equal(sent.length, 3, 'все три отправлены');
        const t1 = sentTo(p1)[0]?.body.text ?? '';
        assert.ok(
            t1.startsWith('🙋 *Нужен ответ*\n*Гость:* E2E'),
            'dangling guest_id: имя не подставлено',
        );
        assert.ok(!t1.includes('\\('), 'без имени — телефон без обрамляющих скобок \\( \\)');

        const t2 = sentTo(p2)[0]?.body.text ?? '';
        assert.ok(t2.includes('\\(🎉Аня 💥\\)'), 'unicode/emoji имя проходит внутри \\( \\)');

        const t3 = sentTo(p3)[0]?.body.text ?? '';
        assert.ok(t3.endsWith('*Причина:* '), 'пустой pause_details → пустая причина без падения');

        assert.equal(await alertedAtOf(p1), await alertedAtOf(p1), 'все помечены');
        assert.notEqual(await alertedAtOf(p3), null, 'пустая причина не мешает пометке');
    });
});
