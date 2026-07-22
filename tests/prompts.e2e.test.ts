import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { pool } from '#Db/Pool.js';
import {
    cleanup,
    LYLO,
    runScenario,
    type Scenario,
    SIRENE,
    selectGuest,
    selectGuestlist,
    type TurnResult,
} from './helpers/PromptHarness.js';

after(async () => {
    await cleanup();
    await pool.end();
});

const ASKS_NAME = /как (теб|вас)[^.?!]{0,20}зов|имя и фамили|фамилию|как мне (теб|вас)/i;
const ASKS_INSTA = /инстаграм|инсту|instagram|@/i;
const ASKS_TABLE = /стол|столик/i;
/** «Я узнаю / уточню / вернусь с ответом» — обещание, которого бот не может сдержать. */
const PROMISES_TO_CHECK = /узна|уточн|спрош|вернусь|проверю/i;

/** Редкое нарушение ловим только повтором: гоняем сценарий трижды. */
const thrice = async (scenario: Scenario): Promise<TurnResult[]> => {
    const runs: TurnResult[] = [];
    for (let i = 0; i < 3; i++) {
        runs.push(await runScenario(scenario));
    }
    return runs;
};

describe('system.md', () => {
    /** Баббл со смайлом-скобкой: «))» или закрывающих скобок больше открывающих. */
    const parenSmiley = (bubble: string): boolean => {
        const opens = (bubble.match(/\(/g) ?? []).length;
        const closes = (bubble.match(/\)/g) ?? []).length;
        return /\)\)/.test(bubble) || closes > opens;
    };

    it('«ты бот?» — честно признаётся ботом и продолжает воронку правильной формулировкой имени', {
        timeout: 120_000,
    }, async () => {
        const runs = await thrice({
            history: [
                { role: 'user', text: 'привет' },
                {
                    role: 'assistant',
                    text: 'Привет! Сёма играет в субботу на LYLO. Буду рад, если придёшь 🤝',
                },
                { role: 'user', text: 'слушай, а ты бот или живой человек? честно скажи' },
            ],
            parties: [LYLO],
            state: ['party: LYLO'],
            done: ['greeted', 'pitched the party, guest chose LYLO'],
            now: 'Ask the guest for first and last name.',
        });

        for (const r of runs) {
            assert.match(
                r.text,
                /(?<![а-яё])бот(?![а-яё])/i,
                `system.md «Who you are»: на прямой вопрос надо назваться ботом, ответ: ${JSON.stringify(r.replies)}`,
            );
            assert.doesNotMatch(
                r.text,
                /как тебя зовут|как вас зовут|как тебя звать/i,
                `system.md Hard rules: вопрос имени ТОЛЬКО «пришли имя фамилию», ответ: ${JSON.stringify(r.replies)}`,
            );
            assert.match(
                r.text,
                /имя\s+(и\s+)?фамили/i,
                `system.md Hard rules + checklist: признание ботом не отменяет шаг Now (спросить имя фамилию), ответ: ${JSON.stringify(r.replies)}`,
            );
        }
    });

    it('не выдаёт себя за Сёму — говорит о нём в 3-м лице', { timeout: 120_000 }, async () => {
        const runs = await thrice({
            history: [
                { role: 'user', text: 'привет, хочу на вечеринку' },
                { role: 'assistant', text: 'Привет! Записал тебя, Игорь.' },
                {
                    role: 'user',
                    text: 'а ты поставишь что-нибудь из афро-хауса? обожаю саксофон под такое',
                },
            ],
            parties: [SIRENE],
            state: ['name: Игорь Гордилов', 'party: SIRENE'],
            done: ['greeted', 'pitched the party, guest chose SIRENE', 'name saved'],
            now: 'Ask for the instagram once and confirm the guest is on the list with the entry conditions.',
        });

        for (const r of runs) {
            assert.doesNotMatch(
                r.text,
                /(?<![а-яё])я\s+(по)?ставлю|(?<![а-яё])я\s+сыграю|(?<![а-яё])я\s+играю|(?<![а-яё])я\s+буду\s+за\s+пультом|(?<![а-яё])мой\s+сет|(?<![а-яё])у\s+меня\s+сет/i,
                `system.md «Who you are»: бот не Сёма, «я поставлю/я сыграю» запрещено, ответ: ${JSON.stringify(r.replies)}`,
            );
            // упоминать Сёму промт не требует — запрещено только присваивать его роль
            assert.doesNotMatch(
                r.text,
                /(?<![а-яё])я\s+(диджей|dj)|(?<![а-яё])я\s+за\s+пультом|моя\s+вечеринка/i,
                `system.md «Who you are»: бот не может присваивать себе роль Сёмы, ответ: ${JSON.stringify(r.replies)}`,
            );
        }
    });

    it('никогда не пишет смайл из скобок в ответ на эмоциональное сообщение', {
        timeout: 120_000,
    }, async () => {
        const runs = await thrice({
            history: [
                { role: 'user', text: 'привет!' },
                { role: 'assistant', text: 'Привет! Ты в списке на LYLO, Игорь.' },
                {
                    role: 'user',
                    text: 'ооо круто))) спасибо огромное!!! очень жду, давно хотел попасть)',
                },
            ],
            parties: [LYLO],
            state: ['name: Игорь Гордилов', 'party: LYLO'],
            done: [
                'greeted',
                'pitched the party',
                'name saved',
                'instagram asked',
                'guestlist confirmed',
                'our instagram and the group sent',
            ],
            now: 'Offer a table once.',
        });

        for (const r of runs) {
            const bad = r.replies.filter(parenSmiley);
            assert.deepEqual(
                bad,
                [],
                `system.md Hard rules: смайл из скобок «)» / «))» запрещён, бабблы: ${JSON.stringify(bad)}`,
            );
            const emoji = r.text.match(/\p{Extended_Pictographic}/gu) ?? [];
            assert.ok(
                emoji.length <= 1 && emoji.every((e) => e === '❤' || e === '🤝'),
                `system.md Tone: максимум 1 эмодзи и только ❤️/🤝, найдено: ${JSON.stringify(emoji)}`,
            );
        }
    });

    it('факт есть в notes → отвечает без паузы; факта нет и это про вечеринку → pause_chat и молчит', {
        timeout: 120_000,
    }, async () => {
        const base = {
            parties: [LYLO],
            state: ['name: Игорь Гордилов', 'party: LYLO'],
            done: [
                'greeted',
                'pitched the party',
                'name saved',
                'instagram asked',
                'guestlist confirmed',
                'our instagram and the group sent',
                'table offered and declined',
            ],
            now: 'The funnel is over — just answer the guest.',
        };

        const known = await runScenario({
            ...base,
            history: [{ role: 'user', text: 'а кальян там есть?' }],
        });
        assert.ok(
            !known.called('pause_chat'),
            `system.md «check the facts»: в notes LYLO прямо сказано «Кальяна нет» — паузить нельзя, вызовы: ${JSON.stringify(known.calls.map((c) => c.name))}`,
        );
        assert.match(
            known.text,
            /кальян/i,
            `system.md «check the facts»: факт есть в notes — надо ответить, ответ: ${JSON.stringify(known.replies)}`,
        );

        const unknown = await runScenario({
            ...base,
            history: [{ role: 'user', text: 'а вход картой можно оплатить или только наличкой?' }],
        });
        assert.ok(
            unknown.called('pause_chat'),
            `system.md «check the facts»: способ оплаты — про эту вечеринку и НЕ в notes, нужен pause_chat, вызовы: ${JSON.stringify(unknown.calls.map((c) => c.name))}`,
        );
        assert.ok(
            !unknown.called('send_message'),
            `system.md: pause_chat — это весь ответ, писать гостю нельзя, ответ: ${JSON.stringify(unknown.replies)}`,
        );
        assert.doesNotMatch(
            unknown.text,
            /узна|уточн|спрош|перезвон|вернусь|проверю/i,
            `system.md Tone: «я узнаю / уточню / вернусь с ответом» запрещено, ответ: ${JSON.stringify(unknown.replies)}`,
        );
    });

    it('«где это и далеко ли от метро?» → шлёт google_map_link и не оценивает расстояние', {
        timeout: 120_000,
    }, async () => {
        const runs = await thrice({
            history: [
                {
                    role: 'user',
                    text: 'а где это вообще происходит? далеко от метро добираться?',
                },
            ],
            parties: [SIRENE],
            state: ['name: Игорь Гордилов', 'party: SIRENE'],
            done: [
                'greeted',
                'pitched the party',
                'name saved',
                'instagram asked',
                'guestlist confirmed',
            ],
            now: 'Ask for the instagram once.',
        });

        for (const r of runs) {
            assert.ok(
                r.text.includes(SIRENE.google_map_link),
                `system.md «Venue facts»: на вопрос про локацию шлём google_map_link, ответ: ${JSON.stringify(r.replies)}`,
            );
            assert.doesNotMatch(
                r.text,
                /\d+\s*(мин|км|метр|kм)/i,
                `system.md «Venue facts»: оценивать расстояние и время в пути запрещено, ответ: ${JSON.stringify(r.replies)}`,
            );
            assert.doesNotMatch(
                r.text,
                /пешком|рукой подать|в двух шагах|погугл|загугл/i,
                `system.md «Venue facts»: ни прикидок пути, ни «погугли», ответ: ${JSON.stringify(r.replies)}`,
            );
            const links = r.text.match(/https?:\/\/\S+/g) ?? [];
            assert.ok(
                links.every((l) => l.startsWith(SIRENE.google_map_link)),
                `system.md Hard rules: ссылки только из тулов, выдуманные URL запрещены: ${JSON.stringify(links)}`,
            );
        }
    });

    it('гость по-английски → ответ только по-английски и время в 12h am/pm', {
        timeout: 120_000,
    }, async () => {
        const runs = await thrice({
            history: [{ role: 'user', text: 'Hi! What time does the party start?' }],
            parties: [LYLO],
            state: ['party: LYLO'],
            done: ['greeted', 'pitched the party, guest chose LYLO'],
            now: 'Ask the guest for first and last name.',
            lang: 'en',
        });

        for (const r of runs) {
            assert.doesNotMatch(
                r.text,
                /[а-яё]/i,
                `system.md: гость пишет по-английски — отвечаем только по-английски, ответ: ${JSON.stringify(r.replies)}`,
            );
            assert.match(
                r.text,
                /\b10(:00)?\s?p\.?m\.?/i,
                `system.md «Time»: английскому гостю время в 12h am/pm, ответ: ${JSON.stringify(r.replies)}`,
            );
            assert.doesNotMatch(
                r.text,
                /\b22[:.]00\b/,
                `system.md «Time»: 24h формат английскому гостю запрещён, ответ: ${JSON.stringify(r.replies)}`,
            );
            assert.doesNotMatch(
                r.text,
                /what'?s your name|what is your name/i,
                `system.md Hard rules: вопрос имени ТОЛЬКО «send me your name and surname», ответ: ${JSON.stringify(r.replies)}`,
            );
        }
    });

    it('«до скольки бар?» — соседний факт (кухня до 23:00) не ответ, нужен pause_chat', {
        timeout: 120_000,
    }, async () => {
        const runs = await thrice({
            history: [
                { role: 'user', text: 'привет, я на LYLO записан' },
                { role: 'assistant', text: 'да, ты в списке. Буду рад видеть' },
                { role: 'user', text: 'а до скольки бар наливает? и до скольки музыка играет?' },
            ],
            parties: [LYLO],
            state: ['name: Игорь Гордилов', 'party: LYLO', 'on the guestlist: yes'],
            done: [
                'greeted',
                'pitched the party',
                'name saved',
                'instagram asked',
                'guestlist confirmed',
            ],
            now: 'The funnel is over — just answer the guest.',
        });

        for (const r of runs) {
            assert.ok(
                r.called('pause_chat'),
                `system.md «check the facts»: время бара и конца вечеринки НЕ в notes — нужен pause_chat, вызовы: ${JSON.stringify(r.calls.map((c) => c.name))}`,
            );
            assert.ok(
                !r.called('send_message'),
                `system.md: pause_chat — это весь ответ, ответ: ${JSON.stringify(r.replies)}`,
            );
            assert.doesNotMatch(
                r.text,
                /23[:.]00|кухн/i,
                `system.md «check the facts»: «kitchen closing time is not bar closing time» — время кухни подсунуто как ответ: ${JSON.stringify(r.replies)}`,
            );
            assert.doesNotMatch(
                r.text,
                PROMISES_TO_CHECK,
                `system.md Tone: «я узнаю / уточню» запрещено, ответ: ${JSON.stringify(r.replies)}`,
            );
        }
    });

    it('такси и погода — не Сёмина зона: отвечает сам, без pause_chat и без выдуманных цен', {
        timeout: 120_000,
    }, async () => {
        const runs = await thrice({
            history: [
                { role: 'user', text: 'записался на SIRENE, жду' },
                { role: 'assistant', text: 'отлично, до встречи' },
                {
                    role: 'user',
                    text: 'слушай, а сколько такси из Дейры туда примерно выйдет? и не будет ли жарко на крыше в июле?',
                },
            ],
            parties: [SIRENE],
            state: ['name: Игорь Гордилов', 'party: SIRENE', 'on the guestlist: yes'],
            done: [
                'greeted',
                'pitched the party',
                'name saved',
                'instagram asked',
                'guestlist confirmed',
            ],
            now: 'The funnel is over — just answer the guest.',
        });

        for (const r of runs) {
            assert.ok(
                !r.called('pause_chat'),
                `system.md «check the facts»: такси и погода — не то, что решает Сёма, паузить нельзя, вызовы: ${JSON.stringify(r.calls.map((c) => c.name))}`,
            );
            assert.ok(
                r.called('send_message'),
                'system.md: на не-Сёмин вопрос отвечаем сами, а ответа нет',
            );
            assert.doesNotMatch(
                r.text,
                /\d+\s*(aed|дирх)/i,
                `system.md «Venue facts»: цену такси не знаем и не выдумываем, ответ: ${JSON.stringify(r.replies)}`,
            );
            assert.doesNotMatch(
                r.text,
                PROMISES_TO_CHECK,
                `system.md Tone: «я узнаю / уточню» запрещено, ответ: ${JSON.stringify(r.replies)}`,
            );
        }
    });

    it('афиши нет (reels_url = null) — говорит прямо, не обещает прислать и не выдумывает ссылку', {
        timeout: 120_000,
    }, async () => {
        const runs = await thrice({
            history: [
                { role: 'user', text: 'привет!' },
                { role: 'assistant', text: 'привет! Сёма играет 31 июля на SIRENE' },
                { role: 'user', text: 'скинь афишу плиз, хочу друзьям переслать' },
            ],
            parties: [SIRENE],
            state: ['name: Игорь Гордилов', 'party: SIRENE'],
            done: ['greeted', 'pitched the party, guest chose SIRENE', 'name saved'],
            now: 'Ask for the instagram once and confirm the guest is on the list with the entry conditions.',
        });

        for (const r of runs) {
            assert.doesNotMatch(
                r.text,
                /https?:\/\//,
                `system.md «Venue facts»: reels_url нет — ссылку брать неоткуда, ответ: ${JSON.stringify(r.replies)}`,
            );
            assert.match(
                r.text,
                /афиш|постер/i,
                `system.md «Venue facts»: надо прямо сказать, что афиши пока нет, ответ: ${JSON.stringify(r.replies)}`,
            );
            assert.doesNotMatch(
                r.text,
                /(?<![а-яё])(скину|пришлю|отправлю|сообщу)(?![а-яё])|как появится|дам знать/i,
                `system.md «Venue facts»: «Never promise to send it later», ответ: ${JSON.stringify(r.replies)}`,
            );
            assert.ok(
                !r.called('pause_chat'),
                'system.md: отсутствие афиши — известный факт, паузить не нужно',
            );
        }
    });

    it('условия входа уже сказаны — не повторяет цену и не пересобирает лайнап', {
        timeout: 120_000,
    }, async () => {
        const runs = await thrice({
            history: [
                { role: 'user', text: 'Игорь Гордилов' },
                {
                    role: 'assistant',
                    text: 'записал тебя, Игорь. Вход бесплатный до полуночи, после — 150 AED',
                },
                { role: 'user', text: 'супер! а во сколько лучше приехать?' },
            ],
            parties: [LYLO],
            state: ['name: Игорь Гордилов', 'party: LYLO', 'on the guestlist: yes'],
            done: [
                'greeted',
                'pitched the party',
                'name saved',
                'guestlist confirmed with the entry conditions',
            ],
            now: 'Ask for the instagram once.',
        });

        for (const r of runs) {
            assert.doesNotMatch(
                r.text,
                /150/,
                `system.md Hard rules: условия входа уже сказаны, повторять запрещено (гость цену не спрашивал), ответ: ${JSON.stringify(r.replies)}`,
            );
            assert.doesNotMatch(
                r.text,
                /Сёма играет/i,
                `system.md Hard rules: лайнап-баббл ровно один раз за диалог, ответ: ${JSON.stringify(r.replies)}`,
            );
            assert.ok(
                r.called('send_message'),
                'тест из одних отрицаний прошёл бы и на молчании — гостю должен уйти ответ',
            );
            assert.ok(
                !r.called('pause_chat'),
                `system.md: время старта есть в фактах — паузить нельзя, вызовы: ${JSON.stringify(r.calls.map((c) => c.name))}`,
            );
        }
    });
});

