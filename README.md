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
3. Do the same with each later migration in order: [`002_build_types.sql`](supabase/migrations/002_build_types.sql)
   (build types: Production / Trial / Rental / Customer).

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
and `ADMIN_EMAIL_HERE` (near the top) with the two e-mails, paste it into the SQL Editor and click **Run**.

The result appears as an **error** on purpose: its message starts with
`RLS CHECK FINISHED: N passed, 0 failed` and lists every check (failures first). Stopping with an
error is what undoes all the test data, so nothing is left behind. Every line should start with **PASS**.

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
- the Planner page shows the current week, and Settings lists 8 pump models, 4 build types and 9 tasks;
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

## Using the planner
- **Weekly grid:** people × Mon–Fri. Use ‹ Prev / This week / Next › to move between weeks; the URL
  (`#/planner?week=2026-11-23`) can be bookmarked or shared.
- **+ Add** in a cell adds work: task, pump model, build type, quantity and notes. Tick several days
  to add the same job to each. Click a job to edit, delete or **Duplicate…** it.
- **Absent** marks Holiday / Sick / Training / Off-site for a day or a date range. Click the banner to
  change or remove it.
- **⚠** on a job means the person is not trained on that pump model or is absent that day. You are
  asked to confirm before saving such a job, but it is allowed (e.g. supervised training).
- **Copy last week** copies last week's jobs to the same weekdays, skipping days where the person is
  absent and anything inactive.
- **Build types** (Settings) tag each pump job, e.g. Production, Trial, Rental, Customer, each with its
  own colour. The default type (Production) is pre-selected and is used automatically if a pump job is
  saved without one. Tasks that don't need a pump (Training, Stock room / 5S, Other) can have no type.
- **On a phone** the planner shows one day at a time with day tabs.

## Demand & Notes
- Anyone can post a note: pump model (or a general note), build type, quantity, needed-by date,
  priority, comment and status (**Open** = not yet planned, **Planned** = in the schedule,
  **Done** = delivered / no longer needed).
- Viewers can edit and change the status of **their own** notes; the admin can edit any note and is the
  only one who can delete. Each note shows who posted it and who last edited it.
- Filter by status, pump model, build type, priority or "only my notes". Filters are remembered on
  that device.
- The **Planner** shows an "Open demand" panel (open + planned notes, overdue first) above the grid, with
  counts of overdue items and items due in the displayed week. Click a note to open it; the panel can be
  collapsed.

## Weekly summary
Shown below the planner grid (or jump to it with **Summary ↓**), for the week being displayed:

| Column | Meaning |
|---|---|
| **Planned** | Quantity targets this week (Mon–Fri) for tasks marked *Counts as output* in Settings (normally Final assembly). Tick **Count all pump tasks** to include every pump task instead. |
| **Demand due** | Open + planned demand notes for that model and build type due by Friday of that week, **including overdue**. |
| **Gap** | Planned − Demand due. Red = short, green = covered. |
| **Later / no date** | Open + planned demand due after that week or with no date (for information; not in the gap). |

Rows are per pump model and build type, with an *All types* subtotal per model. Filter to one build type
(or *Not specified*) with the drop-down. General notes without a pump model are not counted.

## Printing
**Print** on the planner prints the displayed week on **A4 landscape**: page 1 is the plan (who does what
each day, absences, build-type colours, working hours, printed date and name), page 2 is the weekly
summary. Navigation, buttons and the demand panel are left out. In the print dialog, keep
"Background graphics" ticked for the colours. Printing from a phone also gives the full week grid.

## History (admin)
**History** lists every change to planner jobs, absences, demand notes and build types: when, who, what
was added / deleted, and for changes the old → new value of each field. Filter by area or by team member.
Entries come from database triggers and cannot be edited or deleted through the app.

## Change history (audit log)
Every insert, update and delete on **assignments**, **absences**, **demand notes** and **build types** is recorded
automatically in `audit_log` (who, when, old and new values) by database triggers. Only admins can
read it (on the **History** page), and nobody can edit it through the app or API.
This is a planning aid, not a controlled QMS record.

## Build phases
1. ✅ Database, security & sign-in
2. ✅ People & skills matrix, Settings (pump models, tasks, working hours)
3. ✅ Weekly planner, absences and build types
4. ✅ Demand & notes (with build-type filter) and open-demand panel on the planner
5. ✅ Weekly summary by pump model and build type, History page, A4 print view
