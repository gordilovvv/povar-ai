# WhatsApp Business API — справочник

---

## Webhooks — уведомления о сообщениях

*Обновлено: 17 июн 2026 г.*

Webhooks сообщений описывают сообщения, отправленные компании пользователем WhatsApp и наоборот.

---

### Структура полезных данных

Все Webhooks имеют общую обёртку:

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "<WABA_ID>",
      "changes": [
        {
          "value": { ... },
          "field": "messages"
        }
      ]
    }
  ]
}
```

---

### Входящие сообщения (user → business)

Признак: `entry.changes.value` содержит массив **`messages`**.

Источники: прямое сообщение, реакция на рекламу, нажатие на кнопку в предыдущем сообщении.

**Пример — текстовое сообщение:**

```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "102290129340398",
    "changes": [{
      "value": {
        "messaging_product": "whatsapp",
        "metadata": {
          "display_phone_number": "15550783881",
          "phone_number_id": "106540352242922"
        },
        "contacts": [{
          "profile": { "name": "Sheena Nelson" },
          "wa_id": "16505551234"
        }],
        "messages": [{
          "from": "16505551234",
          "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
          "timestamp": "1749416383",
          "type": "text",
          "text": { "body": "Does it come in another color?" }
        }]
      },
      "field": "messages"
    }]
  }]
}
```

Тип сообщения указан в поле `messages[].type`. Каждый тип (`text`, `image`, `audio`, `reaction`, `interactive`, и др.) имеет собственную структуру внутри объекта сообщения.

---

### Исходящие сообщения — статусы (business → user)

Признак: `entry.changes.value` содержит массив **`statuses`**.

Уведомления не содержат тело сообщения — только его статус. На одно исходящее сообщение приходит до **трёх отдельных Webhooks**:

| Статус | Значение |
|--------|----------|
| `sent` | Сообщение отправлено с сервера WhatsApp |
| `delivered` | Доставлено на устройство пользователя |
| `read` | Прочитано пользователем |

**Пример — статус `delivered`:**

```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "102290129340398",
    "changes": [{
      "value": {
        "messaging_product": "whatsapp",
        "metadata": {
          "display_phone_number": "15550783881",
          "phone_number_id": "106540352242922"
        },
        "statuses": [{
          "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBI3MTE5MjVBOTE3MDk5QUVFM0YA",
          "status": "delivered",
          "timestamp": "1750263773",
          "recipient_id": "16505551234",
          "conversation": {
            "id": "6ceb9d929c9bdc4f90e967a32f8639b4",
            "origin": { "type": "service" }
          },
          "pricing": {
            "billable": true,
            "pricing_model": "CBP",
            "category": "service"
          }
        }]
      },
      "field": "messages"
    }]
  }]
}
```

---

### Ошибки в Webhooks

Ошибки могут появиться в трёх местах:

| Место | Путь | Описание |
|-------|------|----------|
| Системные / аккаунта | `entry.changes.value.errors` | Ошибки уровня системы, приложения или аккаунта |
| Входящие сообщения | `entry.changes.value.messages.errors` | `type` = `unsupported` — неподдерживаемый тип сообщения |
| Исходящие сообщения | `entry.changes.value.statuses.errors` | Ошибки доставки |

---

## Webhooks — статусы исходящих сообщений (детально)

*Обновлено: 21 мая 2026 г.*

### Триггеры

- Сообщение отправлено с сервера WhatsApp (`sent`)
- Сообщение доставлено на устройство (`delivered`)
- Сообщение показано в открытой переписке (`read`)
- Голосовое сообщение воспроизведено впервые (`played`)
- Сообщение не удалось отправить или доставить (`failed`)
- Сообщение отправлено в групповой чат

> **Важно:** если пользователь открыл чат и сообщение сразу прочитано — Webhook `delivered` не отправляется, только `read`. Считается, что read подразумевает delivered.

---

### Поля объекта `statuses[]`

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | string | ID сообщения WhatsApp (`wamid...`) |
| `status` | string | `sent` / `delivered` / `read` / `played` / `failed` |
| `timestamp` | string | Unix-время срабатывания Webhook |
| `recipient_id` | string | Номер телефона пользователя или ID группы |
| `recipient_type` | string | Только для групп: `"group"` |
| `recipient_participant_id` | string | Только для групп: номер телефона участника |
| `biz_opaque_callback_data` | string | Произвольные данные, переданные при отправке сообщения (только для `sent` + один из `delivered`/`read`) |
| `conversation.id` | string | ID переписки (v24.0+: только для бесплатных entry point переписок) |
| `conversation.expiration_timestamp` | string | Когда истекает переписка (только в `sent`) |
| `conversation.origin.type` | string | Категория переписки (см. ниже) |
| `pricing.billable` | boolean | Платное ли сообщение (устаревает, использовать `pricing.type`) |
| `pricing.pricing_model` | string | `CBP` (до 1 июля 2025) / `PMP` |
| `pricing.type` | string | `regular` / `free_customer_service` / `free_entry_point` |
| `pricing.category` | string | Категория тарифа (см. ниже) |
| `errors[]` | array | Только при `failed` |

> `conversation` и `pricing` включаются только в `sent` + один из `delivered`/`read`. В v24.0+ `conversation` отсутствует, если переписка не является бесплатной entry point.

---

### Категории переписок (`origin.type` / `pricing.category`)

| Значение | Описание |
|----------|----------|
| `authentication` | Аутентификация |
| `authentication_international` | Международная аутентификация |
| `marketing` | Маркетинговые сообщения |
| `marketing_lite` | Marketing Messages API |
| `referral_conversion` | Бесплатная entry point переписка |
| `service` | Поддержка (входящий диалог) |
| `utility` | Служебные сообщения |

---

### Статусы сообщений

| `status` | UI WhatsApp | Описание |
|----------|-------------|----------|
| `sent` | ✓ (одна галочка) | Отправлено с сервера |
| `delivered` | ✓✓ (две серые) | Доставлено на устройство |
| `read` | ✓✓ (две голубые) | Прочитано в открытом чате |
| `played` | 🎙 (голубой микрофон) | Голосовое воспроизведено |
| `failed` | ⚠️ (красный треугольник) | Не удалось отправить/доставить |

---

### Примеры

**Маркетинговое сообщение — `sent`:**

```json
{
  "statuses": [{
    "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=",
    "status": "sent",
    "timestamp": "1750030073",
    "recipient_id": "16505551234",
    "conversation": {
      "id": "72b14d6bd5407799e66f64d1b338e567",
      "expiration_timestamp": "1750116480",
      "origin": { "type": "marketing" }
    },
    "pricing": {
      "billable": true,
      "pricing_model": "PMP",
      "type": "regular",
      "category": "marketing"
    }
  }]
}
```

**Статус `read` (v24.0 — без `conversation` и `pricing`):**

```json
{
  "statuses": [{
    "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=",
    "status": "sent",
    "timestamp": "1750030073",
    "recipient_id": "16505551234"
  }]
}
```

**Ошибка доставки (`failed`):**

```json
{
  "statuses": [{
    "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBI0QUQ2MjA4NEYyRkExNjMyREUA",
    "status": "failed",
    "timestamp": "1751142888",
    "recipient_id": "16505551234",
    "errors": [{
      "code": 131049,
      "title": "This message was not delivered to maintain healthy ecosystem engagement.",
      "message": "This message was not delivered to maintain healthy ecosystem engagement.",
      "error_data": {
        "details": "In order to maintain a healthy ecosystem engagement, the message failed to be delivered."
      },
      "href": "/documentation/business-messaging/whatsapp/support/error-codes"
    }]
  }]
}
```

---

### Relevance для sema

- Напоминание за день до вечеринки → шаблон категории `utility` или `marketing`, тариф `PMP`.
- Отслеживать `failed` — если ошибка 131049, значит Meta заблокировала по качеству (см. [`doc/whatsapp-message-quality.md`](whatsapp-message-quality.md)).
- `service` переписка — когда пользователь пишет первым; агент отвечает в её рамках бесплатно.
- `biz_opaque_callback_data` можно использовать для передачи `guest_id` или `party_id` при отправке напоминания.

---

## Отправка сообщений (Messages API)

*Обновлено: 21 мая 2026 г.*

### Сообщения поддержки (Service messages)

Сообщения в свободной форме, **не требующие одобрения Meta**. Можно отправлять только в рамках **окна обслуживания клиента**.

**Окно обслуживания клиента:**
- Открывается, когда пользователь пишет или звонит компании.
- Длится **24 часа** с момента последнего сообщения/звонка пользователя.
- Таймер сбрасывается при каждом новом сообщении от пользователя.
- После закрытия окна — только шаблонные сообщения.

---

### Запрос на отправку

```
POST /<WHATSAPP_BUSINESS_PHONE_NUMBER_ID>/messages
```

Общая структура тела:

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "+16505551234",
  "type": "<MESSAGE_TYPE>",
  "<MESSAGE_TYPE>": { ... }
}
```

