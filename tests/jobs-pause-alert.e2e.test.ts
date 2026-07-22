import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { buildAlert, CLAIM_LIMIT, runTick } from '#Jobs/PauseAlertEntry.js';
import { closePool, dbQuery, fmt, measure } from './helpers/e2e.ts';

const CONFIG = {
    databaseUrl: process.env.DATABASE_URL ?? '',
    telegramBotToken: 'E2E_TOKEN',
    telegramGroupId: 'E2E_GROUP',
};

const PHONE1 = 'E2E_PA_+79990000001';
const PHONE2 = 'E2E_PA_+79990000002';
const GUEST1 = 'E2E_PA_G1';

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
    await dbQuery(`insert into guests (id, wa_phone, first_name, last_name) values ($1,$2,$3,$4)`, [
        GUEST1,
        PHONE1,
        'Анна',
        'Смирнова',
    ]);
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

const alertedAtOf = async (phone: string): Promise<string | null> => {
    const rows = await dbQuery<{ pause_alerted_at: Date | null }>(
        `select pause_alerted_at from wa_chats where wa_phone = $1`,
        [phone],
    );
    const value = rows[0]?.pause_alerted_at ?? null;
    return value ? value.toISOString() : null;
};

const cleanup = async () => {
    await dbQuery(`delete from wa_chats where wa_phone like 'E2E_PA_%'`);
    await dbQuery(`delete from guests where id like 'E2E_PA_%'`);
};

describe('e2e: jobs-pause-alert', () => {
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

    test('пауза с именем → алерт по шаблону, чат помечен', async () => {
        await seed();
        sent = [];
        telegramOk = true;
        await addChat(PHONE1, GUEST1, '2026-07-01T10:00:00Z', 'Гость спрашивает про скидку', null);

        const { ms } = await measure('runTick', () => runTick(pool, CONFIG));

        assert.equal(sent.length, 1, 'один алерт');
        assert.equal(sent[0]?.body.chat_id, 'E2E_GROUP');
        assert.equal(sent[0]?.body.parse_mode, 'MarkdownV2');
        assert.match(sent[0]?.url ?? '', /api\.telegram\.org\/botE2E_TOKEN\/sendMessage/);
        assert.equal(
            sent[0]?.body.text,
            '🙋 *Нужен ответ*\n*Гость:* E2E\\_PA\\_\\+79990000001 \\(Анна Смирнова\\)\n*Причина:* Гость спрашивает про скидку',
        );
        assert.notEqual(await alertedAtOf(PHONE1), null, 'помечен pause_alerted_at');
        console.log(`[e2e] pause-alert — ${fmt(ms)}`);
    });

    test('идемпотентность: повторный тик не шлёт и не переписывает', async () => {
        const before1 = await alertedAtOf(PHONE1);
        sent = [];
        await runTick(pool, CONFIG);
        assert.equal(sent.length, 0, 'помеченному повторно не шлём');
        assert.equal(await alertedAtOf(PHONE1), before1, 'pause_alerted_at не переписан');
    });

    test('ре-пауза после снятия → алерт повторяется', async () => {
        // симулируем снятие+новую паузу: paused_at свежее прошлого pause_alerted_at
        await dbQuery(
            `update wa_chats set paused_at = pause_alerted_at + interval '1 second' where wa_phone = $1`,
            [PHONE1],
        );
        sent = [];
        await runTick(pool, CONFIG);
        assert.equal(sent.length, 1, 'новая пауза → новый алерт');
        assert.notEqual(await alertedAtOf(PHONE1), null);
    });

    test('без имени гостя → только телефон', async () => {
        await seed();
        sent = [];
        await addChat(PHONE2, null, '2026-07-01T10:00:00Z', 'Личный вопрос к Сёме', null);
        await runTick(pool, CONFIG);
        assert.equal(sent.length, 1);
        assert.equal(
            sent[0]?.body.text,
            '🙋 *Нужен ответ*\n*Гость:* E2E\\_PA\\_\\+79990000002\n*Причина:* Личный вопрос к Сёме',
        );
    });

    test('чат не на паузе → не шлём', async () => {
        await seed();
        sent = [];
        await addChat(PHONE2, null, null, null, null);
        await runTick(pool, CONFIG);
        assert.equal(sent.length, 0);
        assert.equal(await alertedAtOf(PHONE2), null);
    });

    test('сбой Telegram: не помечаем, без throw', async () => {
        await seed();
        sent = [];
        telegramOk = false;
        await addChat(PHONE2, null, '2026-07-01T10:00:00Z', 'Жалоба', null);
        await runTick(pool, CONFIG);
        assert.equal(sent.length, 1, 'попытка была');
        assert.equal(await alertedAtOf(PHONE2), null, 'откат — досыл на следующем тике');
        telegramOk = true;
    });

    test('лимит за тик: шлём максимум CLAIM_LIMIT, остаток — следующим тиком', async () => {
        await seed();
        sent = [];
        telegramOk = true;
        const total = CLAIM_LIMIT + 3;
        for (let i = 0; i < total; i += 1) {
            // paused_at по возрастанию: order by paused_at гарантирует, что остаток — самые свежие
            await addChat(
                `E2E_PA_LIMIT_${i}`,
                null,
                `2026-07-01T10:00:${String(i).padStart(2, '0')}Z`,
                'нужен человек',
                null,
            );
        }

        await runTick(pool, CONFIG);
        assert.equal(sent.length, CLAIM_LIMIT, 'за тик не больше лимита');
        const markedFirst = await dbQuery<{ n: string }>(
            `select count(*)::text as n from wa_chats where wa_phone like 'E2E_PA_LIMIT_%' and pause_alerted_at is not null`,
        );
        assert.equal(markedFirst[0]?.n, String(CLAIM_LIMIT), 'помечено ровно лимит');

        sent = [];
        await runTick(pool, CONFIG);
        assert.equal(sent.length, total - CLAIM_LIMIT, 'остаток уехал следующим тиком');
        const markedAll = await dbQuery<{ n: string }>(
            `select count(*)::text as n from wa_chats where wa_phone like 'E2E_PA_LIMIT_%' and pause_alerted_at is not null`,
        );
        assert.equal(markedAll[0]?.n, String(total), 'в итоге помечены все');
    });

    test('buildAlert: с именем, без имени, спецсимволы экранированы', () => {
        assert.equal(
            buildAlert('Анна Смирнова', '+79990000001', 'Скидка на стол'),
            '🙋 *Нужен ответ*\n*Гость:* \\+79990000001 \\(Анна Смирнова\\)\n*Причина:* Скидка на стол',
        );
        assert.equal(
            buildAlert(null, '+79990000002', 'Вопрос'),
            '🙋 *Нужен ответ*\n*Гость:* \\+79990000002\n*Причина:* Вопрос',
        );
        // MarkdownV2-спецсимволы в причине экранируются
        assert.equal(
            buildAlert(null, '+7', 'скидка 50% (важно!)'),
            '🙋 *Нужен ответ*\n*Гость:* \\+7\n*Причина:* скидка 50% \\(важно\\!\\)',
        );
    });
});
