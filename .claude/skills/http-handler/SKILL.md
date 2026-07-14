---
name: http-handler
description: Конвенции для HTTP-хендлеров. Обязательно используй этот скилл всегда, когда пишешь или правишь хендлер HTTP-запроса — новую ручку, обработчик роута, файл-хендлер (напр. в Dashboard/). Триггерится на «напиши ручку», «новый хендлер», «добавь эндпоинт», «обработай запрос», даже если конвенции не упомянуты явно.
---

# Хендлеры

Стек: `itty-router` v5, `pg`. Один файл — один обработчик. Файл PascalCase, лежит в своей feature-папке (админка — `Dashboard/`). Экспорт = имя ручки + суффикс `Handler` (camelCase): `Dashboard/ChatsGetList.ts` → `chatsGetListHandler`.

## Каркас простого хендлера

Простую ручку — линейным телом сверху вниз, без разбиения на функции:

```ts
export const <name>Handler: RequestHandler<IRequest> = async (request) => {
    // 1. вход
    const <param> = safeParse...(request.query.<param>);
    // 2. БД: connect → запрос в try/finally → release ДО маппинга
    const client = await pool.connect();
    let rows: <Row>[];
    try { rows = await select<...>(client, <args>); } finally { client.release(); }
    // 3. маппинг ряд→ответ: for...of + push в const
    const res: <Name>Response[] = [];
    for (const row of rows) { res.push({ /* ... */ }); }
    // 4. ответ
    return success({ items: res, nextLastId });
};
```

## Когда дробить на функции

Решает сложность, не тип запроса: простая ручка — линейно в теле экспорта; сложная логика/рекурсия — экспорт-флоу сверху, шаги ниже. Классика — select-or-create с разрешением гонки рекурсией:

```ts
const handle = async (key: string): Promise<Thing> => {
    const client = await pool.connect();
    try {
        const existing = await selectThing(client, key);
        if (existing) { return existing; }
        try { return await insertThing(client, key); }
        catch (error) {
            if (isUniqueViolation(error)) { return handle(key); }
            throw error;
        }
    } finally { client.release(); }
};
```

## Вход
- Query/params — парсерами `#Lib/Fmt.js`, не сырым `parseInt`/regex:
  - `safeParseDigits(q)` — цифровой id/курсор: строка цифр или `null`. Bigint-id держим строкой, не `number` (precision).
  - `safeParseInt(q, default)` — целое, на невалиде `default`.
  - `safeParseString(q)` — строка санитизированная или `null`.
  - `limit`: `minMax(x, 1, <max>)` из `#Lib/Fmt.js` — clamp не инлайним `Math.min(Math.max(...))`; min/max-числа передаём тут же в `minMax`.
- Тело (POST/PUT) — Zod `safeParse` + ранний `return` ошибкой (Zod — для body, `safeParse*` — для query/params).

## БД и соединение
- `pool.connect()` в хендлере/шаге, ходящем в базу. Db в `try/finally` + `release` **до** маппинга и внешних вызовов.
- `count`/`bigint` из pg приходят строкой — `Number()` (или строкой, если id: precision).

## Даты
- Наружу: `fromDateTime(value)` из `#Lib/Fmt.js` — UTC ISO или `null`. `.toISOString()` инлайн нельзя.
- В базу: `toDateTime(value)` из `#Lib/Fmt.js` (детали в `db-code`). Всё UTC.

## Ответ и ошибки
- Через `#Dashboard/Lib/Response.js`: `success(data)` (200, no-store), `badRequest()` (400), `unauthorized()` (401), `notFound()` (404), `serverError()` (500). Response-хелперы живут в Dashboard-слое (`#Dashboard/Lib/Response.js`); query-парсеры и даты (`fromDateTime`/`toDateTime`) — общие, в `#Lib/Fmt.js`.
- Пустой результат «по id» → 404 (`notFound()`), не 200 с `null`.
- Fail-fast: хендлер в `try/catch` ради лога-проброса не оборачиваем — летит наверх, `serverError()` (500) отдаёт глобальный catch роутера. `try` только вокруг db ради `release`.

## Пагинация
- keyset `lastId`+`limit`, не offset. `nextLastId` — id последнего или `null`, если `res.length !== limit`.