`recipient_type`: `individual` (личное) или `group` (групповой чат).

**Пример — текстовое сообщение:**

```bash
curl 'https://graph.facebook.com/v25.0/106540352242922/messages' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer EAAJB...' \
  -d '{
    "messaging_product": "whatsapp",
    "recipient_type": "individual",
    "to": "+16505551234",
    "type": "text",
    "text": {
      "preview_url": true,
      "body": "Привет! Вот ссылка на мероприятие: https://example.com/party"
    }
  }'
```

---

### Ответ API

API возвращает подтверждение **принятия** запроса, а не доставки. Статус доставки приходит через Webhooks.

```json
{
  "messaging_product": "whatsapp",
  "contacts": [
    { "input": "+16505551234", "wa_id": "16505551234" }
  ],
  "messages": [
    { "id": "wamid.HBgLMTY0NjcwNDM1OTUVAgARGBI4MjZGRDA0OUE2OTQ3RkEyMzcA" }
  ]
}
```

Поле `messages[].id` — это `wamid`, который потом придёт в Webhook-статусах (`sent` / `delivered` / `read`).

---

### Типы сообщений поддержки

| Тип | Описание |
|-----|----------|
| `text` | Текст + опциональный превью ссылки |
| `image` | Изображение + подпись |
| `audio` | Аудиофайл |
| `video` | Видео + подпись |
| `document` | Документ |
| `sticker` | Статический или анимированный стикер |
| `location` | Координаты (широта/долгота) |
| `contacts` | Контактная карточка |
| `reaction` | Эмодзи-реакция на сообщение |
| `interactive` (reply_button) | До 3 кнопок быстрого ответа |
| `interactive` (list) | Список вариантов для выбора |
| `interactive` (cta_url) | Кнопка с URL |
| `interactive` (flow) | WhatsApp Flows (запись, каталог, опросы) |
| `interactive` (call) | Кнопка звонка WhatsApp |
| `request_welcome` | Запрос адреса доставки |
| `request_location` | Запрос геолокации |

