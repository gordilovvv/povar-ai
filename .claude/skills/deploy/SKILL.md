---
name: deploy
description: Deploy code to sema server via ssh alias friendlybuild (~/povar), rebuild Docker image and restart the service. Use when user asks to deploy, push to server, restart prod, or update server with current changes.
---

# Deploy

Деплой текущей ветки на боевую тачку.

## Шаги

Подключение к серверу — через ssh-алиас `friendlybuild`. Проект на тачке живёт в папке `~/povar`.

1. **Sync кода** на сервер:
   ```bash
   rsync -av --exclude-from=.dockerignore ./ friendlybuild:~/povar
   ```

2. **Build + restart** на тачке:
   ```bash
   ssh friendlybuild 'cd ~/povar && docker compose up -d --build'
   ```

3. **Проверка статуса**:
   ```bash
   ssh friendlybuild 'cd ~/povar && docker compose ps'
   ```

   Сервис `api` должен быть в статусе `Up`, не `Restarting`.

4. **Если что-то рестартует — посмотреть логи**:
   ```bash
   ssh friendlybuild 'cd ~/povar && docker compose logs --no-color --tail 50 api'
   ```

## Заметки

- **Читать `.env` (локальный или удалённый) запрещено** — никаких `cat`, `grep`, `head`, `tail` и т.п. по `.env`. Если контейнер падает с Zod-ошибкой о недостающих переменных — выводи только список имён переменных из логов и проси пользователя дополнить руками.
- `.env` на сервере живёт автономно. При добавлении новых переменных в `environment.ts` нужно дополнить `~/povar/.env` руками — пользователь делает это сам.
- Один сервис `api`, образ `sema-ai:latest`. Порт берётся из `PORT` (на 127.0.0.1).
- Postgres внешний — подключение через `DATABASE_URL`, в compose БД не поднимаем.
