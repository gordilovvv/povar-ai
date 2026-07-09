# План: модуль agent + loop-разработка

## Цель
Ядро — **`agent.do` + тулзы + system prompt**, доведённые до правильного флоу.
env / DB-функции / тест-харнес — обслуга для прогона этого цикла.
Реализовать `src/intelligence/agent.ts` (agentic loop) под WhatsApp-флоу вечеринок.
Тест: реальный прогон Claude (sonnet), эмуляция входящих сообщений по очереди,
полное логирование. Итерируем через review-агента + simplify-агента, читаем логи,
правим логику, пока флоу не станет корректным.

## Зафиксированные решения
- Модель: `claude-sonnet-4-6`. SDK: `@anthropic-ai/sdk`, ручной tool-use loop (контроль + логи).
- Ответ гостю: tool `send_message`. `agent.do` возвращает собранные реплики (для наблюдаемости/воркера).
- Тулы ходят в БД сами (прод-путь). Тест — на реальной БД (креды даёт юзер) + скрипт `db-dev` для сидинга/insert.
- Тулы полного флоу: `update_guest` (есть, рефактор формы), `add_to_guestlist`, `book_table`, `send_message`.
- thinking sonnet: пока `disabled` (быстрый чат), effort не трогаем.

## Состояние
- `agent.ts` — заглушка. Тул `update_guest` есть, но handler формы `(guestId, raw)` и лезет в `pool`.
- Storage: `updateGuestProfile` есть; в `guestlist.ts` только select'ы — нет upsert/booking.
- Схема: `party_guestlist (party_id, guest_id pk, "table", visited_party, booked_table, booked_table_paid, joined_at)`.
- SDK установлен. Тестов нет (`tests/` пусто, `node --test 'tests/**/*.test.ts'`).

## Шаги
1. **env**: `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` в `environment.ts` (`z.string()`, без `.default()`). Ключ юзер кладёт в `.env.dev`.
2. **Форма тулов**: `intelligence/tools/types.ts` — `AgentTool { name, description, input(zod), handler(ctx, raw) }`, `ToolContext { guestId, phone, replies[] }`. Рефактор `updateGuest` под форму.
3. **Новые тулы**: `addToGuestlist`, `bookTable`, `sendMessage` (пишет в `ctx.replies`, логирует; WA-отправка позже). Реестр `intelligence/tools/index.ts`.
4. **DB (скилл db-code)**: добавить storage — guestlist upsert (`insert ... on conflict (party_id, guest_id) do update`), booking-апдейт. Первым параметром `client: PoolClient`.
5. **agent.ts**: system prompt (тон + флоу из CLAUDE.md/Figma) → tools (zod→json schema через `z.toJSONSchema`) → ручной loop (`messages.create` → `tool_use` → dispatch → `tool_result` → до `end_turn`). Логи `[agent]`/`[tool]` (ход, тулзы, реплики). Возврат `string[]`.
6. **Тест-харнес** `tests/agent.flow.test.ts`: собрать `ChatContext` (сид гость+вечеринка через `db-dev`), эмулировать последовательность сообщений по очереди, после каждого хода добавлять реплики в историю, логировать весь транскрипт + tool-calls.
7. **Прогон**: `node --test` на реальной БД + ключе. Читаю логи.
8. **Review-loop**: параллельно review-агент (баги/логика/конвенции CLAUDE.md) + simplify-агент → применяю фиксы.
9. **Итерации 5–8** пока флоу не корректен по сценариям: привет→тон, сбор имя/инста, тихий guest-list, предложение стола, отказ→позитивное закрытие.

