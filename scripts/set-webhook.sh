#!/usr/bin/env bash
#
# Register the webhook with Telegram, then verify it took.
#
# The secret token is the only thing standing between the Worker and the open
# internet (design section 7), so it is required, not optional.
#
# Usage:
#   BOT_TOKEN=... WEBHOOK_SECRET=... ./scripts/set-webhook.sh https://practice-tracker.<you>.workers.dev/webhook
#
# Nothing here is echoed back: the token would end up in your shell history and
# in any captured output.

set -euo pipefail

URL="${1:-}"

if [[ -z "$URL" ]]; then
  echo "usage: $0 <https://.../webhook>" >&2
  exit 64
fi
if [[ -z "${BOT_TOKEN:-}" ]]; then
  echo "BOT_TOKEN is not set" >&2
  exit 64
fi
if [[ -z "${WEBHOOK_SECRET:-}" ]]; then
  echo "WEBHOOK_SECRET is not set" >&2
  exit 64
fi
if [[ "$URL" != https://* ]]; then
  echo "webhook URL must be https" >&2
  exit 64
fi

API="https://api.telegram.org/bot${BOT_TOKEN}"

echo "registering webhook..."
curl -sS -X POST "${API}/setWebhook" \
  --data-urlencode "url=${URL}" \
  --data-urlencode "secret_token=${WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message","callback_query"]' \
  --data "drop_pending_updates=true" \
  | python3 -c 'import json,sys; r=json.load(sys.stdin); print("  ok:", r.get("ok"), "-", r.get("description"))'

echo
echo "verifying (want pending_update_count 0 and no last_error_message):"
curl -sS "${API}/getWebhookInfo" | python3 -c '
import json, sys
r = json.load(sys.stdin).get("result", {})
for k in ("url", "has_custom_certificate", "pending_update_count",
          "ip_address", "last_error_date", "last_error_message",
          "max_connections", "allowed_updates"):
    if k in r:
        print(f"  {k}: {r[k]}")
if r.get("last_error_message"):
    print("\n  WARNING: Telegram reported an error delivering to this URL.")
'

echo
echo "Set the same secret on the Worker if you have not already:"
echo "  npx wrangler secret put WEBHOOK_SECRET"
