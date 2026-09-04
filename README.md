# PRISM — Psychopharmacology Research Intern Scoring & Measurement Portal

A minimal coding portal for research assistants: coders log in, pull the next item that still needs a rating, code it
on a form generated from a JSON spec, and their time is recorded automatically. A static single-page app on GitHub
Pages (this repository) talks directly to a Supabase project (auth + Postgres + row-level security). No server to run.
Specification: `docs/SPEC.md`.

App: https://seannoah.github.io/prism/

## Layout

```
index.html, app.js, styles.css, config.js   the app (no build step; config.js holds the public URL + publishable key)
supabase/migrations/001_init.sql            tables, row-level security, claim_next_item() and the other functions
admin/prism_admin.py                        admin CLI (secret key from .env): create-coder, import, status, export, close
tests/test_coder_permissions.py             logs in as a coder and checks that hidden fields / others' work are invisible
.github/workflows/keepalive.yml             twice-weekly ping so the free-tier database never pauses
docs/SPEC.md                                the design document
```

## One-time setup

1. Supabase: create the project; in the SQL Editor run `supabase/migrations/001_init.sql`; in Authentication → Settings
   turn OFF "Allow new users to sign up" (accounts are created by the admin script).
2. `cp .env.example .env` and paste the secret key (from Project Settings → API keys) into `.env`.
3. `python3 admin/prism_admin.py create-coder --email you@calpoly.edu --name "Sean" --role admin`
4. `python3 admin/prism_admin.py import --items ../Synesthesia/Results/validation/prism/syn-A-passage-precision.json --calibration-n 20 --rubric-text ../Synesthesia/Docs/coding_rubric.md`
5. Push to `main`; GitHub Pages serves the app.

## Daily use

```
python3 admin/prism_admin.py create-coder --email ra@calpoly.edu --name "Ada"     # prints a temporary password
python3 admin/prism_admin.py status                                               # coverage + per-coder time
python3 admin/prism_admin.py export --project syn-A-passage-precision --out exports/syn-A.csv
python3 admin/prism_admin.py close --project syn-A-passage-precision
```

Coders never see `hidden` fields or other coders' answers: items are only reachable through `claim_next_item()`, and the
tables are protected by row-level security (verified by `tests/test_coder_permissions.py`). Keep `.env` private and
export annotations regularly so the database is never the only copy.
