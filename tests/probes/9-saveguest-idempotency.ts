import {
    insertGuestlistEntry,
    selectGuestlistEntry,
    updateGuestlistFriends,
    updateGuestlistTableAnswer,
} from '#Db/Guestlist.js';
import { pool } from '#Db/Pool.js';
import { toDateTime } from '#Lib/Fmt.js';

const PARTY = '01KX3X86BGGG77K75VKNYVMBXT';
const GUEST = '01KX4FFTVXWXQAVKD20EA0BP90';

const main = async () => {
    const client = await pool.connect();
    const now = toDateTime(Date.now());

    await client.query('delete from party_guestlist where party_id = $1 and guest_id = $2', [
        PARTY,
        GUEST,
    ]);
    await insertGuestlistEntry(client, PARTY, GUEST, now);

    // M1: имена с pg-format плейсхолдерами
    const nasty = ['Аня %L Петрова', "Bob %s %I O'Brien", 'Скидка 50%% Иванов'];
    await updateGuestlistFriends(client, PARTY, GUEST, nasty);
    console.log('friends nasty:', (await selectGuestlistEntry(client, PARTY, GUEST))?.friends);

    // M2: пустой список очищает
    await updateGuestlistFriends(client, PARTY, GUEST, []);
    console.log('friends empty:', (await selectGuestlistEntry(client, PARTY, GUEST))?.friends);

    // C1: захват ответа про стол — второй раз ноль строк
    const first = await updateGuestlistTableAnswer(client, PARTY, GUEST, true, now);
    const second = await updateGuestlistTableAnswer(client, PARTY, GUEST, true, now);
    console.log('table capture 1:', !!first, 'capture 2:', !!second);

    // C1: смена ответа тоже не проходит
    const flip = await updateGuestlistTableAnswer(client, PARTY, GUEST, false, now);
    const row = await selectGuestlistEntry(client, PARTY, GUEST);
    console.log('flip captured:', !!flip, 'booked_table:', row?.booked_table);

    // гонка: два параллельных захвата на чистой строке
    await client.query('update party_guestlist set booked_table = null where party_id = $1', [
        PARTY,
    ]);
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    const [r1, r2] = await Promise.all([
        updateGuestlistTableAnswer(c1, PARTY, GUEST, true, now),
        updateGuestlistTableAnswer(c2, PARTY, GUEST, true, now),
    ]);
    console.log('race winners:', [!!r1, !!r2].filter(Boolean).length);
    c1.release();
    c2.release();

    await client.query('delete from party_guestlist where party_id = $1 and guest_id = $2', [
        PARTY,
        GUEST,
    ]);
    client.release();
    await pool.end();
};

main();
