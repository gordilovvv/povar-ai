# WhatsApp Messages API — справочник

## Base URL

```
https://graph.facebook.com
```

## Аутентификация

Все запросы требуют Bearer-токен:

```
Authorization: Bearer <ACCESS_TOKEN>
```

---

## POST /{Version}/{Phone-Number-ID}/messages

Отправка сообщения пользователю WhatsApp.

### Заголовки

| Заголовок | Обязательный | Описание |
|-----------|:---:|---------|
| `Authorization` | ✓ | `Bearer <token>` |
| `Content-Type` | ✓ | `application/json` |

### Тело запроса

Все типы сообщений используют общую базу:

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "+16505551234",
  "type": "<MESSAGE_TYPE>",
  "context": { "message_id": "<wamid>" },
  "<MESSAGE_TYPE>": { ... }
}
```

| Поле | Тип | Обязательное | Описание |
|------|-----|:---:|---------|
| `messaging_product` | string | ✓ | Всегда `"whatsapp"` |
| `recipient_type` | `"individual"` \| `"group"` | ✓ | Тип получателя |
| `to` | string | ✓ | Номер телефона (`+...`) или ID группы |
| `type` | string | ✓ | Тип сообщения (см. ниже) |
| `context.message_id` | string | | `wamid` сообщения, на которое отвечаем (для цитирования) |

### Ответ 200

```json
{
  "messaging_product": "whatsapp",
  "contacts": [
    { "input": "+16505551234", "wa_id": "16505551234" }
  ],
  "messages": [
    {
      "id": "wamid.HBgL...",
      "message_status": "accepted"
    }
  ]
}
```

| Поле `message_status` | Описание |
|-----------------------|---------|
| `accepted` | Принято WhatsApp, обрабатывается |
| `held_for_quality_assessment` | Удерживается для оценки качества |
| `paused` | Доставка приостановлена |

---

## Типы сообщений

### `text` — Текст

```json
{
  "type": "text",
  "text": {
    "body": "Привет! Вечеринка в пятницу 🎉",
    "preview_url": true
  }
}
```

---

### `image` / `audio` / `video` / `document` / `sticker` — Медиа

Медиаобъект передаётся либо по `id` (загруженный на серверы Meta), либо по `link` (URL):

```json
{
  "type": "image",
  "image": {
    "id": "<MEDIA_ID>",
    "caption": "Флаер вечеринки"
  }
}
```

```json
{
  "type": "image",
  "image": {
    "link": "https://example.com/flyer.jpg",
    "caption": "Флаер вечеринки"
  }
}
```

Поля `caption` поддерживают: `image`, `video`, `document`. У `audio` и `sticker` — нет.

---

### `location` — Местоположение

```json
{
  "type": "location",
  "location": {
    "latitude": 55.7558,
    "longitude": 37.6173,
    "name": "Место проведения",
    "address": "ул. Примерная, 1"
  }
}
```

---

### `reaction` — Реакция

```json
{
  "type": "reaction",
  "reaction": {
    "message_id": "<wamid_of_target_message>",
    "emoji": "🔥"
  }
}
```

---

### `contacts` — Контактная карточка

```json
{
  "type": "contacts",
  "contacts": [{
    "name": {
      "first_name": "Иван",
      "last_name": "Иванов",
      "formatted_name": "Иван Иванов"
    },
    "phones": [{ "phone": "+79001234567", "type": "WORK" }],
    "emails": [{ "email": "ivan@example.com", "type": "WORK" }]
  }]
}
```

---

### `interactive` — Интерактивные сообщения

Общая структура:

```json
{
  "type": "interactive",
  "interactive": {
    "type": "<INTERACTIVE_TYPE>",
    "header": { ... },
    "body": { "text": "Основной текст" },
    "footer": { "text": "Подпись внизу" },
    "action": { ... }
  }
}
```

#### Кнопки ответа (`button`)

До 3 кнопок быстрого ответа:

```json
{
  "type": "interactive",
  "interactive": {
    "type": "button",
    "body": { "text": "Ты придёшь на вечеринку?" },
    "action": {
      "buttons": [
        { "type": "reply", "reply": { "id": "yes", "title": "Да, иду 🎉" } },
        { "type": "reply", "reply": { "id": "no",  "title": "Не смогу" } }
      ]
    }
  }
}
```

#### Список вариантов (`list`)

```json
{
  "type": "interactive",
  "interactive": {
    "type": "list",
    "body": { "text": "Выбери вечеринку:" },
    "action": {
      "button": "Смотреть",
      "sections": [{
        "title": "Ближайшие",
        "rows": [
          { "id": "party_1", "title": "Пятница, 20:00", "description": "Loft на Арбате" },
          { "id": "party_2", "title": "Суббота, 22:00", "description": "Крыша в центре" }
        ]
      }]
    }
  }
}
```

#### Кнопка с URL (`cta_url`)

```json
{
  "type": "interactive",
  "interactive": {
    "type": "cta_url",
    "body": { "text": "Подробности о вечеринке:" },
    "action": {
      "name": "cta_url",
      "parameters": {
        "display_text": "Открыть",
        "url": "https://example.com/party/123"
      }
    }
  }
}
```

---

### `template` — Шаблонное сообщение

Используется вне окна обслуживания клиента (требует одобрения Meta):

```json
{
  "type": "template",
  "template": {
    "name": "party_reminder",
    "language": { "code": "ru" },
    "components": [
      {
        "type": "body",
        "parameters": [
          { "type": "text", "text": "Иван" },
          { "type": "text", "text": "пятницу" }
        ]
      }
    ]
  }
}
```

---

## Марк как прочитанное

```
POST /{Version}/{Phone-Number-ID}/messages
```

```json
{
  "messaging_product": "whatsapp",
  "status": "read",
  "message_id": "<wamid_of_incoming_message>"
}
```

Ответ: `{ "success": true }`

---

## Схемы объектов

### `InteractiveObject`

| Поле | Тип | Обязательное | Описание |
|------|-----|:---:|---------|
| `type` | `button` \| `list` \| `cta_url` \| `flow` \| `product` \| `product_list` \| `catalog_message` \| `call_permission_request` | ✓ | Тип интерактивного сообщения |
| `header` | HeaderObject | | Заголовок (текст, фото, видео, документ) |
| `body` | BodyObject | | Основной текст (обязателен, кроме `product`) |
| `footer` | FooterObject | | Текст внизу |
| `action` | ActionObject | ✓ | Действие / варианты ответа |

### `HeaderObject`

| Поле | Тип | Описание |
|------|-----|---------|
| `type` | `text` \| `image` \| `video` \| `document` | |
| `text` | string | Для `type: "text"` |
| `image` / `video` / `document` | MediaObject | Медиаобъект |

### `SectionObject` (для `list` и `product_list`)

| Поле | Тип | Описание |
|------|-----|---------|
| `title` | string | Обязателен при >1 секции. Макс. 24 символа |
| `rows` | Rows[] | Строки списка |
| `product_items` | Product_items[] | Товары каталога |

### `Rows`

| Поле | Тип | Обязательное | Описание |
|------|-----|:---:|---------|
| `id` | string | ✓ | Уникальный ID строки |
| `title` | string | ✓ | Заголовок строки |
| `description` | string | | Описание |

### `MediaObject`

Либо `id`, либо `link` — обязательно:

| Поле | Описание |
|------|---------|
| `id` | ID медиафайла, загруженного на серверы Meta |
| `link` | URL медиафайла (кэшируется на 10 мин) |
| `caption` | Подпись (для image, video, document) |
| `filename` | Имя файла (для document) |
