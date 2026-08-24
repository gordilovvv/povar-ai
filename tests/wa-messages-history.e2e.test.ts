// Задача модуля (selectWaChatMessages):
//   вход  → phone, limit
//   выход → история чата для модели: без need_processed (не захвачены, уйдут в следующий батч);
//           processing (текущий батч) — последним, даже если по sent_at раньше нашего ответа;
//           остальное по sent_at, id
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { selectWaChatMessages } from '#Db/WaMessages.js';
import { closePool, dbQuery, withClient } from './helpers/e2e.ts';

const PHONE = 'E2E_HISTORY_CHAT';

const ROWS = [
    ['01_YO', 'guest', 'processed', '2030-01-01T10:00:00Z'],
    ['02_WANT', 'guest', 'processing', '2030-01-01T10:00:08Z'],
    ['03_REPLY', 'sema', null, '2030-01-01T10:00:50Z'],
    ['04_LATE', 'guest', 'need_processed', '2030-01-01T10:01:30Z'],
    ['05_STOP', 'guest', 'skipped', '2030-01-01T10:02:00Z'],
] as const;

const cleanup = async () => {
    await dbQuery(`delete from wa_messages where wa_chat_phone = $1`, [PHONE]);
    await dbQuery(`delete from wa_chats where wa_phone = $1`, [PHONE]);
};

before(async () => {
    await cleanup();
    await dbQuery(`insert into wa_chats (wa_phone) values ($1)`, [PHONE]);
    for (const [id, owner, workerStatus, sentAt] of ROWS) {
        await dbQuery(
            `insert into wa_messages (id, wa_chat_phone, text, owner, worker_status, sent_at)
            values ($1, $2, $3, $4, $5, $6)`,
            [id, PHONE, id, owner, workerStatus, sentAt],
        );
    }
});

after(async () => {
    await cleanup();
    await closePool();
});

describe('selectWaChatMessages', () => {
    test('need_processed скрыт, processing последним, остальное по времени', async () => {
        const rows = await withClient((client) => selectWaChatMessages(client, PHONE, 40));
        assert.deepEqual(
            rows.map((row) => row.id),
            ['01_YO', '03_REPLY', '05_STOP', '02_WANT'],
        );
    });

    test('limit режет по свежести id до пересортировки', async () => {
        const rows = await withClient((client) => selectWaChatMessages(client, PHONE, 2));
        assert.deepEqual(
            rows.map((row) => row.id),
            ['03_REPLY', '05_STOP'],
        );
    });
});
