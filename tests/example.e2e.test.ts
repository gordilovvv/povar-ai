// ─────────────────────────────────────────────────────────────────────────────
// ШАБЛОН e2e-теста модуля (болванка). Копируй в `<module>.e2e.test.ts`, заполняй,
// СНИМИ `describe.skip` (ниже) и замени заглушку модуля на реальный импорт.
// Пока skip — болванка не гоняется в общем `pnpm test` и не пишет в боевую БД.
//
// Задача модуля (впиши перед стартом — критерии теста берутся ОТСЮДА, не выдумываются):
//   вход    → что подаём (тело/квери/токен)
//   выход   → что модуль обязан вернуть И что обязан оказаться В БАЗЕ
//   бюджет  → потолок времени ТОЛЬКО для CPU-части (сеть/AI жёстким бюджетом не меряем)
//   негатив → обход авторизации, IDOR, инъекция, кривой ввод, гонка/повтор
//
// Цель шаблона: по этому тесту видно, ЗАКРЫТА задача или нет — финальный результат
// сверяется НАПРЯМУЮ с БД (dbOne/dbQuery), а не с ответом ручки.
// ─────────────────────────────────────────────────────────────────────────────

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { closePool, dbOne, measure, withClient } from './helpers/e2e.ts';

// Метка тестовых строк: всё, что тест создаёт в реальной БД, чистим по ней.
// Сверка через left(code, 8) — не LIKE: `_` в LIKE это wildcard и может зацепить чужое.
const E2E_TAG = 'E2E_TPL_';

// ─── МОДУЛЬ ПОД ТЕСТОМ ───────────────────────────────────────────────────────
// TODO: замени этот блок на реальный импорт своей db-функции / хендлера,
//   напр. `import { updateReferralCode } from '@Handers/referral/update.ts';`
// Здесь — заглушка того же контракта: валидирует вход (zod) и пишет в БД.
const inputSchema = z.object({
    code: z.string().min(1).max(20),
    ownerId: z.number().int().positive(),
    type: z.enum(['referral', 'admin']),
});

async function updateReferralCode(client: PoolClient, raw: unknown) {
    const input = inputSchema.parse(raw); // кривой ввод → бросит ZodError (ранний выход)
    const { rows } = await client.query(
        `insert into referral_codes (code, owner_id, type, created_at)
         values ($1, $2, $3, now())
         returning id, code, owner_id, type`,
        [input.code, input.ownerId, input.type],
    );
    return rows[0];
}
// ─────────────────────────────────────────────────────────────────────────────

async function countTagged(): Promise<number> {
    const row = await dbOne<{ n: string }>(
        `select count(*)::text as n from referral_codes where left(code, 8) = $1`,
        [E2E_TAG],
    );
    return Number(row?.n ?? 0);
}

