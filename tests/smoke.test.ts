import assert from 'node:assert/strict';
import { test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { Pool } from 'pg';

test('anthropic ключ и модель отвечают', async () => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const model = process.env.ANTHROPIC_MODEL;
    assert.ok(apiKey, 'ANTHROPIC_API_KEY отсутствует');
    assert.ok(model, 'ANTHROPIC_MODEL отсутствует');

    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
        model,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Ответь одним словом: pong' }],
    });

    const text = response.content.find((b) => b.type === 'text');
    assert.equal(response.stop_reason, 'end_turn');
    console.log(
        `[smoke] model=${response.model} reply=${text?.type === 'text' ? text.text : '(none)'}`,
    );
});

test('база отвечает и таблицы накачены', async () => {
    const url = process.env.DATABASE_URL;
    assert.ok(url, 'DATABASE_URL отсутствует');

    const pool = new Pool({ connectionString: url, max: 1 });
    try {
        const { rows } = await pool.query<{ table_name: string }>(
            `select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
        );
        const names = rows.map((r) => r.table_name);
        console.log(`[smoke] tables: ${names.join(', ')}`);
        for (const t of ['guests', 'party', 'party_guestlist', 'wa_messages']) {
            assert.ok(names.includes(t), `нет таблицы ${t}`);
        }
    } finally {
        await pool.end();
    }
});
