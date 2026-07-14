import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stripYo } from '#Lib/Fmt.js';

describe('e2e: fmt.stripYo — убираем ё из исходящего текста', () => {
    it('меняет ё→е и Ё→Е, остальное не трогает', () => {
        assert.equal(stripYo('Всё, буду ждать тебя'), 'Все, буду ждать тебя');
        assert.equal(stripYo('Ёлка ещё зелёная'), 'Елка еще зеленая');
        assert.equal(stripYo('Привет, как ты?'), 'Привет, как ты?');
    });

    it('в тексте не остаётся ни одной ё', () => {
        const out = stripYo('Ещё разок: ёж, всё, приём, Ёмаё');
        assert.ok(!/[ёЁ]/.test(out), `в выводе осталась ё: ${out}`);
    });
});
