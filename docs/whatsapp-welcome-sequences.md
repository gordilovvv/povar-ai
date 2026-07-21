# WhatsApp — цепочки приветственных сообщений (Welcome Message Sequences)

*Обновлено: 16 июн 2026 г.*

Используются в рекламе с переходом в WhatsApp (Click-to-WhatsApp). Когда пользователь нажимает на рекламу, ему показывается приветственное сообщение с текстом, предзаполненным ответом и кнопками быстрых ответов (ice breakers).

**Требование:** разрешение `whatsapp_business_management`.

---

## Эндпоинты

| Метод | Путь | Действие |
|-------|------|---------|
| `POST` | `/<WABA_ID>/welcome_message_sequences` | Создать или обновить цепочку |
| `GET` | `/<WABA_ID>/welcome_message_sequences` | Получить список или конкретную цепочку |
| `DELETE` | `/<WABA_ID>/welcome_message_sequences` | Удалить цепочку |

> Нельзя удалить цепочку, привязанную к активной рекламе.

---

## Создание цепочки

```bash
curl -X POST \
  -F 'name="Вечеринка пятница"' \
  -F 'welcome_message_sequence={
    "text": "Привет! Я помогу тебе попасть на вечеринку 🎉",
    "autofill_message": {"content": "Хочу на вечеринку!"},
    "ice_breakers": [
      {"title": "Ближайшие вечеринки"},
      {"title": "Как попасть в гостевой список"},
      {"title": "Цены и детали"}
    ]
  }' \
  "https://graph.facebook.com/v25.0/<WABA_ID>/welcome_message_sequences" \
  -H 'Authorization: Bearer EAAJB...'
```

Ответ:

```json
{ "sequence_id": "186473890" }
```

### Параметры

| Параметр | Тип | Обязательный | Описание |
|----------|-----|:---:|---------|
| `name` | string | ✓ | Название цепочки |
| `welcome_message_sequence` | object | ✓ | Объект приветственного сообщения (см. ниже) |

### Структура `welcome_message_sequence`

| Поле | Тип | Описание |
|------|-----|---------|
| `text` | string | Текст приветственного сообщения |
| `autofill_message.content` | string | Предзаполненный текст, который пользователь отправит нажав на рекламу |
| `ice_breakers` | array | Кнопки быстрых ответов (до 3 штук). Только `title` |

---

## Обновление цепочки

Тот же `POST`-эндпоинт, но с `sequence_id`:

```bash
curl -X POST \
  -F 'sequence_id="186473890"' \
  -F 'name="Вечеринка — обновлённое название"' \
  "https://graph.facebook.com/v25.0/<WABA_ID>/welcome_message_sequences" \
  -H 'Authorization: Bearer EAAJB...'
```

Ответ: `{ "success": true }`

---

## Получение списка цепочек

```bash
curl -X GET \
  "https://graph.facebook.com/v25.0/<WABA_ID>/welcome_message_sequences" \
  -H 'Authorization: Bearer EAAJB...'
```

Ответ:

```json
[
  {
    "sequence_id": "8716291",
    "name": "Вечеринка пятница",
    "welcome_message_sequence": { ... },
    "is_used_in_ad": true
  },
  {
    "sequence_id": "4362",
    "name": "Гостевой список",
    "welcome_message_sequence": { ... },
    "is_used_in_ad": false
  }
]
```

`is_used_in_ad: true` — цепочка привязана к активной рекламе, удалить нельзя.

## Получение конкретной цепочки

```bash
curl -X GET \
  -F 'sequence_id="6987565"' \
  "https://graph.facebook.com/v25.0/<WABA_ID>/welcome_message_sequences" \
  -H 'Authorization: Bearer EAAJB...'
```

### Query-параметры GET

| Параметр | Тип | Описание |
|----------|-----|---------|
| `sequence_id` | string | ID конкретной цепочки |
| `limit` | integer | Количество цепочек для возврата |

---

## Удаление цепочки

```bash
curl -X DELETE \
  -F 'sequence_id="1234567890"' \
  "https://graph.facebook.com/v25.0/<WABA_ID>/welcome_message_sequences" \
  -H 'Authorization: Bearer EAAJB...'
```

Ответ: `{ "success": true }`

---

## Webhook при переходе из рекламы

Когда пользователь нажимает на Click-to-WhatsApp рекламу — приходит стандартный Webhook входящего сообщения с дополнительным объектом `referral`:

```json
{
  "messages": [{
    "from": "SENDER_PHONE_NUMBER",
    "id": "wamid.ID",
    "timestamp": "TIMESTAMP",
    "type": "text",
    "text": { "body": "Хочу на вечеринку!" },
    "referral": {
      "source_url": "https://fb.com/ads/...",
      "source_id": "<AD_ID>",
      "source_type": "ad",
      "headline": "Заголовок рекламы",
      "body": "Текст рекламы",
      "media_type": "image",
      "image_url": "https://...",
      "ctwa_clid": "<CLICK_ID>",
      "ref": "<REF_ID>"
    }
  }]
}
```

`ctwa_clid` — Click ID для атрибуции конверсий в рекламном кабинете.

---

## Привязка к рекламе через Marketing API

После создания цепочки передать `sequence_id` в рекламный креатив:

```json
{
  "name": "creative",
  "object_story_spec": { ... },
  "asset_feed_spec": {
    "additional_data": {
      "partner_app_welcome_message_flow_id": "<SEQUENCE_ID>"
    }
  }
}
```

---

## Relevance для sema

- Создать цепочку с `ice_breakers`: «Ближайшие вечеринки» / «Попасть в список» / «Цены».
- `autofill_message` — пользователь автоматически отправляет «Хочу на вечеринку!», что запускает агента.
- При входящем Webhook проверять наличие `referral` → сохранять `ctwa_clid` + `source_id` для аналитики рекламы.
- `is_used_in_ad: true` — не трогать цепочку пока реклама активна.
