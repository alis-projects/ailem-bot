# Runbook: rotate the Telegram bot token (@ailemuzbot)

**Why:** until this change the bot token shipped to every visitor's browser, in two ways:
1. The GitHub secret `NEXT_PUBLIC_TELEGRAM_BOT_TOKEN` was passed as a Docker build arg. That put it in the public JS bundle of every image.
2. `public/test-notification.html` had a token hardcoded in plain HTML. It was served at `https://www.ailem.uz/test-notification.html`. The same token value was also written into `docs/` and is still in git history.

This PR removes both, but the old token must be treated as public. **Revoking it in BotFather is the only real fix.** It also makes the copies in git history, in old GHCR images and in any browser cache worthless.

**Rule throughout: never print, paste or echo a token value.** Edit the `.env` file in an editor. Commands below read the token from the file into a shell variable.

---

## 0. Before merging: make sure the server has the server-only var

The server routes (Payme/Click webhooks, support chat, invoices) used to fall back to the `NEXT_PUBLIC_` value that was baked in at build time. That fallback is gone. On the server:

```bash
ssh deploy@<IP>
```

```bash
grep -c '^TELEGRAM_BOT_TOKEN=.\+' /opt/ailem/.env
```

It must print `1`. If it prints `0`, add `TELEGRAM_BOT_TOKEN=<current token>` with `nano /opt/ailem/.env` (for now, the current token is fine), then go on.

## 1. Merge the PR and let it deploy

Merge the PR into `main`, which triggers deploy.yml. Then check that the run succeeded:

```bash
gh run list --repo alis-projects/ailem-bot --workflow=deploy.yml --limit 1
```

The new image no longer contains a token. The admin panel now sends through `POST /api/telegram/send`, which only signed-in admins can call.

## 2. Revoke and regenerate the token in BotFather (you do this)

In Telegram, open **@BotFather**. Send `/mybots`, choose **@ailemuzbot**, then **API Token** and **Revoke current token**. Copy the new token straight into step 3. Do not paste it anywhere else.

From this point until step 3 is done, the bot can't send anything (that should take a few minutes).

## 3. Put the new token on the server

```bash
nano /opt/ailem/.env
```

- Set `TELEGRAM_BOT_TOKEN=<new token>`
- **Delete** any `NEXT_PUBLIC_TELEGRAM_BOT_TOKEN=` and `VITE_TELEGRAM_BOT_TOKEN=` lines (older copies of deploy/README.md told you to add them)

```bash
chmod 600 /opt/ailem/.env
```

```bash
cd /opt/ailem && docker compose up -d --force-recreate app
```

(Runtime env is read when the container starts, so no rebuild is needed.)

## 4. Delete the GitHub secret

```bash
gh secret delete NEXT_PUBLIC_TELEGRAM_BOT_TOKEN --repo alis-projects/ailem-bot
```

Or: repo **Settings → Secrets and variables → Actions → `NEXT_PUBLIC_TELEGRAM_BOT_TOKEN` → Remove**. If you get the order wrong, nothing breaks, because deploy.yml no longer reads this secret.

## 5. Re-register the support-chat webhook

A new token has no webhook. Run this on the server; it reads the token from `.env` without printing it:

```bash
cd /opt/ailem && TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' .env | cut -d= -f2-) && SECRET=$(grep '^TELEGRAM_WEBHOOK_SECRET=' .env | cut -d= -f2-); curl -s "https://api.telegram.org/bot${TOKEN}/setWebhook" --data-urlencode "url=https://www.ailem.uz/api/support/webhook" ${SECRET:+--data-urlencode "secret_token=${SECRET}"}; echo; unset TOKEN SECRET
```

Expected: `{"ok":true,"result":true,"description":"Webhook was set"}`.

If `TELEGRAM_WEBHOOK_SECRET` is set in `.env`, the route rejects updates that don't carry it. The command above passes it along automatically.

Check it:

```bash
cd /opt/ailem && TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' .env | cut -d= -f2-); curl -s "https://api.telegram.org/bot${TOKEN}/getWebhookInfo"; echo; unset TOKEN
```

`url` must be `https://www.ailem.uz/api/support/webhook`, and there must be no recent `last_error_message`.

## 6. Verify

1. **Support chat:** on www.ailem.uz, open the chat button and send a message. It arrives in the admin Telegram chat. Reply to it in Telegram, and the reply shows up in the website chat within a few seconds.
2. **Admin Telegram send:** in `/admin` → Products, use "send to Telegram" on a product with your own chat ID. Or use the low-stock summary in Inventory settings. The message arrives. Nobody's money moves in either test.
3. **No token in the bundle or in public files.** This prints only a count:
   ```bash
   docker exec ailem-app sh -c "grep -rlE '[0-9]{8,10}:[A-Za-z0-9_-]{30,}' /app/.next/static /app/public | wc -l"
   ```
   It must print `0`.
4. **Debug page gone:**
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://www.ailem.uz/test-notification.html
   ```
   It must not print `200`. Also check `check-bot-config.html` and `setup-bot-notifications.html`.
5. **Old token is dead (optional).** BotFather confirms the revoke. If you still have the old token, `getMe` with it returns `401 Unauthorized`.

## Rollback notes

- A code rollback to an older image (`sha-ff59b4b`, `sha-6b515aa`) is still possible. Those images contain the **old, revoked** token, which is now harmless. But their admin panel sent to Telegram from the browser with that token, so **admin Telegram notifications won't work on those images**. Server-side notifications (Payme/Click webhooks, support chat) keep working, because they read `TELEGRAM_BOT_TOKEN` from `.env`.
- Never "fix" a rollback by un-revoking or re-adding `NEXT_PUBLIC_TELEGRAM_BOT_TOKEN`.