describe.skip('e2e: referral-code-update (ШАБЛОН — сними skip)', () => {
    before(async () => {
        await withClient((c) =>
            c.query(`delete from referral_codes where left(code, 8) = $1`, [E2E_TAG]),
        );
    });

    after(async () => {
        await withClient((c) =>
            c.query(`delete from referral_codes where left(code, 8) = $1`, [E2E_TAG]),
        );
        await closePool();
    });

    // 1) HAPPY PATH — выход сверяем НАПРЯМУЮ с базой, не с возвратом функции.
    it('пишет код в БД и он реально там лежит', async () => {
        const code = `${E2E_TAG}happy`;

        // Act (с замером; сетевой шаг — только measure() для истории, без жёсткого бюджета)
        const { result } = await measure('updateReferralCode', () =>
            withClient((c) => updateReferralCode(c, { code, ownerId: 42, type: 'referral' })),
        );

        // Assert логики: источник правды — сама БД
        const row = await dbOne<{ id: string; code: string; owner_id: string; type: string }>(
            `select id, code, owner_id, type from referral_codes where code = $1`,
            [code],
        );
        assert.ok(row, 'строка должна существовать в БД');
        assert.equal(row.code, code);
        assert.equal(Number(row.owner_id), 42);
        assert.equal(row.type, 'referral');
        // Возврат функции сверяем ПОСЛЕ БД — как бонус, а не как источник правды.
        assert.equal(String(result.id), String(row.id));

        // Жёсткий бюджет — ТОЛЬКО для CPU-шага, если он в модуле есть, напр.:
        //   const { ms } = await measure('buildPayload', async () => buildPayload(input));
        //   assertBudget(ms, 50, 'buildPayload');
    });

    // 2) ИДЕМПОТЕНТНОСТЬ / ГОНКА — повтор и параллель не плодят дубли (code unique).
    // Ожидание (reject / тихий no-op / select-or-create) берётся ИЗ ЗАДАЧИ; здесь заглушка
    // просто падает на unique. Приведи ассерт к реальному контракту модуля.
    it('последовательный повтор не создаёт дубль', async () => {
        const code = `${E2E_TAG}idem`;
        await withClient((c) => updateReferralCode(c, { code, ownerId: 7, type: 'referral' }));

        await assert.rejects(
            () => withClient((c) => updateReferralCode(c, { code, ownerId: 7, type: 'referral' })),
            /duplicate key|unique/i,
        );

        const row = await dbOne<{ n: string }>(
            `select count(*)::text as n from referral_codes where code = $1`,
            [code],
        );
        assert.equal(row?.n, '1', 'в БД ровно одна строка');
    });

    it('параллельные вставки одного кода → в БД ровно одна', async () => {
        const code = `${E2E_TAG}race`;

        const results = await Promise.allSettled([
            withClient((c) => updateReferralCode(c, { code, ownerId: 9, type: 'referral' })),
            withClient((c) => updateReferralCode(c, { code, ownerId: 9, type: 'referral' })),
        ]);

        const ok = results.filter((r) => r.status === 'fulfilled').length;
        assert.equal(ok, 1, 'ровно один из параллельных запросов победил');

        const row = await dbOne<{ n: string }>(
            `select count(*)::text as n from referral_codes where code = $1`,
            [code],
        );
        assert.equal(row?.n, '1', 'гонка не продублировала строку');
    });

    // 3) КРИВОЙ ВВОД — режется валидацией ДО обращения к БД, следов не остаётся.
    it('кривой ввод отбивается zod и ничего не пишет', async () => {
        const before = await countTagged();
        const bad = { code: `${E2E_TAG}bad`, ownerId: -1, type: 'root' }; // отрицательный id, чужой enum

        await assert.rejects(() => withClient((c) => updateReferralCode(c, bad)), z.ZodError);

        assert.equal(await countTagged(), before, 'битый ввод не должен оставить следов в БД');
    });

    // 4) ИНЪЕКЦИЯ — spec-символы уходят как значение, а не как SQL; таблица цела.
    it('SQL-мета в code не ломает запрос (storage параметризован)', async () => {
        const code = `${E2E_TAG}');--`; // кавычка, скобка, точка-с-запятой, коммент — в пределах varchar(20)

        await withClient((c) => updateReferralCode(c, { code, ownerId: 1, type: 'admin' }));

        const alive = await dbOne<{ reg: string | null }>(
            `select to_regclass('referral_codes')::text as reg`,
        );
        assert.ok(alive?.reg, 'таблица referral_codes на месте (drop не прошёл)');

        const row = await dbOne<{ code: string }>(
            `select code from referral_codes where code = $1`,
            [code],
        );
        assert.equal(row?.code, code, 'мета сохранена как обычная строка');
    });

    // 5) АВТОРИЗАЦИЯ / IDOR — исполняемые пробелы: видны в выводе раннера как todo,
    //    «всё зелёное» не наступит незаметно. Замени на реальные it(...) по контракту хендлера.
    it.todo('запрос без токена / с чужим / с протухшим → отказ, а не данные');
    it.todo('доступ к чужому ownerId (IDOR) → запрещён, данные не отдаются');
});