## Датасет (эталон тона/флоу) — `dataset/sema_conversations.json`
Реальные переписки хоста **sema** (зелёные = эталон). Использовать как few-shot + tone-guide в system prompt.
- Тон: «бро/ты», тёплый, без давления, скобки-улыбки `) ))`, эмодзи умеренно.
- Формат: мысль дробится на **несколько пузырей подряд** → несколько `send_message` за ход.
- Язык: ведёт на языке гостя (ru/en) по входящему.
- Реальный флоу: привет → small talk (как дела / ты в Дубае?) → анонс (дата+площадка) → **бот сам собирает имя/фамилию/инсту в чате** → афиша/WA-группа.
- ВАЖНО: формы (`forms.gle`) больше нет — **бот заменяет форму**: имя/инсту собирает в чате (`update_guest`) и пишет в гест-лист (`add_to_guestlist`). Ссылку forms.gle НЕ шлём.
- Ассеты (статич. конфиг, `meta.links`): `whatsapp_group`, `flyer_reel`, IG площадок. (guestlist_form исключён.)
- Закрытие позитивное; иногда просьба о поддержке (сторис/репост/видео).
- Расхождение с Figma: продажи стола в данных почти нет — приоритет приглашение+гест-лист; стол оставляем тулом, но тон/флоу по датасету.

## Цикл итерации (повторяю автономно до цели)
```
пишу код (agent.do + тулзы + prompt)
   → агенты: review (баги/логика/CLAUDE.md) + simplify → правки
   → запуск теста (реальный Claude + БД)
   → читаю логи → флоу достигнут?
        нет → дорабатываю → повтор
        да  → стоп
```

## Нужно от юзера
- Креды БД применены + таблицы накачены (делает юзер).
- `db-dev` скрипт: подтвердить команду (найду в package.json/scripts).
- `ANTHROPIC_API_KEY` в `.env.dev` (кладёт юзер).

## Команды
- Тест: `node --env-file=.env.dev --test 'tests/**/*.test.ts'`.
- Один тест: `node --env-file=.env.dev --test tests/<file>.test.ts`.
- SQL/сид: `./scripts/db-dev.sh "INSERT ..."` или `./scripts/db-dev.sh "SELECT ..."`.
- Typecheck: `pnpm typecheck`. Lint: `pnpm lint`. Формат правит хук на Write автоматически.

## ГОТОВО (цикл сошёлся)
Реализовано и прогнано на реальном Claude + БД:
- `environment.ts`: добавлены `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`.
- `intelligence/tools/`: `types.ts` (`AgentTool` + `ToolContext{guestId,phone,replies}`), `sendMessage`, `updateGuest` (рефактор), `addToGuestlist` (select-or-create через рекурсию на unique, без удержания conn в рекурсии), `bookTable`, реестр `index.ts`.
- `db/guestlist.ts`: `selectGuestlistEntry`, `insertGuestlistEntry`, `updateGuestlistBooking`.
- `intelligence/agent.ts`: ручной tool-use loop + system prompt по датасету. Tool-ошибка ловится в try/catch → `tool_result`, ход не рушится. Fallback-текст (мимо send_message) идёт в replies только если send_message за ход пуст.
- Тест `tests/agent.flow.test.ts` — happy-path ПРОЙДЕН (привет→small talk→сбор имя/инста→update_guest→add_to_guestlist).
- Edge-кейсы проверены разовым прогоном: нерелевантное→мягкий стоп; отказ стола→позитивное закрытие. Совпали с датасетом.
- Review+simplify прогнаны, фиксы применены. typecheck зелёный.

## ИТЕРАЦИЯ 2 (доводка до датасета) — ГОТОВО
- Даты/время вечеринок: `db/party.ts` `selectActivePartyTimes` (+ `order by party_start_at`), `PartyTimeStorage`; `lib/time.ts` `formatDubai`; в prompt рендерятся дата+площадка+«бесплатно до X, после — цена» в дубайском времени. worker грузит `partyTimes` в ChatContext.
- Замеры: `agent.do` логирует per-step `in/out` токены + per-turn `N steps, replies, Xs Yms, tokens in/out`.
- `send_message` теперь принимает `texts: string[]` (все пузыри одним вызовом) — убрало N+1 round-trip'ов к Claude. Экономия: en-ход было 5 шагов/13s/in=12665 → 1 шаг/3.6s/in=2324.
- Детект языка гостя (`detectGuestLang`: кириллица vs латиница) → жёсткая директива в начале prompt. Починило срыв в русский при английском госте.
- Запрет markdown (WhatsApp = простой текст).
- Харнес `tests/agent.flow.test.ts`: 4 сценария (ru happy+стол, en, нерелевантное, две вечеринки) — все green. Грузит parties/partyTimes из БД как worker.
- Цикл соблюдён: код → simplify+review (агенты) → тест. Бот по логам/БД совпал с датасетом: small-talk-first, язык гостя, пузыри, замена формы, гест-лист, стол без давления, мультиплощадки «на какую?».

