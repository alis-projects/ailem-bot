# Runbook: server-priced, session-bound checkout (PR #6)

The release has two parts, applied in this order:

1. **App release.** It adds `POST /api/orders`, which prices orders on the server and inserts them with the service role. It also adds the customer session cookie issued by `/api/auth/telegram-login`.
2. **DB migration** `supabase-migrations/secure-orders-writes.sql`. It removes all direct writes to `orders` with the public anon key.

**Order matters: deploy first, migrate second.** Images built before this release insert orders as anon. Once the migration is applied, checkout on those images fails with `42501`.

**Rules for the whole runbook:**
- Never print, paste or echo a secret value.
- Never re-grant anon writes on `orders` to "fix" checkout.

---

## 0. Before merging

### 0.1 Add the customer session secret to the server

`deploy.yml` aborts if this secret is missing, and the running container is left untouched. Generate and store it without displaying it:

```bash
ssh deploy@<IP>
```

```bash
cd /opt/ailem && cp -p .env .env.bak-$(date +%Y%m%d-%H%M) && printf '\nCUSTOMER_SESSION_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env && grep -c '^CUSTOMER_SESSION_SECRET=.\{32,\}' .env
```

The last command must print `1`. Do not restart anything yet. The old image ignores the variable.

Then refresh the encrypted off-server backup of `.env`, as described in `~/ailem-backups/*-env/RESTORE.md`. The old copy no longer matches the server.

### 0.2 Take a fresh DB backup and record the current image

Take the backup the same way as A7: data plus supplements, with a restore test.

Record the running image tag:

```bash
grep IMAGE_TAG /opt/ailem/.deploy.env
```

For example, `sha-2127f5c`. **This tag is a valid code rollback target only until step 3.** After the migration it can no longer create orders.

## 1. Merge and deploy

1. Merge PR #6. deploy.yml builds the image and deploys it.
2. Check that the run succeeded:

   ```bash
   gh run list --workflow=deploy.yml --limit 1
   ```

3. Check the running image on the server:

   ```bash
   cd /opt/ailem && grep IMAGE_TAG .deploy.env && docker compose --env-file .deploy.env ps
   ```

   The tag must be the merge commit and the container must be `healthy`.

4. Check the configuration health. It reports presence only, never values:

   ```bash
   curl -s https://www.ailem.uz/api/orders
   ```

   It must return `{"ok":true,"serviceRole":true,"sessionSecret":true}`.

## 2. Smoke test before the migration

Nothing is written in this step.

- **Quote only.** Open the site as a guest, add a visible product, go through checkout to the payment page, and **do not pay**. The payment page must show the amount computed by the server.
- **Signed-in customer.** Sign in with Telegram, go to the payment page, and **do not pay**. The amount must include the customer's own bonus if "use bonus" was ticked.
- **Customers who were signed in before this release** have no session cookie yet. At the payment step they see *"Sessiya muddati tugagan…"* with a **Telegram orqali kirish** button. One sign-in fixes it. This is expected, so let support know.

## 3. Apply the migration

Run `supabase-migrations/secure-orders-writes.sql` in the Supabase SQL Editor. The file is idempotent and runs as one transaction.

Run the post-check, which is read-only:

```sql
SELECT relrowsecurity FROM pg_class WHERE oid = 'public.orders'::regclass;              -- true
SELECT policyname, roles, cmd FROM pg_policies WHERE tablename = 'orders' ORDER BY 1;   -- 4 rows, all {authenticated}, is_admin()
SELECT has_table_privilege('anon','public.orders','INSERT'),
       has_table_privilege('anon','public.orders','UPDATE'),
       has_table_privilege('anon','public.orders','DELETE');                            -- f, f, f
```

## 4. After the migration

1. **Anon probe.** A write with the public key must fail with `42501`. Use a deliberately invalid row so that nothing can be stored even if the check fails:

   ```bash
   curl -s -X POST "$SUPABASE_URL/rest/v1/orders" -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
     -H 'Content-Type: application/json' -d '{"id":"probe"}'
   ```

   The response must contain `"code":"42501"`.

2. **Health.** Run `curl -s https://www.ailem.uz/api/orders` again. It must return `ok:true`.
3. **Checkout.** Run the guest and signed-in quote checks from step 2 again.
4. **Admin panel.** Open «Buyurtmalar». The orders list must load, and a status change on a test or pending order must work. Admins write as `authenticated` + `is_admin()`.
5. **Payme.** Optionally make one small real payment. Then check the order: `approved`, `fulfilled_at` set, stock reduced once, bonus credited once.

---

## Recovery: checkout fails after the migration

**Keep the write ban on `orders`.** Do **not** re-grant anon `INSERT`/`UPDATE`, and do **not** drop the policies. Do **not** roll the app back to an image from before this release: those images insert as anon and are blocked. Fix forward.

### Symptoms and fixes

| Symptom | Cause | Fix |
|---|---|---|
| `GET /api/orders` → `serviceRole:false` | `SUPABASE_SERVICE_ROLE_KEY` or `NEXT_PUBLIC_SUPABASE_URL` missing in the container | Add it to `/opt/ailem/.env`, then recreate the container (see below) |
| `GET /api/orders` → `sessionSecret:false`; signed-in customers get `SESSION_REQUIRED` | `CUSTOMER_SESSION_SECRET` missing or shorter than 32 characters | Fix it as in step 0.1, then recreate the container. Guests are not affected meanwhile. Signed-in customers can still order as guests, without bonus |
| Many customers suddenly get `SESSION_REQUIRED` | The secret was changed. All sessions are now invalid | Expected after a change. Customers sign in again. Do not change the secret back and forth |
| Payment page shows "Buyurtmani hisoblab bo'lmadi" or "saqlab bo'lmadi"; logs show `orders: pricing failed` / `orders: insert failed` | DB or network error, or a broken key | Read the logs (see below). If the service role key is wrong, every server route fails: fix `.env`. If the cause is a constraint or column error, fix forward with a migration, never by re-opening anon writes |
| `42501` in the browser console on checkout | The running image predates this release (rolled back, or deploy not finished) | Redeploy the release image (see below) or re-run the deploy workflow |
| Bug in `/api/orders` code | — | Hotfix commit → push to `main` → deploy. While waiting, re-deploying the same release image is safe |

### Commands

All commands run on the server. None of them prints a value.

```bash
cd /opt/ailem
```

```bash
docker compose --env-file .deploy.env logs --since 30m app | grep -E 'orders:|CUSTOMER_SESSION_SECRET'
```

```bash
for v in SUPABASE_SERVICE_ROLE_KEY CUSTOMER_SESSION_SECRET TELEGRAM_BOT_TOKEN; do printf '%s ' "$v"; grep -c "^$v=." .env; done
```

```bash
docker compose --env-file .deploy.env up -d --force-recreate app
```

Re-deploy a specific release image, for example the release merge commit:

```bash
sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG=sha-<release>/' .deploy.env && docker compose --env-file .deploy.env pull app && docker compose --env-file .deploy.env up -d app
```

### What keeps working during an incident

- **Payme and Click webhooks** use the service role, so payments for orders that already exist keep confirming.
- **The admin panel** keeps working: listing orders and changing status.
- **Order history and payment status pages** use SECURITY DEFINER RPCs and are unaffected.
