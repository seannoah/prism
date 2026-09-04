# CLAUDE.md — PRISM (RA coding portal) operations playbook

PRISM = Psychopharmacology Research Intern Scoring & Measurement Portal. A static app on GitHub Pages
(https://seannoah.github.io/prism/, this repo, branch `main`) talking to a Supabase project (`colimjlptydvfsgoikyw`).
Spec: `docs/SPEC.md`. Owner: Sean Noah. This file tells a Claude session how to turn Sean's plain-English requests
into the right commands. Run everything from this folder; `admin/prism_admin.py` needs only the system `python3`.

## Status (update at the end of every session)
- 2026-09-04: v1.2.3 live. Migrations applied by Sean: 001, 002. **003 (dashboard) pending** — until it is pasted into the
  SQL editor the Admin tab shows an error. Accounts: Sean (admin, seannoah@gmail.com), Test Coder 1 / Test Coder 2
  (prism-tester-1/2@example.com; passwords in `.env` TEST_CODER lines). Project `syn-A-passage-precision` imported
  (300 items, coverage 2, calibration 20, rubric + instructions text, 12 training items from the primer's practice set);
  Test Coder 1 and Sean are members; a few test answers exist → **re-import with `--replace` before the real round**.
  Not yet built: gold seeding in the pool (v1.3), span and tag field types for the taxonomy projects, per-coder hour
  reports, custom SMTP for invitations.
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
- `admin/prism_admin.py`: admin CLI. `tests/test_coder_permissions.py`: security regression test.
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
| "pull the coding data into the analysis" | `sync-exports --out-dir ../Synesthesia/Results/validation/prism_exports` then commit in `../Synesthesia` and run `Analysis/11_validation_analysis.py` |
| "close project X" / "reopen" | `close --project <name>` / `reopen --project <name>` (also a button in the dashboard) |
| "raise the coverage of X to 3" / "make the first 30 items calibration" | `set-project --project <name> --target 3` / `--calibration 30` (also editable in the dashboard; takes effect on the next claim) |
| "add these items to X" | `add-items --project <name> --items <json>` (pool grows; nothing else changes) |
| "someone is locked out" | `set-password --email ... --password '...'` (Sean runs it himself so the password never appears in chat), or tell them to use "Forgot your password?" on the site |
| "a coder left" | `deactivate --email ...` (annotations stay) |
| "is the security still right?" | fill the TEST_CODER lines in `.env` with two dummy accounts and run `python3 tests/test_coder_permissions.py` (it codes one item as the dummy coder: re-import the project with `--replace` before a real round) |

Project names are the `name` field of the import JSON (`syn-A-passage-precision`, `syn-BC-recall`, `syn-D-same-modality`,
`syn-E-label-mapping`).

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
