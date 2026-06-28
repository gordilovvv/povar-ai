# WhatsApp — входящие Webhooks

Эндпоинт на стороне сервера для приёма всех входящих событий WhatsApp.

```
POST /whatsapp/webhooks
```

WhatsApp всегда ожидает ответ `200 OK`. Если ответ не придёт вовремя — повторит запрос.

---

## Общая структура

```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "<WABA_ID>",
    "changes": [{
      "field": "messages",
      "value": { ... }
    }]
  }]
}
```

Поле `field` определяет тип события:

| `field` | Описание |
|---------|---------|
| `messages` | Входящее сообщение от пользователя или статус исходящего |
| `group_lifecycle_update` | Создание / удаление группы |
| `group_settings_update` | Изменение настроек группы |
| `group_participant_update` | Участники вошли / вышли из группы |

---

## Типы `value` внутри `changes`

### 1. Входящее сообщение (`IncomingMessageValueGeneral`)

Признак: содержит `contacts` + `messages`.

```json
{
  "messaging_product": "whatsapp",
  "metadata": {
    "display_phone_number": "15550783881",
    "phone_number_id": "106540352242922"
  },
  "contacts": [{
    "profile": { "name": "Иван Иванов" },
    "wa_id": "16505551234"
  }],
  "messages": [{ ... }]
}
```

### 2. Системное сообщение (`IncomingMessageValueSystem`)

Признак: `messages[]` содержит объекты с `type: "system"`. Нет поля `contacts`.

### 3. Статус исходящего (`StatusMessageValue`)

Признак: содержит `statuses` (без `messages`). Подробнее — в [`whatsapp-overview.md`](whatsapp-overview.md).

### 4. Групповое событие (`GroupValue`)

Признак: содержит `groups`.

---

## Типы входящих сообщений (`messages[].type`)

### Базовые поля (все типы)

| Поле | Тип | Описание |
|------|-----|---------|
| `from` | string | Номер телефона отправителя |
| `id` | string | Уникальный ID сообщения (`wamid...`) |
| `timestamp` | string | Unix-время |
| `type` | string | Тип сообщения |

---

### `text` — Текст

```json
{
  "type": "text",
  "text": { "body": "хочу на вечеринку в пятницу" }
}
```

Дополнительно может содержать:
- `referral` — если пришло через Click-to-WhatsApp рекламу (см. ниже)
- `context` — если пришло через кнопку "написать бизнесу" из каталога

---

### `image` / `audio` / `video` / `document` / `sticker` — Медиа

```json
{
  "type": "image",
  "image": {
    "id": "<MEDIA_ID>",
    "mime_type": "image/jpeg",
    "sha256": "abc123...",
    "caption": "Подпись к фото"
  }
}
```

Получить файл: `GET /{Version}/{MEDIA_ID}` → вернёт URL для скачивания.

`caption` есть у `image`, `video`, `document`. У `audio` и `sticker` — нет.

---

### `location` — Геолокация

```json
{
  "type": "location",
  "location": {
    "latitude": 55.7558,
    "longitude": 37.6173,
    "name": "Loft Club",
    "address": "ул. Арбат, 1"
  }
}
```

---

### `reaction` — Реакция на сообщение

```json
{
  "type": "reaction",
  "reaction": {
    "message_id": "<wamid_of_reacted_message>",
    "emoji": "🔥"
  }
}
```

---

### `contacts` — Поделился контактом

```json
{
  "type": "contacts",
  "contacts": [{
    "name": { "formatted_name": "Иван Иванов", "first_name": "Иван" },
    "phones": [{ "phone": "+79001234567", "wa_id": "79001234567", "type": "CELL" }],
    "emails": [{ "email": "ivan@example.com", "type": "WORK" }]
  }]
}
```

---

### `interactive` — Ответ на интерактивное сообщение

#### Нажата кнопка (`button_reply`)

```json
{
  "type": "interactive",
  "interactive": {
    "type": "button_reply",
    "button_reply": {
      "id": "yes",
      "title": "Да, иду 🎉"
    }
  }
}
```

#### Выбор из списка (`list_reply`)

