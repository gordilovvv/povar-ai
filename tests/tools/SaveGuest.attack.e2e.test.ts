import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { pool } from '#Db/Pool.js';
import saveGuest from '#Intelligence/Tools/SaveGuest.js';
import type { ToolContext } from '#Lib/Tools.js';

const PARTY_ID = 'E2E_sg_party';
const GUEST_ID = 'E2E_sg_guest';
const PHONE = 'E2E_sg_71000000003';
const NO_PARTY_ID = 'E2E_sg_no_such_party';
const NO_GUEST_ID = 'E2E_sg_no_such_guest';

const ctx = (guestId: string): ToolContext => ({ guestId, phone: PHONE, replies: [] });

const seed = async () => {
    await cleanup();
    await pool.query(
        `insert into party (id, name, location, type) values ($1, 'SaveGuest attack', 'nowhere', 'owned')`,
        [PARTY_ID],
    );
    await pool.query('insert into guests (id, wa_phone, lang) values ($1, $2, $3)', [
        GUEST_ID,
        PHONE,
        'ru',
    ]);
    await pool.query('insert into wa_chats (wa_phone, guest_id) values ($1, $2)', [
        PHONE,
        GUEST_ID,
    ]);
};

const cleanup = async () => {
    await pool.query('delete from party_guestlist where guest_id in ($1, $2)', [
        GUEST_ID,
        NO_GUEST_ID,
    ]);
    await pool.query('delete from party_guestlist where party_id in ($1, $2)', [
        PARTY_ID,
        NO_PARTY_ID,
    ]);
    await pool.query('delete from wa_messages where wa_chat_phone = $1', [PHONE]);
    await pool.query('delete from wa_chats where wa_phone = $1', [PHONE]);
    await pool.query('delete from guests where id = $1', [GUEST_ID]);
    await pool.query('delete from party where id = $1', [PARTY_ID]);
};

describe('e2e attack: save_guest — кривой party_id от модели', () => {
    before(seed);

    after(async () => {
        await cleanup();
        await pool.end();
    });

    it('несуществующий party_id — внятная ошибка входа, а не бросок, и в базе пусто', async () => {
        const output = await saveGuest.handler(ctx(GUEST_ID), {
            party_id: NO_PARTY_ID,
            first_name: 'Игорь',
            last_name: 'Гордилов',
            instagram: 'igor',
            insta_asked: true,
        });

        assert.deepEqual(
            output,
            {
                ok: false,
                error: 'unknown_party',
                field: 'party_id',
                instruction:
                    'There is no party with this party_id and nothing was saved. Call get_party and call this tool again with a party_id from its result.',
            },
            'модель должна получить причину и куда идти за валидным id, а не tool_failed',
        );

        const entries = await pool.query('select * from party_guestlist where guest_id = $1', [
            GUEST_ID,
        ]);
        assert.equal(entries.rowCount, 0, 'в гест-лист ничего попасть не должно');

        const guest = await pool.query<{
            first_name: string | null;
            instagram: string | null;
            instagram_asked_at: Date | null;
        }>('select first_name, instagram, instagram_asked_at from guests where id = $1', [
            GUEST_ID,
        ]);
        assert.deepEqual(
            guest.rows[0],
            { first_name: null, instagram: null, instagram_asked_at: null },
            'профиль при unknown_party не сохраняем — тул идемпотентен, модель перевызовет с верным id',
        );
    });

    it('битый guest_id при валидном party_id — fail-fast, ошибка летит наверх', async () => {
        await assert.rejects(
            saveGuest.handler(ctx(NO_GUEST_ID), { party_id: PARTY_ID, first_name: 'Игорь' }),
            'поломка нашего кода (guest_id ставим мы) не должна маскироваться под ошибку входа модели',
        );

        const entries = await pool.query('select * from party_guestlist where party_id = $1', [
            PARTY_ID,
        ]);
        assert.equal(entries.rowCount, 0, 'ничего записаться не должно');
    });

    it('валидный party_id после отказов — запись появляется ровно одна', async () => {
        const output = await saveGuest.handler(ctx(GUEST_ID), {
            party_id: PARTY_ID,
            first_name: 'Игорь',
            insta_asked: true,
        });
        assert.deepEqual(output, { ok: true, status: 'saved' });

        const entries = await pool.query('select * from party_guestlist where guest_id = $1', [
            GUEST_ID,
        ]);
        assert.equal(entries.rowCount, 1, 'ровно одна строка гест-листа, без дублей');

        const guest = await pool.query<{ instagram_asked_at: Date | null }>(
            'select instagram_asked_at from guests where id = $1',
            [GUEST_ID],
        );
        assert.ok(
            guest.rows[0]?.instagram_asked_at,
            'insta_asked должен дойти до колонки instagram_asked_at, а не потеряться на несовпадении имён',
        );
    });
});
