// Модуль: Lib/PaginationCursor (чистая функция, без БД — критерий «ошибки/идемпотентность» пропускаем)
//   вход  → encode(iso, id) / decode(raw)
//   выход → `<iso>|<id>`; decode round-trip либо null на битом входе
//   негатив → нет разделителя / невалидная дата / пустой id → null

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PaginationCursor } from '#Dashboard/Lib/PaginationCursor.js';

const ISO = '2026-07-14T14:37:19.000Z';
const PHONE = '971501234567';

describe('e2e: Lib/PaginationCursor', () => {
    it('round-trip: encode → decode возвращает исходные time и id', () => {
        const decoded = PaginationCursor.decode(PaginationCursor.encode(ISO, PHONE));
        assert.deepEqual(decoded, { time: ISO, id: PHONE });
    });

    it('битый вход → null', () => {
        assert.equal(PaginationCursor.decode('no-separator'), null, 'нет разделителя');
        assert.equal(PaginationCursor.decode('|only-sep'), null, 'пустое время');
        assert.equal(PaginationCursor.decode(`${ISO}|`), null, 'пустой id');
        assert.equal(PaginationCursor.decode(`not-a-date|${PHONE}`), null, 'невалидная дата');
        assert.equal(
            PaginationCursor.decode(`2030-13-45T99:99:99.999Z|${PHONE}`),
            null,
            'невалидный календарь (проходит форму, но не дату)',
        );
        assert.equal(PaginationCursor.decode(`2030-1-1|${PHONE}`), null, 'loose-дата не ISO');
    });
});
