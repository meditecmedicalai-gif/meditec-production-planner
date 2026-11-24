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
   (build types: Production / Trial / Rental / Customer), then
   [`003_background_jobs.sql`](supabase/migrations/003_background_jobs.sql) (background / overnight jobs, equipment), then
   [`004_realtime.sql`](supabase/migrations/004_realtime.sql) (live updates; refreshed build-type colours), then
   [`005_capacity_recurring.sql`](supabase/migrations/005_capacity_recurring.sql) (test capacity, "Any / mixed pump",
   recurring jobs; its last result column says **Live updates: OK** — or lists tables to switch on by hand, see
   *Live updates* below), then [`006_capacity_rules.sql`](supabase/migrations/006_capacity_rules.sql) (agreed
   capacity rules; never overwrites your own Settings).

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
- you land on **Today**; Settings lists the pump models, build types, tasks and equipment;
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
src/main.js                        app shell (sidebar / tab bar), routing, sign-in gate, live updates
src/pages/today.js                 Today dashboard (Chart.js charts, timeline)
src/theme.js, src/realtime.js      light / dark mode, Supabase Realtime subscription
public/brand/logo.png              drop-in logo
src/supabase.js                    Supabase client (reads VITE_* config)
src/pages/                         one file per page
.github/workflows/deploy.yml       build + deploy to GitHub Pages on push to main
```

## Today (home page)
Everyone lands on **Today** after signing in:
- a greeting, live clock and **shift bar** (start, break, lunch, finish, "lunch in 25 min");
- key numbers: units planned this week, open demand, overdue notes, people off today (click to jump);
- **This week at a glance** in plain English ("38 pumps planned against 65 needed by Friday…") with a
  planned-vs-needed chart per pump model;
- **From the floor**: newest open demand notes;
- charts for build-type mix, the eight-week trend, jobs per person (striped = background) and equipment
  hours booked — click any chart to open the week planner;
- **Today on the floor**: an hour-by-hour timeline per person with a red "now" line; background jobs run as
  a slim striped band underneath; jobs without times share the day.
Use ‹ › to look at other weeks. Charts are drawn with [Chart.js](https://www.chartjs.org/).

## Live updates
When someone else changes the plan, absences, demand notes, people or settings, your screen refreshes by
itself and a short notice says who changed what (e.g. "Elaine added a note"). The sidebar shows **● Live**
while connected. If you have a form open, the refresh waits until you close it. Live updates use Supabase
Realtime with the same RLS rules: you only ever receive rows you are allowed to read, and the change log
is never sent.

### If live updates are not on for every table
`rls_check.sql` names any table without live updates. In some Supabase projects the SQL Editor is not allowed
to change the live-updates publication; switch the tables on in the dashboard instead:
**Database → Publications → `supabase_realtime`** → turn on each listed table (or Table Editor → table →
*Enable Realtime*). Then run `rls_check.sql` again. To see what is on right now:

```sql
select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1;
```

## Look & feel
- **Light / dark mode**: the switch in the sidebar (or *More* on a phone); remembered on each device and
  defaults to the device's own setting.
- The sidebar can be collapsed to icons (remembered). On a phone, navigation is a bottom tab bar.
- Motion is kept subtle and switches off completely when the device is set to "reduce motion".
- **Logo**: [`public/brand/logo.png`](public/brand/logo.png) (transparent background, about 1040 × 330 px).
  To change it, replace that one file — no code changes. If the file is missing, a "Meditec" wordmark
  is shown instead. In dark mode it is shown in light ink automatically.

## Test capacity
Pumps are tested several at a time, so the planner adds up **testing jobs** that overlap in time and warns
(it never blocks) when a limit is exceeded.
- **Testing tasks** are marked in Settings → Tasks (🧪): Functional test / calibration, Quality testing,
  Soak / burn-in test. For these, **quantity = number of pumps on test**.
- Each **pump model has a default test area** (Settings → Pump models).
- **Test areas** (Settings → Test areas & limits) are **separate**, each with its own absolute maximum:
  *Main test area* **7** (QPro 2000, Simplex, MediAir, MediAir Turn, MATS, Bari-Med 1) and
  *Medicare / Mediflex test area* **1**. The Medicare / Mediflex area does not count towards the Main 7, and
  there is no limit across areas.
- **Limit groups** inside the Main area: QPro 2000 max 7; MediAir + Simplex max 6 combined; MediAir Turn max 3.
  MATS and Bari-Med 1 have no group of their own — they just count towards the Main area's 7.
- **Same pump, two tasks**: in the Medicare / Mediflex area, calibration and quality testing on the **same pump
  at the same time** count as one pump (no clash). A Medicare and a Mediflex at the same time are two pumps.
- Times come from the jobs (overnight and background jobs included); a testing job **without times counts all
  day**, so add times for accurate figures.
- Where you see it: a **Test capacity** row at the top of each day in the planner ("Main 6/7 14:00"; amber =
  full, red = over), ⚠ on the jobs involved, warnings in the job form before saving, and a **Test areas** card
  on Today (pumps on test now and today's peak).

## "Any / mixed pump"
Repair-type tasks (Settings → Tasks → *Allows "Any / mixed pump"*) can be planned on **Any / mixed pump**,
e.g. rental repairs. When the pumps are known you can list them ("2× QPro, 1× Mediflex"). Training warnings
are skipped for these jobs, and summaries show them as their own **Any / mixed** row. Demand notes can also
be for "Any / mixed pump".

## Recurring jobs
- In **Add work**, choose **Repeat**: every working day, every day, weekly on chosen days, or every N weeks;
  with a *Repeat until* date or no end. Jobs are created **12 weeks ahead** and topped up automatically.
- A recurring job can be saved **without a person** ("Not assigned yet"). The **🔁 Recurring jobs** panel on
  the Week planner lists them — use **Assign…** to pick a person **and set the start / end time**, and the jobs
  are created. Migration 005 adds a ready-made **Rental repairs** (Any pump, Rental, every working day, no
  times yet) waiting to be assigned.
- **Times** can be changed any time: on the 🔁 panel (the time boxes on each row → *From today onwards* or
  *All jobs in the series*), or by opening one job in the planner → *This one only / This and future / All*.
- Recurring jobs show **🔁**. Days when the person is absent are **skipped and flagged** in the planner.
- Editing or deleting one asks **This one only / This and future / All**.
- **Copy last week** never copies recurring jobs (they repeat by themselves).
- **Stop** (in the panel) removes the jobs from today onwards and keeps past ones.

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
- **Times, overnight and multi-day jobs** (optional, under *Timing & equipment*): give a start and end
  time. If the end time is earlier than the start (e.g. 16:00 → 08:00) the job runs overnight; set
  **Ends on** for jobs over several days. The job appears on every day it covers ("16:00 → 08:00 next
  day" on the first day, "cont. from Mon 16:00 · ends 08:00" after). Quantities are counted once, on the
  start day. No times = all day.
- **Background / unattended jobs** (e.g. soak / burn-in tests) look clearly different from attended work:
  attended jobs are solid cards; background jobs are indented, hatched, outlined with a dashed border, carry a
  dark **⏱ Background** label and are listed under *Running in the background*. A task can be marked background in Settings; each job can
  override it (*Runs: Task default / Background / Attended*). Background jobs never count as a time clash
  for the person, and are only flagged for absence on the day they start (someone has to set them up).
- **Equipment / test stations** (Settings) can be linked to a job. ⚠ warns when the same equipment is
  booked at overlapping times (any person), and when a person has two attended jobs whose times overlap.
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
| **Planned** | Quantity targets this week (Mon–Fri) for tasks marked *Counts as output* in Settings (normally Final assembly). Tick **Count all pump tasks** to include every pump task instead. Background jobs follow the same rule; a job spanning several days counts once, in the week it starts. |
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
Every insert, update and delete on **assignments**, **absences**, **demand notes**, **build types** and **equipment** is recorded
automatically in `audit_log` (who, when, old and new values) by database triggers. Only admins can
read it (on the **History** page), and nobody can edit it through the app or API.
This is a planning aid, not a controlled QMS record.

## Build phases
1. ✅ Database, security & sign-in
2. ✅ People & skills matrix, Settings (pump models, tasks, working hours)
3. ✅ Weekly planner, absences and build types
4. ✅ Demand & notes (with build-type filter) and open-demand panel on the planner
5. ✅ Weekly summary by pump model and build type, History page, A4 print view
6. ✅ Background & overnight jobs, job times, equipment / test stations
7. ✅ Today dashboard, charts, live updates, Meditec visual redesign (light / dark)
8. ✅ Test capacity, "Any / mixed pump" repairs, recurring jobs, clearer background jobs
