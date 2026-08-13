# Dashboard — контракты ручек

Дашборд read-only: Сема видит переписки, вечеринки и guest-листы, но не отвечает. Статусы сообщений меняются только через API WhatsApp.

Аутентификация без базы: единственный админ задан в `environment.ts` (телефон + хэш пароля). Пароль в коде не хранится и не расшифровывается — только сравнение с хэшем. Refresh-токены живут в памяти процесса (перезапуск инвалидирует все сессии).

## authLoginHandler [x]

Логин по номеру и паролю. Пароль сверяется с хэшем из env, при успехе выдаётся пара токенов.

```
POST /auth/login
body: { phone, password }
200:  { accessToken, refreshToken }
401:  неверный phone или password
```

## authRefreshHandler [x]

Обновить access-токен по refresh-токену. Валидный refresh должен присутствовать на диске и сохряняться между рестартам (для этого отдельная либа чтобы при переезде на базку легко заменили в классе либки хранилище на базку, класс AuthStorage что-то такое) процесса; ротация — старый инвалидируется, выдаётся новый.

```
POST /auth/refresh
body: { refreshToken }
200:  { accessToken, refreshToken }
401:  неизвестный или истёкший refreshToken
```

## chatsGetListHandler [x]

Вернуть список чатов с превью последнего сообщения.

```
GET /chats
query: limit, cursor
sort:  lastMessageAt desc
item:  { phone, userName, lastMessageText, lastMessageAt }[]
```

## chatGetHandler [x]

Вернуть конкретный чат.

```
GET /chats/:phone
{ phone, userName, lastMessageAt, lastUserMessageAt, lastBotMessageAt }
```

## chatGetMessagesHandler [x]

Вернуть сообщения в чате.

```
GET /chats/:phone/messages
query: limit, cursor
item:  { id, text, owner: 'user' | 'bot', status, sentAt, mediaType, mediaId }[]
```

## chatSendPhotoHandler [x]

Отправить в чат одно фото. В `wa_messages` ложится строка с `media_type='image'`, `media_id` из WA-загрузки и `text` = подпись или null. Одно фото за запрос: в Cloud API одно сообщение = один медиа-файл.

```
POST /chats/:phone/photo
content-type: multipart/form-data
form:  photo: File (image/jpeg|png|webp, ≤5 МБ)
       caption: string (опционально, ≤1024 символа)
200:   { mediaId }
400:   не multipart / нет файла / не image / >5 МБ / кривая подпись
404:   чат не найден
```

## mediaGetHandler [x]

Отдать байты медиа по `media_id` — прокси к WhatsApp на серверном токене, чтобы админка рендерила фото. Отдаётся только медиа, засветившееся в `wa_messages`.

```
GET /media/:id
200:  бинарь, content-type из WhatsApp
404:  media_id не встречается в переписке либо истёк на стороне WhatsApp
```

## partiesGetList [x]

Вернуть вечеринки с числом гостей.

```
GET /parties
query: limit, cursor
sort:  по времени — активная → будущие → прошедшие
item:  { id, name, location, startsAt, guestCount }[]
```

## partyGetGuestlistList [x]

Вернуть guest-лист вечеринки для markdown-рендера.

```
GET /parties/:id/guestlist
{ firstName, lastName, instagram }[]
```
