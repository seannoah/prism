# CLAUDE.md — PRISM (RA coding portal) operations playbook

PRISM = Psychopharmacology Research Intern Scoring & Measurement Portal. A static app on GitHub Pages
(https://seannoah.github.io/prism/, this repo, branch `main`) talking to a Supabase project (`colimjlptydvfsgoikyw`).
Spec: `docs/SPEC.md`. Owner: Sean Noah. This file tells a Claude session how to turn Sean's plain-English requests
into the right commands. Run everything from this folder with the system `python3` (`/usr/bin/python3`, 3.9; the CLI
is standard library only and its TLS works). If you use the analysis venv's Munki Python 3.12 instead, prefix commands
with `SSL_CERT_FILE=$(python -m certifi)` or every call fails with a certificate error.

## Working alongside the analysis session
A separate Claude session works in `../Synesthesia` (the analysis repo). Ownership: this session owns this repo, the
Supabase project and every `prism_admin.py` operation; the analysis session owns `../Synesthesia`. The only shared
files are `../Synesthesia/Results/validation/prism/*.json|*.md` (import files and instructions, written there by the
analysis session's stage 10 or by hand; imported from here) and `../Synesthesia/Results/validation/prism_exports/`
(written by `sync-exports` here, read by the analysis session's stage 11). Both repos have `.git` ignored by Dropbox.
A Claude session cannot log into the site in a browser (it must not type passwords), so visual checks of a change are
Sean's; the session's checks are the unauthenticated login page in the Browser pane, `tests/test_coder_permissions.py`
(API-level, uses the TEST_CODER lines in `.env`), and the CLI's `status`/`members`.

## Status (update at the end of every session)
- 2026-09-08: v1.2.3 live; migrations 001, 002, 003 all applied (dashboard works). Accounts: Sean (admin,
  seannoah@gmail.com), Test Coder 1 / Test Coder 2 (prism-tester-1/2@example.com; passwords in `.env` TEST_CODER lines).
  All four synesthesia projects imported from `../Synesthesia/Results/validation/prism/` with rubric, instructions and
  training items: `syn-A-passage-precision` (300 items, coverage 2, calibration 20; re-imported with `--replace` on
  2026-09-08, so no test answers remain), `syn-BC-recall` (re-imported again 2026-09-08 with the split layout: 184
  model-negative reports coded as 240 items — reports over 12,000 characters are consecutive parts `R0011-1`, `R0011-2`,
  … with a context line; ids are neutral `R0001..` so coders cannot see which reports were keyword-flagged; the first 10
  items are whole reports for the calibration block; coverage 2, 15 training items; the analysis side collapses parts
  to reports, so never rename ids or reorder seq), `syn-D-same-modality` (18, coverage 2, calibration 0),
  `syn-E-label-mapping` (545, coverage 1, calibration 0). Sean is a member of all four (preview); the test coders are
  members of none — keep it that way for real rounds (the security test re-grants its own dummy coder; re-import with
  `--replace` after running it). No RAs invited yet. The length question for syn-BC is settled (split, not capped).
  Not yet built: a per-project RAs tab for many projects (v1.3), gold seeding in the pool, span and tag field types for
  the taxonomy projects, per-coder hour reports, custom SMTP for invitations.
- Rolling calibration flow (no synchronous meeting) is the adopted process; see the section below.

## Hard rules
1. The SECRET key lives only in `.env` here (git-ignored). Never print it, paste it into chat, or commit it. The
   publishable key in `config.js` is public by design.
2. Coders must never see model labels or other coders' answers: they live in `items.hidden`, the KEY files of the
   analysis project, and exports. Never put such data in `display`, `instructions_text` or `rubric_text`.
3. Exports (`prism_export_*.csv`) contain hidden fields and coder identities: treat them like KEY files (analysis
   only, never sent to coders).
4. Schema changes go through numbered files in `supabase/migrations/`; Sean pastes them into the Supabase SQL editor
   (a Claude session cannot run SQL there). Say exactly which file to paste.
5. `import --replace` and `delete-project` destroy annotations: confirm with Sean first.

## Deploying a change
Bump the version string in `index.html` (the `?v=` on styles.css, config.js and app.js) with every push that touches
those files; browsers cache them aggressively and a stale `app.js` under a new `index.html` breaks the page (seen
2026-09-04). A hard reload (Cmd-Shift-R) is the user-side fix for an already-cached copy.

## Where things are
- `index.html`, `app.js`, `styles.css`, `config.js`: the app (no build step; push to `main` deploys it).
- `supabase/migrations/001_init.sql`, `002_roster_training.sql`: schema, row-level security, functions.
- `supabase/migrations/003_admin_dashboard.sql`: the admin-only functions behind the dashboard.
- `admin/prism_admin.py`: admin CLI (`python3 admin/prism_admin.py -h` lists every command). `tests/test_coder_permissions.py`:
  security regression test. `How to add a new RA.md`: Sean's own one-line note (untracked).
- Analysis project that feeds/consumes PRISM: `../Synesthesia` (stage 10 writes `Results/validation/prism/*.json`;
  exports go to `../Synesthesia/Results/validation/prism_exports/`; stage 11 analyses them).

## Plain English → commands
| Sean says | do |
|---|---|
| "add RA x@calpoly.edu (Ada) to syn-A and syn-BC" | `python3 admin/prism_admin.py invite --email x@calpoly.edu --name "Ada" --projects syn-A-passage-precision,syn-BC-recall` (sends the invitation e-mail; the RA sets a password on the site; a Cal Poly address is preferred) |
| "give Ada access to syn-D" / "remove her from syn-A" | `grant --email ... --projects syn-D-same-modality` / `revoke --email ... --projects ...` |
| "who is on syn-A / have they done the training?" | `members --project syn-A-passage-precision` |
| "Ada should redo the training" | `reset-training --email ... --project ...` |
| "how far along is coding?" | `status` (coverage histogram, per-coder counts and hours) |
| "set up project X from the analysis" | `import --items ../Synesthesia/Results/validation/prism/<X>.json --calibration-n 20 --rubric-text ../Synesthesia/Docs/coding_rubric.md --instructions-text <md>`; then `import-training --project <name> --items <training.json>`; then grants |
| "update the instructions for X" | edit the markdown, then `set-instructions --project <name> --file <md>` |
| "update the rubric" | edit `../Synesthesia/Docs/coding_rubric.md` (the analysis repo's file, which the analysis session should also commit), then `set-rubric --project <name> --file ...` for every project that shows it |
| "add an option / a field to the form of X" | edit the `form_spec` (in the project's import JSON, then commit it in `../Synesthesia`), then `set-form --project <name> --file <json>`; adding options or fields is safe for existing answers; dropping or renaming a key needs `--yes` and leaves orphaned values, so prefer a re-import if coding has not started |
| "replace the training items of X" | `import-training --project <name> --items <training.json> --replace` (coders who already passed training keep their pass; `reset-training` if they should redo it) |
| "pull the coding data into the analysis" | `sync-exports --out-dir ../Synesthesia/Results/validation/prism_exports` (with the Munki Python 3.12 prefix `SSL_CERT_FILE=$(python -m certifi)`; the exports stay untracked like KEY files), then `cd ../Synesthesia/Analysis && python 11_validation_analysis.py --prism-dir ../Results/validation/prism_exports` and commit its outputs (`Results/validation/summary.md`, `disagreements.csv`, `Results/tables/validation_metrics.json`) |
| "close project X" / "reopen" | `close --project <name>` / `reopen --project <name>` (also a button in the dashboard) |
| "raise the coverage of X to 3" / "make the first 30 items calibration" | `set-project --project <name> --target 3` / `--calibration 30` (also editable in the dashboard; takes effect on the next claim) |
| "add these items to X" | `add-items --project <name> --items <json>` (pool grows; nothing else changes) |
| "someone is locked out" | `set-password --email ... --password '...'` (Sean runs it himself so the password never appears in chat), or tell them to use "Forgot your password?" on the site |
| "a coder left" | `deactivate --email ...` (annotations stay) |
| "is the security still right?" | fill the TEST_CODER lines in `.env` with two dummy accounts and run `python3 tests/test_coder_permissions.py` (it codes one item as the dummy coder: re-import the project with `--replace` before a real round) |

Project names are the `name` field of the import JSON (`syn-A-passage-precision`, `syn-BC-recall`, `syn-D-same-modality`,
`syn-E-label-mapping`).

## RA feedback and change requests: what each kind maps to
- **Wording, examples, edge cases** ("the instructions don't say what to do when…"): add an FAQ line to the project's
  markdown in `../Synesthesia/Results/validation/prism/<name>-instructions.md` and `set-instructions`. Safe, immediate,
  visible at the next item. Rubric-level changes (`../Synesthesia/Docs/coding_rubric.md` + `set-rubric` on every
  project) are Sean's decision: they change the reference standard, so log them with the date in the FAQ.
- **A training item's key or explanation is wrong**: fix the training JSON, `import-training --replace`; or key the
  item in the Calibration tab if it is a calibration item.
- **Form problems** (missing option, wants a free-text box): `set-form` (see the table). Removing options is the
  destructive case.
- **Item problems** (a truncated passage, a report that is far too long, a duplicate): there is no per-item removal.
  Before coding starts, fix the export in the analysis project and re-import with `--replace` (confirm with Sean).
  After coding starts, leave the item, note it for adjudication, and if needed raise the pool with `add-items`.
- **Workload** ("this will take too long"): lower the coverage or the pool (`set-project`, or re-export a smaller pool
  before coding starts); the calibration block size is also a `set-project` field.
- **Access and accounts**: invitations (`invite`), grants (Access tab or `grant`/`revoke`), lock-outs (`set-password`
  by Sean, or the site's "Forgot your password?"), departures (`deactivate`).
- **App bugs or UI requests**: edit `index.html` / `app.js` / `styles.css`, bump the `?v=` version, push to `main`,
  ask Sean to hard-reload and check; anything needing SQL is a new numbered migration that Sean pastes.
- **Anything that deletes answers** (`import --replace`, `delete-project`, dropping a form key): say so and get a yes.

## The lab dashboard (Admin tab, admins only; migration 003)
Projects tab: coverage bars, ratings done / needed, items-by-number-of-ratings, members and training, editable target
coverage / calibration size / training-required, close or reopen. RAs tab: per RA and project done / skipped / hours /
last active / training / calibration agreement with the key; activate or deactivate; reset training. Access tab: RA ×
project tick boxes (= grant / revoke). Calibration tab: the calibration block with every coder's answer; set the key
per item (used for the agreement figure and, if the item is also a training item, for feedback). What the dashboard
cannot do: invite accounts (needs the secret key) and import projects or items (file-based) - those stay here.

## Calibration without a synchronous meeting (recommended flow for a rolling roster)
1. Every newcomer completes the training items (feedback per item) at their own pace.
2. The calibration block (first N pool items, identical for everyone) is coded next; Sean keys those items once in
   the Calibration tab, so each newcomer's agreement with the key appears in the RAs tab without a group meeting.
3. Disagreements become FAQ lines in the instructions (`set-instructions`), which every RA sees at the next session.
4. Gold seeding (a small share of keyed items mixed into the pool for continuous drift checks) is planned as v1.3.

## How a project flows
import (items with `display` for coders, `hidden` for the analysis) → optional training items with `gold_values` +
`explanation` (shown after each training answer) → instructions text (Start screen) → grants (only granted coders see
the project) → coders: instructions → training (once per project) → calibration block (same first N items for everyone)
→ pool (pull-based, target coverage per item, claims expire after 2 h) → `status` while it runs → `sync-exports` → stage 11.

## Supabase settings that must stay as they are
Authentication → Sign In / Providers: Email on, "Allow new users to sign up" OFF. Authentication → URL Configuration:
Site URL `https://seannoah.github.io/prism/`, redirect URLs include `https://seannoah.github.io/prism/**` (invitation
and password-reset links land there). The free project pauses after 7 idle days; `.github/workflows/keepalive.yml`
pings it twice a week.
