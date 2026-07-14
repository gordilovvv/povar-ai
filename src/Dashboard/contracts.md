# Dashboard — контракты ручек

Дашборд read-only: Сема видит переписки, вечеринки и guest-листы, но не отвечает. Статусы сообщений меняются только через API WhatsApp.

## chatsGetListHandler

Вернуть список чатов с превью последнего сообщения.

```
GET /chats
query: limit, cursor
sort:  lastMessageAt desc
item:  { phone, userName, lastMessageText, lastMessageAt }[]
```

## chatGetHandler

Вернуть конкретный чат.

```
GET /chats/:phone
{ phone, userName, lastMessageAt, lastUserMessageAt, lastBotMessageAt }
```

## chatGetMessagesHandler

Вернуть сообщения в чате.

```
GET /chats/:phone/messages
query: limit, cursor
item:  { id, text, owner: 'user' | 'bot', status, sentAt }[]
```

## partiesGetList

Вернуть вечеринки с числом гостей.

```
GET /parties
query: limit, cursor
sort:  по времени — активная → будущие → прошедшие
item:  { id, name, location, startsAt, guestCount }[]
```

## partyGetGuestlistList

Вернуть guest-лист вечеринки для markdown-рендера.

```
GET /parties/:id/guestlist
{ firstName, lastName, instagram }[]
```
