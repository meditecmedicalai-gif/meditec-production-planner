# Meditec Pump Room Production Planner

A weekly production planner for the Meditec Medical Ltd pump room.

- **Frontend:** static site (Vite + plain JavaScript) hosted on GitHub Pages
- **Data & login:** Supabase (Postgres + Auth), free tier
- **Security:** the site only contains Supabase's public *anon* key. All permissions are
  enforced in the database with Row Level Security (RLS), so the repository can be public.

| Role | Can do |
|---|---|
| **admin** | Everything: schedule, people, absences, pump models, tasks, working hours, demand notes (incl. delete), change history |
| **viewer** | View everything except change history. Create demand notes and edit their **own** notes (incl. marking them Done). Cannot delete. |

Live site (once deployed): `https://meditecmedicalai-gif.github.io/meditec-production-planner/`

---

## Setup, step by step

### 1. Create the Supabase project
1. Sign in at <https://supabase.com> → **New project**.
2. Name it e.g. `meditec-planner`, choose a strong database password (store it in your
   password manager; the app never needs it) and region **West EU (London)**.
3. Wait for the project to finish starting.

### 2. Create the database
1. In Supabase go to **SQL Editor → New query**.
2. Paste the whole of [`supabase/migrations/001_init.sql`](supabase/migrations/001_init.sql) and click **Run**.
   It creates all tables, security policies, the change log triggers, and seeds the pump models,
   tasks and working hours. It is safe to run again.

### 3. Lock down sign-in
1. **Authentication → Sign In / Providers** (called *Providers* in some versions):
   - Turn **off** "Allow new users to sign up".
   - Keep **Email** enabled.
   - Turn **off** "Confirm email" (you create accounts yourself, so no confirmation e-mail is needed).
2. **Authentication → URL Configuration**: set **Site URL** to
   `https://meditecmedicalai-gif.github.io/meditec-production-planner/`.

### 4. Create the user accounts
For each person (you and Elaine):
1. **Authentication → Users → Add user → Create new user**.
2. Enter their e-mail and a temporary password, tick **Auto Confirm User**, click **Create user**.
3. Give them the password privately; they can change it in the app under **My account**.

Everyone starts as a **viewer**. Make yourself admin and set display names in the SQL Editor
(change the e-mails):

```sql
update public.profiles set app_role = 'admin', full_name = 'Prince' where email = 'prince@example.com';
update public.profiles set full_name = 'Elaine' where email = 'elaine@example.com';
```

To disable someone's access later without deleting them:

```sql
update public.profiles set active = false where email = 'someone@example.com';
```

To reset a forgotten password: **Authentication → Users → … → Reset password** sends an e-mail, but
the free tier's built-in e-mail only reaches members of your Supabase organisation. The reliable
option is to delete the user and create them again with a new temporary password (their profile
is recreated automatically; set their name/role again with the SQL above).

### 5. Check the security (optional, recommended)
Open [`supabase/tests/rls_check.sql`](supabase/tests/rls_check.sql), replace `VIEWER_EMAIL_HERE`
and `ADMIN_EMAIL_HERE` with the two e-mails, paste it into the SQL Editor and run it.
Every row in the result should say **PASS**. It rolls everything back, so no test data is kept.

### 6. Connect GitHub Pages
1. In Supabase, open **Project Settings → API** (or **Data API / API Keys**) and copy:
   - the **Project URL** (`https://xxxx.supabase.co`)
   - the **anon public** key. **Never** use the `service_role` key anywhere in this project.
2. In GitHub open the repository → **Settings → Secrets and variables → Actions → Variables** tab →
   **New repository variable**, and add:
   - `VITE_SUPABASE_URL` = the Project URL
   - `VITE_SUPABASE_ANON_KEY` = the anon public key
3. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. Merge the pull request into `main` (or open **Actions → Deploy to GitHub Pages → Run workflow**).
   After a minute or two the site is live at the URL above.

### 7. Sign in
Open the site, sign in with the account from step 4 and check that:
- the header shows your name, the **admin** badge and the working hours (08:30–16:30);
- the Planner page lists 8 pump models and 9 tasks;
- Elaine's account shows the **viewer** badge and no Settings link.

---

## Updating the database

Migrations live in `supabase/migrations/` and are numbered. When a pull request adds or changes
one, paste it into the SQL Editor and run it **before** merging. All migrations are written to be
safe to run more than once.

Rules for every migration that adds a table (they prevent the
"permission denied for table …" error and keep the data locked down):
1. `alter table … enable row level security;` plus policies for it.
2. Re-run the grants for the `authenticated` role (newer Supabase projects don't add them automatically):
   ```sql
   grant select, insert, update, delete on all tables in schema public to authenticated;
   grant usage, select on all sequences in schema public to authenticated;
   ```
3. Then re-apply `revoke insert, update, delete, truncate on public.audit_log from authenticated;`.

`supabase/tests/rls_check.sql` checks all of this: it fails if any table is missing RLS or grants.

## Local development (optional)

```bash
cp .env.example .env      # then fill in the two values
npm install
npm run dev
```

## Project layout

```
supabase/migrations/001_init.sql   tables, RLS policies, triggers, seed data
supabase/tests/rls_check.sql       permission self-test (run in SQL Editor)
src/main.js                        app shell, routing, sign-in gate
src/supabase.js                    Supabase client (reads VITE_* config)
src/pages/                         one file per page
.github/workflows/deploy.yml       build + deploy to GitHub Pages on push to main
```

## Change history (audit log)
Every insert, update and delete on **assignments**, **absences** and **demand notes** is recorded
automatically in `audit_log` (who, when, old and new values) by database triggers. Only admins can
read it, and nobody can edit it through the app or API. A History page arrives in Phase 5.
This is a planning aid, not a controlled QMS record.

## Build phases
1. ✅ Database, security & sign-in
2. ✅ People & skills matrix, Settings (pump models, tasks, working hours)
3. Weekly planner (incl. absences)
4. Demand & notes
5. Weekly summary, History view, print view