describe('checklist.md', () => {
    it('сначала отвечает на вопрос гостя, потом делает шаг Now — и только его', {
        timeout: 120_000,
    }, async () => {
        const runs = await thrice({
            history: [
                { role: 'user', text: 'привет' },
                {
                    role: 'assistant',
                    text: 'привет! 25 июля делаем LYLO — скрытый клуб внутри ресторана на Palm Jumeirah, deep house до утра',
                },
                { role: 'user', text: 'а это вообще где? далеко от Марины?' },
            ],
            parties: [LYLO],
            state: [`party: LYLO (party_id: ${LYLO.party_id})`],
            done: ['1. greeted', '2. pitched the party'],
            now: '3. ask for the first and last name',
        });

        for (const r of runs) {
            assert.match(
                r.text,
                /palm|пальм|vista mare|виста/i,
                'checklist «Always answer what the guest just asked first»: гость спросил где это — в ответе нет локации',
            );
            assert.match(
                r.text,
                ASKS_NAME,
                'checklist Now=шаг 3: имя не спрошено, шаг хода не сделан',
            );
            assert.ok(
                !ASKS_INSTA.test(r.text),
                `checklist «Do exactly ONE step per reply»: убежал вперёд на шаг 4 (инстаграм) при Now=шаг 3. Текст: ${r.text}`,
            );
            assert.ok(
                !ASKS_TABLE.test(r.text),
                `checklist «Do exactly ONE step per reply»: убежал вперёд на шаг 6 (стол) при Now=шаг 3. Текст: ${r.text}`,
            );
            assert.ok(
                !r.called('save_guest'),
                'checklist шаг 3: имени ещё нет, в гест-лист заносить нечего',
            );
        }
    });

    it('не переспрашивает то, что уже в Done/State, и делает шаг 4 целиком', {
        timeout: 120_000,
    }, async () => {
        const r = await runScenario({
            history: [
                { role: 'user', text: 'Игорь Гордилов' },
                { role: 'assistant', text: 'записал!' },
                { role: 'user', text: 'ага' },
            ],
            parties: [LYLO],
            state: [
                `party: LYLO (party_id: ${LYLO.party_id})`,
                'first_name: Игорь',
                'last_name: Гордилов',
                'on the guestlist: yes',
            ],
            done: ['1. greeted', '2. pitched the party', '3. got the name and saved it'],
            now: '4. ask for the instagram once, confirm the guestlist + entry conditions in the same reply',
        });

        assert.ok(
            !ASKS_NAME.test(r.text),
            `checklist «Never re-ask something already listed in Done or filled in State»: имя уже в State, а его спрашивают снова. Текст: ${r.text}`,
        );
        assert.ok(
            !/какая вечеринк|котор(ая|ую) вечеринк|на какую/i.test(r.text),
            `checklist «Never re-ask»: вечеринка уже в State (LYLO), а гостя спрашивают какую. Текст: ${r.text}`,
        );
        assert.match(
            r.text,
            ASKS_INSTA,
            'checklist шаг 4: инстаграм не спрошен — шаг Now не сделан',
        );
        assert.match(
            r.text,
            /150|бесплатно|00:00|полуноч/i,
            `checklist шаг 4: условия входа должны быть в ТОМ ЖЕ ответе. Текст: ${r.text}`,
        );
        assert.match(
            r.text,
            /списк|гест|guestlist|лист/i,
            `checklist шаг 4: подтверждение гест-листа должно быть в том же ответе. Текст: ${r.text}`,
        );
    });

    it('имя и спутники пришли — тем же ходом save_guest с friends', {
        timeout: 120_000,
    }, async () => {
        const runs = await thrice({
            history: [
                { role: 'user', text: 'а можно с друзьями?' },
                {
                    role: 'assistant',
                    text: 'конечно! как тебя зовут — имя и фамилия? и имена тех, кто с тобой',
                },
                {
                    role: 'user',
                    text: 'Игорь Гордилов, со мной ещё двое — Аня Соколова и Марк Литвин',
                },
            ],
            parties: [LYLO],
            state: [`party: LYLO (party_id: ${LYLO.party_id})`],
            done: ['1. greeted', '2. pitched the party'],
            now: '3. the name just arrived — save the guest to the guestlist',
        });

        for (const r of runs) {
            assert.ok(
                r.called('save_guest'),
                'checklist шаг 3: «As soon as the name arrives, call save_guest» — тул не вызван тем же ходом',
            );
            const input = r.inputOf('save_guest') ?? {};
            assert.equal(
                input.party_id,
                LYLO.party_id,
                'checklist шаг 3: party_id обязателен и должен быть из State',
            );
            assert.match(
                String(input.first_name ?? ''),
                /Игорь/i,
                'checklist шаг 3: имя гостя не передано в тул',
            );
            assert.match(
                String(input.last_name ?? ''),
                /Гордилов/i,
                'checklist шаг 3: фамилия гостя не передана в тул',
            );

            const friends = JSON.stringify(input.friends ?? []);
            assert.match(
                friends,
                /Аня|Соколова/i,
                `checklist шаг 3: «get every companion's name too and pass them all in friends» — Аня потеряна. friends=${friends}`,
            );
            assert.match(
                friends,
                /Марк|Литвин/i,
                `checklist шаг 3: спутник Марк потерян. friends=${friends}`,
            );
        }

        const saved = await selectGuestlist();
        assert.equal(
            saved.length,
            1,
            `в базе должна быть одна запись гест-листа: ${JSON.stringify(saved)}`,
        );
        assert.equal(saved[0]?.party_id, LYLO.party_id);
        assert.equal(
            saved[0]?.friends?.length,
            2,
            `в базе должны лежать оба спутника: ${JSON.stringify(saved[0]?.friends)}`,
        );
        const guest = await selectGuest();
        assert.match(String(guest?.first_name), /Игорь/i, 'имя гостя не записалось в базу');
        assert.match(String(guest?.last_name), /Гордилов/i, 'фамилия гостя не записалась в базу');
    });

    it('несколько вечеринок — спрашивает какую и НИЧЕГО больше', { timeout: 120_000 }, async () => {
        const runs = await thrice({
            history: [{ role: 'user', text: 'привет, что у вас там на выходных?' }],
            parties: [LYLO, SIRENE],
            state: [],
            done: ['1. greeted'],
            now: '2. pitch the parties',
        });

        for (const r of runs) {
            assert.match(r.text, /lylo/i, 'checklist шаг 2: LYLO не запитчена');
            assert.match(r.text, /sirene/i, 'checklist шаг 2: SIRENE не запитчена');
            assert.match(
                r.text,
                /как(ая|ую|ое|ой|о[ей]) |на что|выбер|куда|что.{0,15}(ближе|интересн)/i,
                `checklist шаг 2: вечеринок несколько — надо спросить какую. Текст: ${r.text}`,
            );
            assert.ok(
                !ASKS_NAME.test(r.text),
                `checklist шаг 2 «Nothing else in this step»: убежал на шаг 3 (имя). Текст: ${r.text}`,
            );
            assert.ok(
                !ASKS_INSTA.test(r.text),
                `checklist шаг 2 «Nothing else in this step»: убежал на шаг 4 (инстаграм). Текст: ${r.text}`,
            );
            assert.ok(
                !r.called('save_guest'),
                'checklist шаг 2 «Nothing else in this step»: гест-лист трогать рано — вечеринка ещё не выбрана',
            );
        }
    });

    it('гость согласился на стол — want_table true, и после закрытия чата ни слова', {
        timeout: 120_000,
    }, async () => {
        const runs = await thrice({
            history: [
                { role: 'user', text: 'ок' },
                {
                    role: 'assistant',
                    text: 'кстати, могу забронировать вам стол — будет своя зона и не надо толкаться у бара. Интересно?',
                },
                { role: 'user', text: 'да, давай стол' },
            ],
            parties: [LYLO],
            state: [
                `party: LYLO (party_id: ${LYLO.party_id})`,
                'first_name: Игорь',
                'last_name: Гордилов',
                'on the guestlist: yes',
            ],
            done: [
                '1. greeted',
                '2. pitched the party',
                '3. got the name and saved it',
                '4. asked instagram + confirmed the guestlist',
                '5. sent our instagram + the whatsapp group',
                '6. offered a table',
            ],
            now: '6. the guest answered about the table — pass the answer to save_guest',
        });

        for (const r of runs) {
            assert.ok(
                r.called('save_guest'),
                'checklist шаг 6: ответ про стол должен уйти в save_guest',
            );
            assert.equal(
                r.inputOf('save_guest')?.want_table,
                true,
                'checklist шаг 6: гость согласился — want_table должен быть true',
            );

            const saved = r.calls.findIndex(
                (c) => c.name === 'save_guest' && c.input.want_table === true,
            );
            const after = r.calls.slice(saved + 1).filter((c) => c.name === 'send_message');
            assert.deepEqual(
                after,
                [],
                `checklist шаг 6: «true → the tool answers the guest itself and closes the chat — send nothing». Модель написала после закрытия: ${JSON.stringify(after)}`,
            );
        }
    });

    it('«ты бот?» посреди воронки — отвечает честно и в том же ответе делает шаг Now', {
        timeout: 120_000,
    }, async () => {
        const runs = await thrice({
            history: [
                { role: 'user', text: 'ага, подписался' },
                { role: 'assistant', text: 'супер!' },
                { role: 'user', text: 'слушай, а ты вообще бот или живой человек?' },
            ],
            parties: [LYLO],
            state: [
                `party: LYLO (party_id: ${LYLO.party_id})`,
                'first_name: Игорь',
                'last_name: Гордилов',
                'on the guestlist: yes',
            ],
            done: [
                '1. greeted',
                '2. pitched the party',
                '3. got the name and saved it',
                '4. asked instagram + confirmed the guestlist',
                '5. sent our instagram + the whatsapp group',
            ],
            now: '6. offer a table once',
        });

        for (const r of runs) {
            assert.match(
                r.text,
                /бот|ассистент|ии\b|ai\b|нейрос|не человек|программ/i,
                `checklist «answer honestly»: на прямой вопрос «ты бот?» честного ответа нет. Текст: ${r.text}`,
            );
            assert.match(
                r.text,
                ASKS_TABLE,
                `checklist «Being asked whether you're a bot ... never interrupts the flow — then continue with Now in the same reply»: шаг 6 (стол) не сделан. Текст: ${r.text}`,
            );
            assert.ok(
                !r.called('pause_chat'),
                'checklist: вопрос «ты бот?» — не повод отдавать чат Сёме',
            );
        }
    });

    it('шаг 4: insta_asked уходит в save_guest в момент вопроса, не дожидаясь ответа', {
        timeout: 120_000,
    }, async () => {
        const runs = await thrice({
            history: [
                { role: 'user', text: 'Игорь Гордилов' },
                { role: 'assistant', text: 'записал!' },
                { role: 'user', text: 'ага' },
            ],
            parties: [LYLO],
            state: [
                `party: LYLO (party_id: ${LYLO.party_id})`,
                'first_name: Игорь',
                'last_name: Гордилов',
                'on the guestlist: yes',
            ],
            done: ['1. greeted', '2. pitched the party', '3. got the name and saved it'],
            now: '4. ask for the instagram once, confirm the guestlist + entry conditions in the same reply',
        });

        for (const r of runs) {
            assert.match(
                r.text,
                ASKS_INSTA,
                'checklist шаг 4: инстаграм не спрошен — шаг Now не сделан',
            );
            assert.ok(
                r.called('save_guest'),
                `checklist шаг 4: «call save_guest with insta_asked the moment you ask» — тул не вызван, вызовы: ${JSON.stringify(r.calls.map((c) => c.name))}`,
            );
            assert.equal(
                r.inputOf('save_guest')?.insta_asked,
                true,
                `checklist шаг 4: insta_asked=true должен уйти тем же ходом, input=${JSON.stringify(r.inputOf('save_guest'))}`,
            );
        }

        const guest = await selectGuest();
        assert.ok(
            guest?.instagram_asked_at,
            'в базе не проставлен instagram_asked_at — факт вопроса не сохранён',
        );
    });

    it('инстаграм пришёл позже — досохраняет его и не спрашивает второй раз', {
        timeout: 120_000,
    }, async () => {
        const runs = await thrice({
            history: [
                { role: 'user', text: 'ок' },
                {
                    role: 'assistant',
                    text: 'скинь свой инстаграм, если хочешь. Ты в списке, вход бесплатный до полуночи',
                },
                { role: 'user', text: 'кстати вот мой инст @igor_dxb' },
            ],
            parties: [LYLO],
            state: [
                `party: LYLO (party_id: ${LYLO.party_id})`,
                'first_name: Игорь',
                'last_name: Гордилов',
                'on the guestlist: yes',
                'instagram: asked, no answer yet',
            ],
            done: [
                '1. greeted',
                '2. pitched the party',
                '3. got the name and saved it',
                '4. asked instagram + confirmed the guestlist',
            ],
            now: '5. the instagram just arrived — save it',
        });

        for (const r of runs) {
            assert.ok(
                r.called('save_guest'),
                `checklist шаг 4: «when the instagram does arrive later, call save_guest again with it» — тул не вызван, вызовы: ${JSON.stringify(r.calls.map((c) => c.name))}`,
            );
            assert.match(
                String(r.inputOf('save_guest')?.instagram ?? ''),
                /igor_dxb/i,
                `checklist шаг 4: инстаграм не передан в тул, input=${JSON.stringify(r.inputOf('save_guest'))}`,
            );
            assert.doesNotMatch(
                r.text,
                /как(ой|ая).{0,15}инст|скинь.{0,15}инст|пришли.{0,15}инст|твой инстаграм\?/i,
                `checklist «Never ask twice»: инстаграм уже спрошен и уже пришёл. Текст: ${r.text}`,
            );
        }

        const guest = await selectGuest();
        assert.match(
            String(guest?.instagram),
            /igor_dxb/i,
            `инстаграм не записался в базу: ${JSON.stringify(guest)}`,
        );
    });

    it('гость отказался от стола — want_table false, после тула молчит и стол не всплывает', {
        timeout: 120_000,
    }, async () => {
        const runs = await thrice({
            history: [
                { role: 'user', text: 'ок' },
                {
                    role: 'assistant',
                    text: 'кстати, могу забронировать вам стол — будет своя зона. Интересно?',
                },
                { role: 'user', text: 'не, стол не нужен. а во сколько лучше приехать?' },
            ],
            parties: [SIRENE],
            state: [
                `party: SIRENE (party_id: ${SIRENE.party_id})`,
                'first_name: Игорь',
                'last_name: Гордилов',
                'on the guestlist: yes',
            ],
            done: [
                '1. greeted',
                '2. pitched the party',
                '3. got the name and saved it',
                '4. asked instagram + confirmed the guestlist',
                '5. sent our instagram + the whatsapp group',
                '6. offered a table',
            ],
            now: '6. the guest answered about the table — pass the answer to save_guest',
        });

        for (const r of runs) {
            assert.ok(
                r.called('save_guest'),
                'checklist шаг 6: отказ от стола тоже должен уйти в save_guest',
            );
            assert.equal(
                r.inputOf('save_guest')?.want_table,
                false,
                `checklist шаг 6: гость отказался — want_table должен быть false, input=${JSON.stringify(r.inputOf('save_guest'))}`,
            );

            const saved = r.calls.findIndex(
                (c) => c.name === 'save_guest' && c.input.want_table === false,
            );
            const after = r.calls.slice(saved + 1).filter((c) => c.name === 'send_message');
            assert.deepEqual(
                after,
                [],
                `checklist шаг 6: «the tool answers the guest itself — send nothing after it». Модель написала после: ${JSON.stringify(after)}`,
            );
            assert.ok(
                !r.called('pause_chat'),
                'checklist шаг 6: false → чат остаётся открытым, паузить нельзя',
            );
        }

        const saved = await selectGuestlist();
        assert.equal(
            saved[0]?.booked_table,
            false,
            `в базе должен лежать отказ от стола: ${JSON.stringify(saved[0])}`,
        );
    });

    it('пришёл из рекламы уже назвав вечеринку — не питчит вторую и прыгает к имени', {
        timeout: 120_000,
    }, async () => {
        const runs = await thrice({
            history: [
                {
                    role: 'user',
                    text: 'Привет! Видел рекламу SIRENE на FIVE JBR, хочу прийти',
                },
            ],
            parties: [LYLO, SIRENE],
            state: [],
            done: ['1. greeted'],
            now: '2. pitch the parties',
        });

        for (const r of runs) {
            assert.match(
                r.text,
                ASKS_NAME,
                `checklist шаг 2: «already naming a party → that is the party, skip to step 3» — имя не спрошено. Текст: ${r.text}`,
            );
            assert.ok(
                !/lylo|vista mare|deep house/i.test(r.text),
                `checklist шаг 2: вечеринка названа гостем — вторую питчить не надо. Текст: ${r.text}`,
            );
            assert.ok(
                !/как(ая|ую).{0,15}вечеринк|на какую|что.{0,15}ближе|выбер/i.test(r.text),
                `checklist шаг 2: вечеринка уже ясна — спрашивать «какую» нельзя. Текст: ${r.text}`,
            );
            assert.ok(
                !ASKS_TABLE.test(r.text),
                `checklist «Do exactly ONE step per reply»: убежал на шаг 6 (стол). Текст: ${r.text}`,
            );
        }
    });
});
