---
name: deploy
description: Deploy code to sema server via ssh alias fdev (~/povar), rebuild Docker image and restart the service. Use when user asks to deploy, push to server, restart prod, or update server with current changes.
---

# Deploy

Деплой текущей ветки на боевую тачку.

## Шаги

Подключение к серверу — через ssh-алиас `fdev`. Проект на тачке живёт в папке `~/povar`.

1. **Поднять версию** в `package.json` (patch: `0.0.2` → `0.0.3`). Каждый деплой = новая версия, она же тег образа. Дальше `<version>` — это значение из `package.json`.

2. **Sync кода** на сервер (`docker-compose.yml` в `.dockerignore`, его докидываем отдельно):
   ```bash
   rsync -av --exclude-from=.dockerignore ./ fdev:~/povar
   scp docker-compose.yml fdev:~/povar/docker-compose.yml
   ```

3. **Build с тегом версии + restart** на тачке (`docker compose up --build` НЕ работает — в compose нет секции `build`, образ собираем руками):
   ```bash
   ssh fdev 'cd ~/povar && docker build -t sema-ai:<version> . && VERSION=<version> docker compose up -d'
   ```

4. **Проверка статуса**:
   ```bash
   ssh fdev 'cd ~/povar && docker compose ps'
   ```

   Сервисы `api` и `worker` должны быть в статусе `Up`, не `Restarting`. Убедиться, что контейнеры пересозданы и крутят свежий тег (`docker compose ps` показывает image).

5. **Если что-то рестартует — посмотреть логи**:
   ```bash
   ssh fdev 'cd ~/povar && docker compose logs --no-color --tail 50 api worker'
   ```

## Заметки

- **Читать `.env` (локальный или удалённый) запрещено** — никаких `cat`, `grep`, `head`, `tail` и т.п. по `.env`. Если контейнер падает с Zod-ошибкой о недостающих переменных — выводи только список имён переменных из логов и проси пользователя дополнить руками.
- `.env` на сервере живёт автономно. При добавлении новых переменных в `environment.ts` нужно дополнить `~/povar/.env` руками — пользователь делает это сам.
- Два сервиса из одного образа `sema-ai:<version>`: `api` (webhook, порт из `PORT` на 127.0.0.1) и `worker`. Версию compose берёт из `VERSION` (`image: sema-ai:${VERSION:-latest}`), поэтому `VERSION=<version>` обязателен при `up`.
- Postgres внешний — подключение через `DATABASE_URL`, в compose БД не поднимаем.