---

### Форматы номеров телефонов

Всегда указывать `+` и код страны:

| Номер в запросе | Получатель | Результат |
|-----------------|------------|-----------|
| `+16315551234` | `+16315551234` | Верно |
| `+1 (631) 555-1234` | `+16315551234` | Верно |
| `(631) 555-1234` | `+916315551234` | Неверно (добавится код страны компании) |

---

### Важные технические нюансы

**Кэширование медиа.** Если передавать URL файла (а не `id`), Cloud API кэширует его на 10 минут. Для обхода кэша добавить случайный query-параметр: `?v=123`.

**Порядок доставки.** При отправке серии сообщений порядок доставки не гарантируется. Для строгой последовательности — ждать Webhook `delivered` перед следующей отправкой.

**Срок действия сообщения (TTL):**
- Обычные сообщения: **30 дней** (Cloud API повторяет попытки до истечения).
- Шаблоны аутентификации: **10 минут**.
- Если `delivered` не пришёл до истечения TTL — сообщение сброшено.

---

### Дополнительные возможности

- **Уведомление о прочтении** — пометить входящее сообщение как прочитанное (две синие галочки у пользователя).
- **Индикатор набора текста** — показать пользователю, что агент готовит ответ.
- **Контекстный ответ** — отправить сообщение с цитатой предыдущего (блок цитирования в чате).

---

### Relevance для sema

- Агент отвечает в рамках сервисного окна → тип `service`, бесплатно.
- Кнопки (`interactive` reply_button) удобны для подтверждения: «Да, иду» / «Нет, не смогу».
- Напоминание за день до вечеринки — за пределами окна → шаблонное сообщение (см. раздел про шаблоны).
- `messages[].id` из ответа сохранять в БД — нужен для связи с Webhook-статусами.

---

### Как разобрать Webhook в коде (псевдокод)

```typescript
function handleWebhook(body: WhatsAppWebhookPayload) {
  const value = body.entry[0].changes[0].value;

  if (value.messages) {
    // входящее сообщение от пользователя
    const msg = value.messages[0];
    const from = msg.from;        // номер телефона пользователя
    const type = msg.type;        // "text" | "image" | "audio" | ...
    // передать агенту
  }

  if (value.statuses) {
    // статус исходящего сообщения
    const status = value.statuses[0];
    // "sent" | "delivered" | "read"
  }

  if (value.errors) {
    // системная ошибка
  }
}
```
