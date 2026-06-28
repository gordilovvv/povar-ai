#!/usr/bin/env bash
# Запросы к dev-БД через DATABASE_URL из .env.dev.
#   ./scripts/db-dev.sh "SELECT id FROM guests LIMIT 5"   # выполнить SQL
#   ./scripts/db-dev.sh                                   # интерактивный psql
# Креды не печатаются (set +x). Вывод запроса идёт как есть — не селекти секреты.

set -euo pipefail
set +x  # не дать xtrace распечатать DATABASE_URL/результаты

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env.dev"

[ -f "$ENV_FILE" ] || { echo "✗ $ENV_FILE not found" >&2; exit 1; }

DB_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//")"
[ -n "$DB_URL" ] || { echo "✗ DATABASE_URL отсутствует в $ENV_FILE" >&2; exit 1; }

if [ "$#" -eq 0 ]; then
    exec psql "$DB_URL"
fi

exec psql "$DB_URL" -c "$1"