```json
{
  "type": "interactive",
  "interactive": {
    "type": "list_reply",
    "list_reply": {
      "id": "party_1",
      "title": "Пятница, 20:00",
      "description": "Loft на Арбате"
    }
  }
}
```

---

### `unsupported` — Неподдерживаемый тип

Если клиент прислал тип, который платформа не поддерживает. Содержит `errors[]` с деталями.

---

## Referral — пришёл через рекламу (Click to WhatsApp)

Добавляется к текстовому сообщению, если пользователь написал через рекламу:

```json
{
  "referral": {
    "source_url": "https://fb.com/ads/...",
    "source_id": "<AD_ID>",
    "source_type": "ad",
    "body": "Основной текст рекламы",
    "headline": "Заголовок рекламы",
    "media_type": "image",
    "image_url": "https://...",
    "ctwa_clid": "<CLICK_ID>",
    "welcome_message": { "text": "Приветственный текст из рекламы" }
  }
}
```

---

## Групповые события (`GroupValue`)

```json
{
  "groups": [{
    "timestamp": 1750030073,
    "group_id": "<GROUP_ID>",
    "type": "group_add_participants",
    "request_id": "<REQUEST_ID>",
    "subject": "Вечеринка пятница",
    "added_participants": [
      { "input": "+16505551234", "wa_id": "16505551234" }
    ]
  }]
}
```

| `type` | Описание |
|--------|---------|
| `group_create` | Группа создана |
| `group_delete` | Группа удалена |
| `group_settings_update` | Изменены настройки (название, описание, фото) |
| `group_add_participants` | Добавлены участники |
| `group_remove_participants` | Удалены участники |

---

## Статус исходящего (внутри того же эндпоинта)

```json
{
  "statuses": [{
    "id": "<wamid>",
    "status": "delivered",
    "timestamp": "1750030073",
    "recipient_id": "16505551234",
    "conversation": { "id": "...", "origin": { "type": "service" } },
    "pricing": { "billable": true, "pricing_model": "PMP", "category": "service" }
  }]
}
```

Возможные статусы: `sent` / `delivered` / `read` / `failed`. При `failed` — добавляется массив `errors[]`.

---

## Как парсить Webhook (TypeScript)

```typescript
function handleWebhook(body: WebhookPayload) {
  const value = body.entry[0].changes[0].value;
  const field = body.entry[0].changes[0].field;

  // Статус исходящего
  if ('statuses' in value) {
    const s = value.statuses[0];
    console.log(`Status: ${s.status} for ${s.id}`);
    return;
  }

  // Групповое событие
  if ('groups' in value) {
    const g = value.groups[0];
    console.log(`Group event: ${g.type} in ${g.group_id}`);
    return;
  }

  // Входящее сообщение
  if ('messages' in value) {
    const msg = value.messages[0];
    const from = msg.from;
    const senderName = value.contacts?.[0]?.profile?.name;

    switch (msg.type) {
      case 'text':
        // передать агенту: msg.text.body
        break;
      case 'interactive':
        if (msg.interactive.type === 'button_reply') {
          // msg.interactive.button_reply.id
        } else if (msg.interactive.type === 'list_reply') {
          // msg.interactive.list_reply.id
        }
        break;
      case 'image':
      case 'audio':
      case 'video':
      case 'document':
        // скачать: GET /{Version}/{msg[msg.type].id}
        break;
      case 'unsupported':
        // игнорировать или ответить "не поддерживается"
        break;
    }
  }
}
```

---

## Relevance для sema

- Основной сценарий: `type: "text"` → передать текст агенту Claude.
- `type: "interactive"` с `button_reply` — пользователь нажал «Да, иду» → вызвать `add_guest`.
- `type: "interactive"` с `list_reply` — пользователь выбрал вечеринку из списка.
- Поле `from` — ключ для идентификации пользователя и поиска в `check_guest`.
- `contacts[0].profile.name` — имя из профиля WhatsApp (не всегда совпадает с реальным).
- Сохранять `messages[0].id` (`wamid`) — нужен для отправки контекстных ответов (цитирование) и реакций.
