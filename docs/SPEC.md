# PRISM portal: planning document

*v0.2, 2026-09-03. The specification for a small, zero-cost web portal that hands coding tasks to research assistants, tracks their progress and time, and feeds the results straight into the analysis. This is the build brief for Claude Code; the task list is work order WO-8 in `review_and_next_steps.md` §6.*

## 0. The name

**PRISM — Psychopharmacology Research Intern Scoring & Measurement Portal** (decided 2026-09-03). It keeps the intern framing because the portal's primary users are Sean's students; "scoring and measurement" is what they do in it. The metaphor still holds: a prism splits one beam into its spectral components, which is what coding does to a narrative report.

## 1. Why build it (decided: yes, now)

For the synesthesia validation alone a portal would be overkill: five spreadsheets and three or four RAs can be managed by hand. The case for building it is that the same validation pattern (LLM labels a large corpus; humans code a sample; agreement and error rates go into the paper) recurs in every Erowid project the lab runs, and Sean expects numerous projects in which RA review and evaluation help. The spreadsheet approach is exactly what breaks when the roster changes: assignments baked into files have to be re-cut when someone drops or joins; double-coding coverage has to be tracked by hand; time spent is self-reported or lost; and merging six people's sheets is where transcription errors enter. A pull-based task queue makes all of that disappear: nobody is assigned anything, coders pull the next item that still needs a rating, and the system keeps count. That is the feature that justifies a portal, and it is small. The decision (2026-09-03) is to build a deliberately minimal v1 now, use the synesthesia calibration round as its acceptance test, and grow it only when a real need appears.

The two alternatives considered, so the choice is deliberate: an off-the-shelf annotation tool such as Label Studio or Doccano gives accounts, queues, and agreement metrics for free, but needs a server that runs continuously, which means a lab machine or a paid host, and its data model fights the task "read this 1,600-word report and fill in six fields". Google Sheets plus Apps Script is free and quick but has no real queue, no clean time tracking, and turns into a pile of scripts. A static site plus a hosted Postgres with row-level security (the design below) sits between them: no server to run, a real database, and an interface shaped exactly like the coding task.

## 2. Scope

What v1 must do: let you create a project (a coding task with its own form fields and rubric); import items (passages or reports, with hidden metadata); let coders log in, pull the next item, code it, and see their own progress and time; enforce a target coverage per item (for example two coders each) and never show a coder the same item twice; record time per item and per session automatically; export everything as CSV or directly into Python.

What v1 must not do: any dashboard beyond a table; any analytics (agreement, precision) inside the app, which belongs in the analysis scripts where it is versioned; any showing of model labels to coders; user self-registration; mobile-first design; anything that would require a server-side component you have to keep running.

