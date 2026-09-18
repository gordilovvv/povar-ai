---
name: marketing
description: Запуск WhatsApp-рассылки приглашений на вечеринку — афиша/видео в S3, marketing_message, команда StartMarketing. Обязательно используй этот скилл, когда пользователь просит запустить рассылку, дать команду для рассылки, объяснить как запустить рассылку или подготовить афишу к рассылке. Триггерится на «запусти рассылку», «команда для рассылки», «как запустить рассылку», «разошли приглашения».
---

# Рассылка приглашений

Скрипты — в `marketing/`, файлы с номерами (база рассылки) — в `marketing/db/`, чекпоинты и списки — в `marketing/tmp/`. Порядок строгий: медиа в S3 → `marketing_message` → запуск.

1. Залить афишу или видео (`.jpg/.png/.webp/.mp4`), печатает `s3://<key>`:
   `pnpm exec tsx --conditions=development --env-file=.env.prod scripts/UploadToS3.ts <полный-путь>`
2. Записать `party.marketing_message` — jsonb `{ "image": "s3://<key>", "message": "<подпись>" }`, либо `"video"` вместо `"image"` (ровно одно). Это не шаблон рассылки (в нём только дата и площадка из `party`), а медиа с подписью, которое гость получает по кнопке Info. Без него скрипт не стартует.
3. (Опционально) номера из WhatsApp-группы: chrome-devtools → WhatsApp Web → группа → «Поиск участников», затем
   `pnpm exec tsx --conditions=development marketing/ExportGroupMembers.ts marketing/db/whatsapp-group.txt`
   Строка: `<номер>\t<имя>`; контакты без видимого номера пропускаются.
4. Запуск — `party_id`, дальше **всегда все файлы из `marketing/db/`** (дубли с базой скрипт убирает сам):
   `pnpm exec tsx --conditions=development --env-file=.env.prod marketing/StartMarketing.ts <party_id> marketing/db/*.txt`

Скрипт: аудитория = гости с consent не в гест-листе этой party + файлы (без дублей); одним запросом помечает пропуски (нет consent, в гест-листе, пауза, писал <24ч, уже в чекпоинте), пишет список с причинами в `marketing/tmp/<party_id>.list.txt`, шлёт шаблон `party_invite` только после ввода `yes`. Лимит 2000 получателей/24ч. Прогресс — `marketing/tmp/<party_id>.state`, повторный запуск продолжает, не дублирует. Кнопку Info и `stop` обрабатывает `src/Marketing.ts` (`wa_marketing_sends`).

Перед запуском проверь по базе, что `marketing_message` заполнен, и покажи пользователю команду — сам скрипт запускает он (интерактивный `yes`).
