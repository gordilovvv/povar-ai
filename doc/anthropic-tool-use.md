# Anthropic Tool Use

## Обзор

Tool use позволяет Claude вызывать внешние функции/API. Каждый инструмент описывается схемой JSON Schema.

---

## Типы инструментов

### 1. Client-side tools (пользовательские)
Определяются разработчиком, выполняются на стороне клиента:
- `text_editor` — чтение и редактирование файлов
- `bash` — выполнение shell-команд
- `memory` — хранение состояния между сессиями

### 2. Server tools (серверные, от Anthropic)
- `web_search_20260209` — поиск в вебе
- `web_fetch_20260209` — загрузка страницы по URL
- `code_execution_20260521` — выполнение Python/bash в sandbox-контейнере (базовый тип; результат в `bash_code_execution_tool_result`)
- `code_execution_20260120` — версия с REPL-персистом + programmatic tool calling (Opus 4.5+/Sonnet 4.5+)

---

## Базовая структура запроса

```json
{
  "tools": [
    {
      "name": "get_weather",
      "description": "Get the current weather in a given location",
      "input_schema": {
        "type": "object",
        "properties": {
          "location": { "type": "string" }
        },
        "required": ["location"]
      }
    }
  ]
}
```

---

## Популярные комбинации инструментов

### Research agent: web_search + code_execution
Ищет данные, потом анализирует Python-кодом.
```json
{
  "tools": [
    { "type": "web_search_20260209", "name": "web_search" },
    { "type": "code_execution_20260521", "name": "code_execution" }
  ]
}
```
Внимание: у `web_search_20260209` / `web_fetch_20260209` динамическая фильтрация уже работает через code execution под капотом — отдельный `code_execution` объявляй только если код нужен для своих задач (анализ данных, файлы), не ради веба.

### Coding agent: text_editor + bash
Читает/правит файлы, запускает тесты.
```json
{
  "tools": [
    { "type": "text_editor_20250728", "name": "str_replace_based_edit_tool" },
    { "type": "bash_20250124", "name": "bash" }
  ]
}
```

### Cite-then-fetch: web_search + web_fetch
Сначала находит релевантные URL, потом загружает только нужные.

### Long-running agent: memory + any toolset
`memory` сохраняет контекст между сессиями — добавляется к любому набору инструментов.

---

## Prompt Caching для tools

Ставить `cache_control: {"type": "ephemeral"}` на **последний** инструмент в массиве — кэшируется весь префикс определений инструментов.

```json
{
  "name": "get_time",
  "input_schema": { ... },
  "cache_control": { "type": "ephemeral" }
}
```

**Что сбрасывает кэш:**

| Изменение | Сбрасывает |
|---|---|
| Изменение tool definitions | Всё (tools + system + messages) |
| Включение/отключение web_search, citations | system + messages |
| Изменение `tool_choice` | messages |
| Изменение `disable_parallel_tool_use` | messages |

Серверные инструменты (web_search, code_execution) автоматически ставят cache breakpoint на свой результат — появляется в `usage.cache_creation.ephemeral_5m_input_tokens`.

---

## Programmatic Tool Calling

Claude пишет Python-код, который вызывает инструменты программно внутри code_execution — без лишних round-trips через модель.

**Когда выгодно:**
- Много однотипных вызовов (fan-out: 20+ записей, 10+ endpoint'ов)
- Большие ответы, которые нужно фильтровать/агрегировать до попадания в контекст
- Agentic search с итеративными запросами

**Когда НЕ выгодно:**
- Строго последовательный флоу, где каждый вызов требует reasoning модели
- Мало вызовов с маленькими ответами (overhead > savings)

### Настройка

В определении инструмента добавляется поле `allowed_callers`:

```json
{
  "name": "query_database",
  "description": "Execute SQL. Returns JSON array of rows.",
  "input_schema": {
    "type": "object",
    "properties": {
      "sql": { "type": "string" }
    },
    "required": ["sql"]
  },
  "allowed_callers": ["code_execution_20260120"]
}
```

**Значения `allowed_callers`:**
- `["direct"]` — только прямой вызов Claude (дефолт)
- `["code_execution_20260120"]` — только из кода
- `["direct", "code_execution_20260120"]` — оба варианта

### Флоу programmatic calling

1. Claude пишет Python с `await tool_name({...})`
2. API паузирует и возвращает `tool_use` блок с `caller.type: "code_execution_20260120"`
3. Клиент возвращает `tool_result`
4. Код продолжает выполнение
5. Claude получает итоговый `stdout` и продолжает ответ

### Ответ API при паузе

```json
{
  "content": [
    { "type": "server_tool_use", "id": "srvtoolu_abc123", "name": "code_execution", "input": { "code": "..." } },
    {
      "type": "tool_use",
      "id": "toolu_def456",
      "name": "query_database",
      "input": { "sql": "SELECT ..." },
      "caller": { "type": "code_execution_20260120", "tool_id": "srvtoolu_abc123" }
    }
  ],
  "container": { "id": "container_xyz789", "expires_at": "..." },
  "stop_reason": "tool_use"
}
```

### Продолжение (tool_result)

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_def456",
      "content": "[{\"id\": 1, \"revenue\": 45000}]"
    }
  ]
}
```

**Важно:** при ответе на programmatic tool call — только `tool_result` блоки, никакого текста рядом.

Также обязательно передать `container` ID и тот же массив `tools`.

### Паттерны в коде Claude

```python
# Batch processing
results = {}
for region in ["West", "East", "Central"]:
    rows = json.loads(await query_database({"sql": f"SELECT ... WHERE region = '{region}'"}))
    results[region] = sum(r["revenue"] for r in rows)

# Early termination
for endpoint in endpoints:
    status = await check_health({"endpoint": endpoint})
    if status == "healthy":
        print(f"Found: {endpoint}")
        break

# Conditional tool selection
info = json.loads(await get_file_info({"path": path}))
if info["size"] < 10000:
    content = await read_full_file({"path": path})
else:
    content = await read_file_summary({"path": path})
```

### Container lifecycle

- Создаётся новый на каждый запрос (или переиспользуется по ID)
- `expires_at` — когда истекает; idle ~5 минут; max 30 дней
- Timeout ожидания tool_result ~4 минуты — после этого `TimeoutError` в stderr

### Ограничения programmatic calling

- Не работает с `strict: true` (structured outputs)
- `tool_choice` не может форсировать programmatic вызов
- `disable_parallel_tool_use: true` несовместимо
- MCP-инструменты нельзя вызывать программно
- Результаты tool_result — только строки/text блоки (не изображения)

### Эффективность

- Результаты programmatic вызовов **не попадают в контекст** — только финальный stdout
- На тестах: -38% input tokens на 75-tool agent benchmark
- На простых sequential workflows (1-2 вызова) — без выигрыша, +8% overhead

---

## Поддерживаемые модели (programmatic calling)

Требует `code_execution_20260120` или новее:
- claude-fable-5
- claude-opus-4-8 / 4-7 / 4-6
- claude-sonnet-4-6
- claude-opus-4-5, claude-sonnet-4-5

Доступно: Claude API, Claude Platform on AWS, Microsoft Foundry (только Hosted on Anthropic).
Недоступно: Amazon Bedrock, Google Cloud.