Things that can come later if needed: an adjudication view for you (see both coders' answers, choose); gold items and live agreement alerts; per-coder hour reports for course credit; a generic "scale" field type (Likert, sliders) for questionnaire-style measurement; multiple concurrent projects with per-project rosters.

## 3. Architecture

A single-page web app served as static files from GitHub Pages, at `seannoah.github.io/prism/` (a repository named `prism` with Pages enabled; your existing site is untouched). All logic runs in the browser and talks to a hosted Supabase project (free tier) that provides authentication, a Postgres database, and row-level security so that each coder can only see and write their own work. There is no server of yours anywhere. The Supabase "anon" key ships in the page by design; row-level security policies, not the key, protect the data. Admin operations (creating coders, importing items, exporting) run from your laptop with a small Python script that uses the service key, which never leaves your machine.

Cost is zero at this scale. Supabase's free tier allows 500 MB of database storage and tens of thousands of monthly users; a project with 5,000 items of full report text is a few tens of megabytes. The one operational quirk is that free projects pause after seven days without activity; a click in the Supabase dashboard resumes them, or a weekly GitHub Actions job can ping the database to keep it awake. GitHub Pages is free for public repositories; the app code is public, the data is not.

Front end: plain HTML, CSS, and JavaScript with `supabase-js` loaded from a CDN; no build step, so the repository is just the files that are served. A small hash router gives four screens: login, work (the coding form), progress (per-coder table), and admin (project and item lists, visible only to the admin role). The coding form is rendered from a JSON field specification stored with the project, so a new project needs no code changes.

## 4. Data model

```sql
-- who
create table profiles (
  user_id uuid primary key references auth.users,
  display_name text not null,
  role text not null check (role in ('admin','coder')),
  active boolean not null default true);

-- what is being coded
create table projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  rubric_url text,
  form_spec jsonb not null,           -- fields: [{key, label, type: choice|multi|int|text, options, required}]
  target_coverage int not null default 2,
  calibration_n int not null default 0, -- first N items shown to everyone before the pool
  status text not null default 'open');

create table items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects,
  external_id text not null,           -- e.g. A0123 (matches the KEY files)
  display jsonb not null,              -- what coders see: {text, context}
  hidden jsonb,                        -- what they don't: report_id, LLM labels, substance
  is_gold boolean default false,
  gold_values jsonb,
  seq int not null);                   -- import order

-- who is doing / has done what
create table assignments (
  id uuid primary key default gen_random_uuid(),
  item_id uuid references items,
  coder_id uuid references profiles,
  status text not null default 'claimed' check (status in ('claimed','done','skipped')),
  claimed_at timestamptz default now(),
  expires_at timestamptz,              -- claim returns to the pool if not finished
  unique (item_id, coder_id));

create table annotations (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid references assignments unique,
  values jsonb not null,               -- {is_synesthesia: "1", input_modalities: ["Auditory"], ...}
  confidence int,
  notes text,
  time_spent_s int not null,           -- item timer (active seconds)
  submitted_at timestamptz default now(),
  revised_values jsonb, revised_at timestamptz);

create table sessions (                -- coarse time accounting via heartbeat
  id uuid primary key default gen_random_uuid(),
  coder_id uuid references profiles,
  project_id uuid references projects,
  started_at timestamptz default now(),
  last_seen_at timestamptz,
  active_seconds int default 0);
```

The heart of the system is one database function, `claim_next_item(project_id)`, which a coder's browser calls to get work. It selects, with a row lock and `skip locked` so two coders never race, the item with the fewest completed annotations that this coder has not yet seen, is not currently claimed by someone else with an unexpired claim, and still has fewer completed annotations than the project's target coverage, honouring the calibration block first. It inserts the assignment with a two-hour expiry and returns the item's display payload. Because work is pulled rather than pushed, a coder who joins late simply starts pulling, a coder who leaves stops, and their expired claims fall back into the pool; coverage converges to the target regardless of how the roster or anyone's available hours change. If you want the pool to end with every item double-coded, you only need to keep the project open until the coverage view says so.

Row-level security policies, in words: coders can read a row of `items` only through an assignment they hold; they can insert an assignment only via the claim function; they can insert or update an annotation only for their own assignment; they can read their own assignments, annotations, and sessions; admins can read everything. Model labels live in `hidden` and are never selected by the client.

## 5. Coder experience

Login with email and password (accounts created by you; no self-signup). The work screen shows the rubric link, the item text, the form, a confidence selector, a notes box, a skip button (requires a reason), and a submit button. A timer starts when the item appears, pauses after two minutes without keyboard or mouse activity or when the tab is hidden, and stops at submit; its value is stored with the annotation, and a once-a-minute heartbeat maintains the session total, so both per-item and per-session time are available without the coder doing anything. After submit the next item appears immediately. The progress screen lists, per project, items completed, items skipped, total active time, and a "revisit" list of their own last twenty annotations, which they may edit until the project is closed (edits are kept as `revised_values`, so the first answer is never lost).

## 6. Admin workflow and integration with the analysis

You create a project by writing a JSON form spec (for the synesthesia sheets: a 0/1/U choice, two multi-select modality fields, a 1–5 confidence, notes) and a target coverage, then run `prism_admin.py import --project <id> --items items.json`. `10_build_validation_samples.py` gains an `--export-prism` flag that writes exactly that JSON, with the coding text in `display` and the KEY columns in `hidden`, so the same item ids flow through unchanged. During coding, `prism_admin.py status` prints coverage and per-coder time. When done, `prism_admin.py export --project <id>` writes `Results/validation/prism_export_<project>.csv`, and a new `11_validation_analysis.py` computes precision and recall with Wilson intervals, Cohen's κ (two coders) or Krippendorff's α (any number), per-coder drift, the LLM-versus-consensus confusion matrix, and modality agreement, writing `Results/validation/summary.md` for the paper. Nothing in the analysis depends on the portal: the same script accepts the spreadsheet format used in the first calibration round, so the two routes can coexist.

Import format (already produced by `10_build_validation_samples.py --export-prism`, see `Results/validation/prism/`): one JSON file per project,

```json
{"project": {"name": "syn-A-passage-precision", "description": "...", "rubric_url": "Docs/coding_rubric.md",
             "target_coverage": 2, "calibration_n": 20,
             "form_spec": [
               {"key": "is_synesthesia", "label": "...", "type": "choice", "options": ["1","0","U"], "required": true},
               {"key": "input_modalities", "label": "...", "type": "multi", "options": ["Auditory", "..."],
                "show_if": {"is_synesthesia": ["1","U"]}},
               {"key": "confidence", "label": "...", "type": "int", "min": 1, "max": 5, "required": true},
               {"key": "notes", "label": "...", "type": "text"}]},
 "items": [{"external_id": "A0000", "seq": 0, "is_gold": false,
            "display": {"text": "...", "context": null},
            "hidden": {"report_id": 123, "substance": "LSD", "input_modality_canonical": "Auditory", "...": "..."}}]}
```

Field types for v1 are `choice` (radio), `multi` (checkboxes), `int` (bounded number), and `text`; `show_if` hides a field until another field has one of the listed values; `required` blocks submit. `display.context`, when present, is shown in a muted box under the text (used by syn-D to show the model's two labels being adjudicated). Everything in `hidden` is stored but never selected by the coder client.

## 7. Quality control built into the design

The first `calibration_n` items are identical for all coders and are discussed at the calibration meeting before the pool opens; agreement on them is the go/no-go for starting. A small fraction of gold items (ones you have adjudicated) can be mixed into the pool; a coder whose gold agreement drops below a threshold gets flagged in `status`. Items marked "skipped" or "U" surface in an adjudication list for you. Because coders never see each other's answers or the model's, the design is blind by construction.

## 8. Privacy, ethics, and data handling

Erowid reports are public text, but the analysis is unpublished, so the project is private (login required). The portal stores coder names, emails, and time-on-task; that is ordinary supervision data, not research data, and does not need IRB review unless you later study the coders themselves. Keep the service key out of the repository (`.env`, git-ignored). Export the annotations weekly to the Dropbox project so the database is never the only copy. Delete coder accounts when people leave; their annotations stay.

## 9. Build plan and effort

Phase 1, v1, starts now (roughly three to five focused days with Claude Code doing most of the typing; the design above is the specification, and the review document's work order WO-8 is the task list): Supabase project, schema and policies, the claim function, the four-screen static app, `prism_admin.py` (create coder, import items JSON, status, export CSV), and `11_validation_analysis.py` reading the export; tested with two dummy coder accounts on the 20-item synesthesia calibration block; then the real RAs run the calibration round in PRISM, which doubles as the rubric-freezing meeting's input. Phase 2 (when a need appears): adjudication view, gold-item alerts, hour reports for course credit, additional field types (Likert, sliders), multi-project rosters. The main risk is scope creep, which is why the "must not" list in section 2 exists; the technical risks are policy mistakes that expose hidden fields (mitigated by a test that logs in as a coder and tries to read them) and the free-tier pause (mitigated by a weekly ping from a GitHub Actions cron).

Where it lives: its own GitHub repository (`prism`), cloned outside the synesthesia project (for example `~/code/prism` or a sibling `Lab/PRISM/` folder), with this document copied in as `docs/SPEC.md`. The synesthesia project only exchanges JSON/CSV files with it.

## 10. Open decisions

Supabase versus Firebase (either works; Supabase's Postgres makes the analysis export trivial and is the recommendation); whether to add a custom domain (unnecessary; `seannoah.github.io/prism/` is fine); and whether coders log in with Cal Poly email addresses only (recommended, to keep the roster tidy).
