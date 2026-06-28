# WhatsApp Message History API — справочник

## Base URL

```
https://graph.facebook.com
```

---

## GET /{Version}/{Message-History-ID}/events

Получить историю событий доставки для конкретного сообщения.

### Path Parameters

| Параметр | Обязательный | Описание |
|----------|:---:|---------|
| `Version` | ✓ | Версия Graph API (например, `v25.0`) |
| `Message-History-ID` | ✓ | ID записи в истории сообщений |

### Query Parameters

| Параметр | Тип | Описание |
|----------|-----|---------|
| `delivery_status` | enum | Фильтр по статусу: `ACCEPTED` / `SENT` / `DELIVERED` / `READ` / `ERROR` |
| `fields` | string | Поля через запятую (см. ниже) |
| `limit` | integer 1–100 | Записей на страницу. По умолчанию 25 |
| `after` | string | Курсор для следующей страницы |
| `before` | string | Курсор для предыдущей страницы |

**Доступные `fields`:**
`cursor`, `node{id,delivery_status,error_description,occurrence_timestamp,status_timestamp,application,webhook_update_state,webhook_uri}`

### Пример запроса

```bash
curl 'https://graph.facebook.com/v25.0/<Message-History-ID>/events?delivery_status=ERROR&limit=25' \
  -H 'Authorization: Bearer EAAJB...'
```

### Ответ 200

```json
{
  "data": [
    {
      "cursor": "QVFIUk...",
      "node": {
        "id": "event_123",
        "delivery_status": "DELIVERED",
        "occurrence_timestamp": 1750030073,
        "status_timestamp": 1750030075,
        "webhook_update_state": "SUCCESS",
        "webhook_uri": "https://myserver.com/whatsapp/webhooks",
        "application": {
          "id": "app_456",
          "name": "Sema Party Bot"
        }
      }
    }
  ],
  "paging": {
    "cursors": {
      "before": "QVFIUkJh...",
      "after": "QVFIUm9n..."
    },
    "previous": "https://graph.facebook.com/...",
    "next": "https://graph.facebook.com/..."
  }
}
```

---

## Схемы

### `WhatsAppBusinessMessageDeliveryStatusOccurrence`

| Поле | Тип | Обязательное | Описание |
|------|-----|:---:|---------|
| `id` | string | ✓ | ID события доставки |
| `delivery_status` | enum | ✓ | `ACCEPTED` / `SENT` / `DELIVERED` / `READ` / `ERROR` |
| `occurrence_timestamp` | int64 | ✓ | Unix-время наступления события |
| `status_timestamp` | int64 | | Unix-время записи статуса |
| `error_description` | string | | Описание ошибки (только при `ERROR`) |
| `webhook_update_state` | `SUCCESS` \| `ERROR` | | Успешно ли Webhook получил событие |
| `webhook_uri` | string | | URL Webhook, получившего событие |
| `application.id` | string | | ID Meta-приложения |
| `application.name` | string | | Имя Meta-приложения |

### Статусы `WhatsAppMessageDeliveryStatus`

| Значение | Описание |
|----------|---------|
| `ACCEPTED` | Принято сервером WhatsApp |
| `SENT` | Отправлено с сервера |
| `DELIVERED` | Доставлено на устройство |
| `READ` | Прочитано пользователем |
| `ERROR` | Ошибка доставки |

---

## Пагинация

Курсорная пагинация — `paging.cursors.after` передавать в параметр `after` следующего запроса:

```typescript
async function getAllEvents(historyId: string) {
  const events = [];
  let after: string | undefined;

  do {
    const params = new URLSearchParams({ limit: '100' });
    if (after) params.set('after', after);

    const res = await fetch(
      `https://graph.facebook.com/v25.0/${historyId}/events?${params}`,
      { headers: { Authorization: `Bearer ${TOKEN}` } }
    );
    const json = await res.json();
    events.push(...json.data.map(e => e.node));
    after = json.paging?.cursors?.after;
  } while (after);

  return events;
}
```

---

## Коды ошибок

| HTTP | `code` | Описание |
|------|--------|---------|
| 400 | 100 | Неверный параметр (например, невалидный `delivery_status`) |
| 401 | 190 | Недействительный токен |
| 403 | 200 | Нет прав доступа к истории |
| 404 | 803 | История сообщений не найдена |
| 422 | 100 | Запрошенные поля недоступны |
| 500 | 2 | Временная ошибка (`is_transient: true` — повторить с backoff) |

---

## Relevance для sema

- Использовать для отладки: если шаблонное напоминание не дошло — смотреть `delivery_status: ERROR` + `error_description`.
- `webhook_update_state: "ERROR"` означает, что наш сервер не ответил `200` на Webhook — нужно проверить логи.
- Для мониторинга качества доставки: доля `DELIVERED` / `READ` от `SENT`.
