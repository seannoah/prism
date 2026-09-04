# CLAUDE.md — PRISM (RA coding portal) operations playbook

PRISM = Psychopharmacology Research Intern Scoring & Measurement Portal. A static app on GitHub Pages
(https://seannoah.github.io/prism/, this repo, branch `main`) talking to a Supabase project (`colimjlptydvfsgoikyw`).
Spec: `docs/SPEC.md`. Owner: Sean Noah. This file tells a Claude session how to turn Sean's plain-English requests
into the right commands. Run everything from this folder; `admin/prism_admin.py` needs only the system `python3`.

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
| "close project X" / "reopen" | `close --project <name>` / `reopen --project <name>` |
| "someone is locked out" | `set-password --email ... --password '...'` (Sean runs it himself so the password never appears in chat), or tell them to use "Forgot your password?" on the site |
| "a coder left" | `deactivate --email ...` (annotations stay) |
| "is the security still right?" | fill the TEST_CODER lines in `.env` with two dummy accounts and run `python3 tests/test_coder_permissions.py` (it codes one item as the dummy coder: re-import the project with `--replace` before a real round) |

Project names are the `name` field of the import JSON (`syn-A-passage-precision`, `syn-BC-recall`, `syn-D-same-modality`,
`syn-E-label-mapping`).

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
