import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatDubai, formatDubaiNow } from '../src/lib/time.ts';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

describe('e2e: time.formatDubai — день недели + дата в таймзоне Dubai', () => {
    it('регресс: 11 июля 2026 22:00 Dubai — это суббота, не пятница', () => {
        assert.equal(formatDubai('2026-07-11T18:00:00Z'), 'Saturday 11.07 22:00');
    });

    it('конвертит UTC в Dubai (+4) и ставит верный день недели', () => {
        // 20:00Z пятницы = 00:00 субботы по Dubai
        assert.equal(formatDubai('2026-07-10T20:00:00Z'), 'Saturday 11.07 00:00');
    });

    it('день недели верный для каждого дня подряд', () => {
        // 2026-07-05 — воскресенье, дальше по одному дню
        for (const [i, wd] of WEEKDAYS.entries()) {
            const day = String(5 + i).padStart(2, '0');
            const out = formatDubai(`2026-07-${day}T08:00:00Z`);
            assert.ok(out.startsWith(wd), `${out} должен начинаться с ${wd}`);
        }
    });
});

describe('e2e: time.formatDubaiNow — текущее время Dubai с днём недели', () => {
    it('начинается с валидного дня недели', () => {
        const out = formatDubaiNow();
        assert.ok(
            WEEKDAYS.some((w) => out.startsWith(w)),
            `нет дня недели: ${out}`,
        );
    });

    it('формат: <Weekday> YYYY-MM-DD HH:mm:ss', () => {
        const out = formatDubaiNow();
        assert.match(
            out,
            /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday) \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
        );
    });
});
