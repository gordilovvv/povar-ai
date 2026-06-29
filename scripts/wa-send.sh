#!/usr/bin/env bash
# Симуляция входящего WhatsApp-сообщения: собирает webhook-payload Meta,
# подписывает его WA_SECRET из .env.dev и шлёт POST на локальный /webhook.
#   ./scripts/wa-send.sh "+9715xxxxxxx" "хочу на вечеринку в пятницу"
#   ./scripts/wa-send.sh "+9715xxxxxxx" "пришёл с рекламы" --ad   # с referral (came_from=ad)
# Секрет не печатается (set +x). PORT и WA_SECRET берутся из .env.dev.

set -euo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env.dev"

[ -f "$ENV_FILE" ] || { echo "✗ $ENV_FILE not found" >&2; exit 1; }

read_env() { grep -E "^$1=" "$ENV_FILE" | head -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//"; }

SECRET="$(read_env WA_SECRET)"
PORT="$(read_env PORT)"
[ -n "$SECRET" ] || { echo "✗ WA_SECRET отсутствует в $ENV_FILE" >&2; exit 1; }
[ -n "$PORT" ] || PORT=3000

FROM="${1:-}"
TEXT="${2:-}"
[ -n "$FROM" ] && [ -n "$TEXT" ] || { echo "usage: $0 <from-phone> <text> [--ad]" >&2; exit 1; }

REFERRAL=""
[ "${3:-}" = "--ad" ] && REFERRAL=',"referral":{"source_id":"test-ad"}'

MID="wamid.test.$(date +%s%N)"

# raw-тело, которое подписываем и шлём, должно совпадать байт-в-байт
BODY=$(printf '{"entry":[{"changes":[{"value":{"messages":[{"id":"%s","from":"%s","type":"text","text":{"body":%s}%s}]}}]}]}' \
    "$MID" "$FROM" "$(printf '%s' "$TEXT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" "$REFERRAL")

SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')"

curl -sS -X POST "http://localhost:$PORT/webhook" \
    -H 'content-type: application/json' \
    -H "x-hub-signature-256: $SIG" \
    --data "$BODY" -w '\n→ http %{http_code}\n'
