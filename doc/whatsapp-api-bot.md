# WhatsApp Business Bot API — справочник

## Base URL

```
https://graph.facebook.com
```

## Аутентификация

```
Authorization: Bearer <ACCESS_TOKEN>
```

---

## GET /{Version}/{WABA-Bot-ID}

Получить конфигурацию WhatsApp Business Bot.

### Path Parameters

| Параметр | Обязательный | Описание |
|----------|:---:|---------|
| `Version` | ✓ | Версия Graph API (например, `v25.0`) |
| `WABA-Bot-ID` | ✓ | ID бота из Business Manager |

### Query Parameters

| Параметр | Описание |
|----------|---------|
| `fields` | Поля через запятую. Доступные: `id`, `prompts`, `commands`, `enable_welcome_message`. По умолчанию возвращаются все четыре. |

### Пример запроса

```bash
curl 'https://graph.facebook.com/v25.0/<WABA-Bot-ID>?fields=id,prompts,commands,enable_welcome_message' \
  -H 'Authorization: Bearer EAAJB...'
```

### Ответ 200

```json
{
  "id": "123456789",
  "prompts": [
    "Привет! Чем могу помочь?",
    "Напиши 'вечеринки', чтобы узнать расписание."
  ],
  "commands": [
    {
      "command_name": "вечеринки",
      "command_description": "Показать список ближайших вечеринок"
    },
    {
      "command_name": "список",
      "command_description": "Проверить, есть ли ты в гостевом списке"
    }
  ],
  "enable_welcome_message": true
}
```

### Схема `WhatsAppBusinessBot`

| Поле | Тип | Обязательное | Описание |
|------|-----|:---:|---------|
| `id` | string | ✓ | ID бота |
| `prompts` | string[] | | Автоматические подсказки / приветственные тексты |
| `commands` | WhatsAppBusinessBotCommand[] | | Список команд бота |
| `enable_welcome_message` | boolean | | Включено ли приветственное сообщение |

### Схема `WhatsAppBusinessBotCommand`

| Поле | Тип | Обязательное | Описание |
|------|-----|:---:|---------|
| `command_name` | string | ✓ | Название команды |
| `command_description` | string | ✓ | Описание команды |

---

## Коды ошибок

| HTTP | `code` | Описание |
|------|--------|---------|
| 400 | 100 | Неверный параметр (`waba_bot_id` должен быть числовой строкой) |
| 401 | 190 | Недействительный OAuth-токен |
| 403 | 200 | Нет прав доступа к боту |
| 404 | 803 | Бот не найден или недоступен |
| 422 | 100 | Запрошенные поля недоступны для этого бота |
| 500 | 2 | Временная ошибка сервера (`is_transient: true` — стоит повторить запрос) |

### Схема ошибки `GraphAPIError`

```json
{
  "error": {
    "message": "Human-readable error message",
    "type": "OAuthException | GraphMethodException",
    "code": 100,
    "error_subcode": 1349174,
    "fbtrace_id": "AXsgnV2Cm3ZMGF3dF_cfYIn",
    "is_transient": false,
    "error_user_title": "Permission Denied",
    "error_user_msg": "Your app doesn't have permission to access this resource"
  }
}
```

| Поле | Описание |
|------|---------|
| `fbtrace_id` | ID для отладки при обращении в поддержку Meta |
| `is_transient` | `true` — ошибка временная, запрос стоит повторить с exponential backoff |
| `error_user_title` / `error_user_msg` | Текст для отображения пользователю |

---

## Заметки

- **Rate limiting:** стандартные лимиты Graph API. При 429 использовать exponential backoff.
- **Кэширование:** конфигурация бота меняется редко, можно кэшировать. Инвалидировать при обновлении настроек бота.
- **Применение в sema:** получить список `commands` и `prompts` при старте сервера → сохранить в памяти агента для формирования системного промпта.