## ИТЕРАЦИЯ 3 (токены: данные в tools + prompt caching) — ГОТОВО
Эксперимент `tests/variants.bench.ts` — 5 вариаций на одном сценарии, метрики: взвешенные токены (cacheR×0.1, cacheW×1.25, out×5), время, шаги, транскрипт для качества.
- A инлайн (текущая): cost~33580. B тулзы-без-кэша: худшая (тулзы добавляют round-trip без кэша). C инлайн+кэш: не закэшировался (префикс <порога). D тулзы+кэш: cost~30372.
- **Победитель E-гибрид: cost~21189 (−37% к A), самый быстрый, качество на уровне.** Дизайн: статика (BEHAVIOR+tools) кэшируется (cache_control ephemeral); данные о вечеринках — через тул `get_parties` (сам ходит в БД); лёгкое состояние гостя+язык+время — инлайн в некэшируемом хвосте system.
Применено в прод: `tools/getParties.ts` (новый), `agent.ts` (system = [BEHAVIOR cached, tail], ChatContext без parties/partyTimes, лог cacheR/cacheW), `worker.ts` (не грузит parties). Подтверждено в логах: кэш активен на sonnet-4-6 (cacheW=1837 → cacheR на след. шагах), `in` упал до ~800–1500/шаг. Флоу-тест 4/4 green.
ВАЖНО: порог мин. кэш-префикса зависит от модели — при смене ANTHROPIC_MODEL на Opus (порог выше) кэш молча отключится; следить по логу cacheW.

Осталось вне scope: реальная WA-отправка replies в worker (сейчас worker игнорит результат `agent.do`); people_count для стола (нет колонки — в `table` пишется метка); опц. 2-й кэш-брейкпоинт на messages (кэш истории внутри хода).

## RESUME (после /clear читать этот файл первым)
Проверено и готово:
- SDK `@anthropic-ai/sdk@0.107.0` стоит. Node 24 запускает .ts напрямую.
- `.env.dev` содержит `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL=claude-sonnet-4-6`, `DATABASE_URL`, `PORT`, `WA_TOKEN`, `WA_SECRET`.
- Smoke `tests/smoke.test.ts` ПРОЙДЕН: Anthropic sonnet отвечает; БД доступна, таблицы есть (`guests, party, party_guestlist, wa_messages` + legacy `chats/connections/messages`).
- `scripts/db-dev.sh` = psql через DATABASE_URL (аргумент = SQL).
- Запрет: `.env*` нельзя читать/cat (deny-правила) — секреты только через `--env-file`.

Файлы-ориентиры:
- `src/intelligence/agent.ts` — ЗАГЛУШКА (класс Agent, метод `do(context)` пустой). ChatContext = {guest, messages, parties, ownedGuestlist, now}.
- `src/intelligence/tools/updateGuest.ts` — есть, форма `{name,description,input(zod),handler(guestId,raw)}`, лезет в pool. Рефактор под общий ToolContext.
- `src/db/`: guests.ts (`selectGuestByPhone`, `updateGuestProfile`), party.ts (`selectActiveParties`), guestlist.ts (только select'ы — нужен upsert + booking), wa-messages.ts.
- `src/worker.ts` — собирает ChatContext и зовёт `agent.do` (результат игнорит). Не ломать.
- `environment.ts` (корень) — НЕТ ANTHROPIC_* в схеме → добавить `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (`z.string()`, без default).
- `.claude/agents/simplifier.md` — есть кастомный simplify-агент.
- Датасет: `dataset/sema_conversations.json` (эталон тона/флоу, текст уже извлечён; скрины в dataset/*.jpeg — источник).

Следующий шаг при возобновлении: ШАГ 1 — добавить ANTHROPIC_* в `environment.ts`, затем шаг 2 (форма тулов) и далее по «Шаги»/«Цикл итерации».
Критерий цели: `agent.do` гоняет ручной tool-use loop и по сценариям дёргает нужные тулзы; тон/флоу совпадают с датасетом (small-talk-first, дробление на пузыри, язык гостя, бот заменяет форму).
