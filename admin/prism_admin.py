#!/usr/bin/env python3
"""
PRISM admin CLI (runs on the admin's laptop with the SECRET key; never ship this key).

Configuration: a `.env` file in the repository root (git-ignored) with
    SUPABASE_URL=https://<project>.supabase.co
    SUPABASE_SECRET_KEY=sb_secret_...
    SUPABASE_PUBLISHABLE_KEY=sb_publishable_...      (optional; only the tests need it)

Commands
    create-coder --email a@b.edu --name "Ada" [--role coder|admin] [--password ...]   create the auth user + profile
    list-coders
    set-password --email a@b.edu [--password ...]    new password (printed if generated)
    deactivate --email a@b.edu                      keeps the annotations, blocks login
    import --items path.json [--calibration-n N] [--rubric-text path.md] [--instructions-text path.md] [--replace]
                                                    create a project + its items from the stage-10 JSON
    invite --email a@b.edu --name "Ada" [--projects syn-A,syn-BC]   send a Supabase invite e-mail (the RA sets their own
                                                    password on the site) + profile + project grants
    grant --email a@b.edu --projects syn-A,syn-BC   / revoke --email ... --projects ...
    members --project NAME                          roster with training status
    reset-training --email a@b.edu --project NAME   let a coder redo the training
    import-training --project NAME --items training.json [--replace]   training items (gold answers + explanations)
    set-instructions --project NAME --file path.md  the text shown on the project's start screen
    sync-exports --out-dir DIR                      export every project (annotations + training answers) as CSV
    status [--project NAME]                         coverage per project, per-coder counts and time
    export --project NAME --out path.csv            one row per annotation (values flattened, hidden fields flattened)
    close --project NAME / reopen --project NAME
    delete-project --project NAME --yes             removes the project and everything under it

Only the Python standard library is used (urllib), so the system python3 works.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_env(path: Path = ROOT / ".env") -> dict:
    env = dict(os.environ)
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    for k in ("SUPABASE_URL", "SUPABASE_SECRET_KEY"):
        if not env.get(k):
            sys.exit(f"{k} missing: put it in {path} (see .env.example)")
    return env


class Client:
    def __init__(self, env: dict):
        self.url = env["SUPABASE_URL"].rstrip("/")
        self.key = env["SUPABASE_SECRET_KEY"]

    def _req(self, method: str, path: str, body=None, prefer: str | None = None, params: dict | None = None):
        url = f"{self.url}{path}"
        if params:
            url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("apikey", self.key)
        req.add_header("Authorization", f"Bearer {self.key}")
        req.add_header("Content-Type", "application/json")
        if prefer:
            req.add_header("Prefer", prefer)
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                txt = r.read().decode()
                return json.loads(txt) if txt.strip() else None
        except urllib.error.HTTPError as e:
            sys.exit(f"{method} {path} -> HTTP {e.code}: {e.read().decode()[:500]}")

    # PostgREST
    def select(self, table: str, params: dict | None = None):
        return self._req("GET", f"/rest/v1/{table}", params=params)

    def insert(self, table: str, rows, upsert: bool = False):
        prefer = "return=representation" + (",resolution=merge-duplicates" if upsert else "")
        return self._req("POST", f"/rest/v1/{table}", body=rows, prefer=prefer)

    def update(self, table: str, params: dict, body: dict):
        return self._req("PATCH", f"/rest/v1/{table}", body=body, prefer="return=representation", params=params)

    def delete(self, table: str, params: dict):
        return self._req("DELETE", f"/rest/v1/{table}", params=params, prefer="return=representation")

    # Auth admin
    def create_user(self, email: str, password: str, name: str):
        return self._req("POST", "/auth/v1/admin/users",
                         body={"email": email, "password": password, "email_confirm": True, "user_metadata": {"display_name": name}})

    def set_password(self, user_id: str, password: str):
        return self._req("PUT", f"/auth/v1/admin/users/{user_id}", body={"password": password})

    def invite_user(self, email: str, name: str, redirect_to: str | None = None):
        path = "/auth/v1/invite" + (f"?redirect_to={urllib.parse.quote(redirect_to, safe='')}" if redirect_to else "")
        return self._req("POST", path, body={"email": email, "data": {"display_name": name}})

    def list_users(self):
        out = self._req("GET", "/auth/v1/admin/users", params={"per_page": 1000})
        return out.get("users", out) if isinstance(out, dict) else out


def cmd_create_coder(c: Client, a):
    pw = a.password or secrets.token_urlsafe(12)
    user = c.create_user(a.email, pw, a.name)
    uid = user["id"]
    c.insert("profiles", [{"user_id": uid, "display_name": a.name, "email": a.email, "role": a.role, "active": True}], upsert=True)
    print(f"created {a.role} {a.name} <{a.email}> user_id {uid}")
    print(f"temporary password: {pw}   (send it to the coder; they can change it later)")


def cmd_set_password(c: Client, a):
    prof = c.select("profiles", {"select": "user_id,display_name", "email": f"eq.{a.email}"})
    if not prof:
        sys.exit(f"no profile with email {a.email}")
    pw = a.password or secrets.token_urlsafe(12)
    c.set_password(prof[0]["user_id"], pw)
    print(f"password set for {prof[0]['display_name']} <{a.email}>" + ("" if a.password else f": {pw}"))


def cmd_list_coders(c: Client, a):
    for p in c.select("profiles", {"select": "user_id,display_name,email,role,active,created_at", "order": "created_at"}):
        print(f"{p['role']:6s} {'active' if p['active'] else 'OFF':6s} {p['display_name']:24s} {p.get('email') or '':32s} {p['user_id']}")


def cmd_deactivate(c: Client, a):
    r = c.update("profiles", {"email": f"eq.{a.email}"}, {"active": False})
    print(f"deactivated {len(r)} profile(s)")


def cmd_import(c: Client, a):
    spec = json.load(open(a.items, encoding="utf-8"))
    proj = dict(spec["project"])
    if a.calibration_n is not None:
        proj["calibration_n"] = a.calibration_n
    if a.rubric_text:
        proj["rubric_text"] = Path(a.rubric_text).read_text(encoding="utf-8")
    if a.instructions_text:
        proj["instructions_text"] = Path(a.instructions_text).read_text(encoding="utf-8")
    existing = c.select("projects", {"select": "id,name", "name": f"eq.{proj['name']}"})
    if existing:
        if not a.replace:
            sys.exit(f"project {proj['name']} exists (id {existing[0]['id']}); use --replace to delete and re-import")
        c.delete("projects", {"id": f"eq.{existing[0]['id']}"})
        print(f"deleted existing project {proj['name']}")
    keep = {k: proj[k] for k in ("name", "description", "rubric_url", "rubric_text", "instructions_text", "form_spec",
                                 "target_coverage", "calibration_n") if k in proj}
    created = c.insert("projects", [keep])[0]
    pid = created["id"]
    items = spec["items"]
    rows = [{"project_id": pid, "external_id": it["external_id"], "display": it["display"], "hidden": it.get("hidden"),
             "is_gold": bool(it.get("is_gold", False)), "gold_values": it.get("gold_values"), "seq": int(it.get("seq", i))}
            for i, it in enumerate(items)]
    for s in range(0, len(rows), 500):
        c.insert("items", rows[s:s + 500])
    print(f"imported project {proj['name']} (id {pid}): {len(rows)} items, target coverage {keep.get('target_coverage', 2)}, "
          f"calibration_n {keep.get('calibration_n', 0)}")


APP_URL = "https://seannoah.github.io/prism/"


def _profile(c: Client, email: str) -> dict:
    prof = c.select("profiles", {"select": "user_id,display_name,email", "email": f"eq.{email}"})
    if not prof:
        sys.exit(f"no profile with email {email}")
    return prof[0]


def _grant(c: Client, user_id: str, names: list[str]) -> None:
    for name in names:
        p = _project(c, name)
        c.insert("project_members", [{"project_id": p["id"], "user_id": user_id}], upsert=True)
        print(f"  granted {name}")


def cmd_invite(c: Client, a):
    user = c.invite_user(a.email, a.name, redirect_to=APP_URL)
    uid = user["id"]
    c.insert("profiles", [{"user_id": uid, "display_name": a.name, "email": a.email, "role": a.role, "active": True}], upsert=True)
    print(f"invited {a.role} {a.name} <{a.email}> user_id {uid}; they set their password from the e-mail link")
    if a.projects:
        _grant(c, uid, [x.strip() for x in a.projects.split(",") if x.strip()])


def cmd_grant(c: Client, a):
    prof = _profile(c, a.email)
    print(f"{prof['display_name']} <{a.email}>:")
    _grant(c, prof["user_id"], [x.strip() for x in a.projects.split(",") if x.strip()])


def cmd_revoke(c: Client, a):
    prof = _profile(c, a.email)
    for name in [x.strip() for x in a.projects.split(",") if x.strip()]:
        p = _project(c, name)
        r = c.delete("project_members", {"project_id": f"eq.{p['id']}", "user_id": f"eq.{prof['user_id']}"})
        print(f"  revoked {name} ({len(r)} row)")


def cmd_members(c: Client, a):
    p = _project(c, a.project)
    profiles = {x["user_id"]: x for x in c.select("profiles", {"select": "user_id,display_name,email,active"})}
    for m in c.select("project_members", {"select": "user_id,granted_at,training_done_at", "project_id": f"eq.{p['id']}", "order": "granted_at"}):
        pr = profiles.get(m["user_id"], {})
        print(f"  {pr.get('display_name', '?'):24s} {pr.get('email', ''):32s} granted {m['granted_at'][:10]}  "
              f"training {'done ' + m['training_done_at'][:10] if m['training_done_at'] else 'pending'}")


def cmd_reset_training(c: Client, a):
    prof = _profile(c, a.email)
    p = _project(c, a.project)
    c.delete("training_answers", {"project_id": f"eq.{p['id']}", "user_id": f"eq.{prof['user_id']}"})
    c.update("project_members", {"project_id": f"eq.{p['id']}", "user_id": f"eq.{prof['user_id']}"}, {"training_done_at": None})
    print(f"training reset for {prof['display_name']} in {p['name']}")


def cmd_import_training(c: Client, a):
    p = _project(c, a.project)
    spec = json.load(open(a.items, encoding="utf-8"))
    items = spec["items"] if isinstance(spec, dict) else spec
    if a.replace:
        c.delete("items", {"project_id": f"eq.{p['id']}", "is_training": "eq.true"})
    existing = c.select("items", {"select": "seq", "project_id": f"eq.{p['id']}", "order": "seq.desc", "limit": "1"})
    base = (existing[0]["seq"] + 1) if existing else 0
    rows = [{"project_id": p["id"], "external_id": it["external_id"], "display": it["display"], "hidden": it.get("hidden"),
             "is_training": True, "gold_values": it.get("gold_values"), "explanation": it.get("explanation"),
             "seq": base + i} for i, it in enumerate(items)]
    c.insert("items", rows)
    print(f"added {len(rows)} training items to {p['name']} (seq {base}..{base + len(rows) - 1})")


def cmd_set_instructions(c: Client, a):
    p = _project(c, a.project)
    c.update("projects", {"id": f"eq.{p['id']}"}, {"instructions_text": Path(a.file).read_text(encoding="utf-8")})
    print(f"instructions set for {p['name']} ({len(Path(a.file).read_text(encoding='utf-8'))} chars)")


def cmd_sync_exports(c: Client, a):
    out_dir = Path(a.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    for p in c.select("projects", {"select": "id,name", "order": "created_at"}):
        class A:
            project = p["name"]
            out = str(out_dir / f"prism_export_{p['name']}.csv")
        cmd_export(c, A)
        profiles = {x["user_id"]: x for x in c.select("profiles", {"select": "user_id,display_name,email"})}
        items = {i["id"]: i for i in c.select("items", {"select": "id,external_id", "project_id": f"eq.{p['id']}"})}
        tr = c.select("training_answers", {"select": "user_id,item_id,answers,matches_key,answered_at", "project_id": f"eq.{p['id']}", "order": "answered_at"})
        with open(out_dir / f"prism_training_{p['name']}.csv", "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["project", "coder", "coder_email", "external_id", "answers_json", "matches_key", "answered_at"])
            for x in tr:
                w.writerow([p["name"], profiles.get(x["user_id"], {}).get("display_name"), profiles.get(x["user_id"], {}).get("email"),
                            items.get(x["item_id"], {}).get("external_id"), json.dumps(x["answers"]), x["matches_key"], x["answered_at"]])
        tpath = out_dir / f"prism_training_{p['name']}.csv"
        print(f"wrote {tpath} ({len(tr)} training answers)")


def _project(c: Client, name: str) -> dict:
    p = c.select("projects", {"select": "*", "name": f"eq.{name}"})
    if not p:
        sys.exit(f"no project named {name}")
    return p[0]


def cmd_status(c: Client, a):
    projects = c.select("projects", {"select": "id,name,status,target_coverage,calibration_n", "order": "created_at"})
    if a.project:
        projects = [p for p in projects if p["name"] == a.project]
    profiles = {p["user_id"]: p for p in c.select("profiles", {"select": "user_id,display_name,email"})}
    for p in projects:
        items = c.select("items", {"select": "id,seq,is_training", "project_id": f"eq.{p['id']}"})
        ids = {i["id"] for i in items if not i.get("is_training")}   # the histogram covers the pool only
        assigns = [x for x in c.select("assignments", {"select": "item_id,coder_id,status,claimed_at,expires_at"}) if x["item_id"] in ids]
        done = {}
        for x in assigns:
            if x["status"] == "done":
                done[x["item_id"]] = done.get(x["item_id"], 0) + 1
        hist = {}
        for i in ids:
            hist[done.get(i, 0)] = hist.get(done.get(i, 0), 0) + 1
        n_train = sum(1 for i in items if i.get("is_training"))
        members = c.select("project_members", {"select": "user_id,training_done_at", "project_id": f"eq.{p['id']}"})
        print(f"\n{p['name']} [{p['status']}] items {len(ids) - n_train} (+{n_train} training), target {p['target_coverage']}, "
              f"calibration {p['calibration_n']}, members {len(members)} ({sum(1 for m in members if m['training_done_at'])} trained)")
        print("  items by number of completed annotations: " + ", ".join(f"{k}: {v}" for k, v in sorted(hist.items())))
        sessions = [s for s in c.select("sessions", {"select": "coder_id,active_seconds,project_id"}) if s["project_id"] == p["id"]]
        for uid, prof in profiles.items():
            n_done = sum(1 for x in assigns if x["coder_id"] == uid and x["status"] == "done")
            n_skip = sum(1 for x in assigns if x["coder_id"] == uid and x["status"] == "skipped")
            secs = sum(s["active_seconds"] for s in sessions if s["coder_id"] == uid)
            if n_done or n_skip or secs:
                print(f"  {prof['display_name']:24s} done {n_done:4d}  skipped {n_skip:3d}  active {secs / 3600:.2f} h")


def cmd_export(c: Client, a):
    p = _project(c, a.project)
    items = {i["id"]: i for i in c.select("items", {"select": "id,external_id,seq,display,hidden,is_gold", "project_id": f"eq.{p['id']}", "is_training": "eq.false"})}
    profiles = {x["user_id"]: x for x in c.select("profiles", {"select": "user_id,display_name,email"})}
    assigns = {x["id"]: x for x in c.select("assignments", {"select": "id,item_id,coder_id,status,claimed_at,expires_at,skip_reason"}) if x["item_id"] in items}
    anns = [n for n in c.select("annotations", {"select": "*"}) if n["assignment_id"] in assigns]
    keys = [f["key"] for f in p["form_spec"]]
    hidden_keys = sorted({k for i in items.values() for k in (i.get("hidden") or {})})
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["project", "external_id", "seq", "coder", "coder_email", "status", "claimed_at", "submitted_at", "time_spent_s",
                    "confidence", "notes", "values_json", "revised_values_json", "revised_at"] + [f"v_{k}" for k in keys] + [f"h_{k}" for k in hidden_keys])
        rows = 0
        for asg in assigns.values():
            it = items[asg["item_id"]]
            prof = profiles.get(asg["coder_id"], {})
            n = next((x for x in anns if x["assignment_id"] == asg["id"]), None)
            vals = (n or {}).get("revised_answers") or (n or {}).get("answers") or {}
            if asg["status"] == "claimed":
                continue
            w.writerow([p["name"], it["external_id"], it["seq"], prof.get("display_name"), prof.get("email"), asg["status"], asg["claimed_at"],
                        (n or {}).get("submitted_at"), (n or {}).get("time_spent_s"), (n or {}).get("confidence"),
                        (n or {}).get("notes") if n else asg.get("skip_reason"), json.dumps((n or {}).get("answers")), json.dumps((n or {}).get("revised_answers")),
                        (n or {}).get("revised_at")] + [json.dumps(vals.get(k)) if isinstance(vals.get(k), (list, dict)) else vals.get(k) for k in keys]
                       + [(it.get("hidden") or {}).get(k) for k in hidden_keys])
            rows += 1
    print(f"wrote {out} ({rows} rows: done + skipped assignments; hidden fields included - treat like a KEY file)")


def cmd_set_status(c: Client, a, status: str):
    p = _project(c, a.project)
    c.update("projects", {"id": f"eq.{p['id']}"}, {"status": status})
    print(f"{p['name']} -> {status}")


def cmd_delete_project(c: Client, a):
    if not a.yes:
        sys.exit("add --yes to confirm")
    p = _project(c, a.project)
    c.delete("projects", {"id": f"eq.{p['id']}"})
    print(f"deleted project {p['name']} and its items/assignments/annotations")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("create-coder"); s.add_argument("--email", required=True); s.add_argument("--name", required=True)
    s.add_argument("--role", default="coder", choices=["coder", "admin"]); s.add_argument("--password", default=None)
    sub.add_parser("list-coders")
    s = sub.add_parser("set-password"); s.add_argument("--email", required=True); s.add_argument("--password", default=None)
    s = sub.add_parser("deactivate"); s.add_argument("--email", required=True)
    s = sub.add_parser("import"); s.add_argument("--items", required=True); s.add_argument("--calibration-n", type=int, default=None)
    s.add_argument("--rubric-text", default=None); s.add_argument("--instructions-text", default=None); s.add_argument("--replace", action="store_true")
    s = sub.add_parser("invite"); s.add_argument("--email", required=True); s.add_argument("--name", required=True)
    s.add_argument("--role", default="coder", choices=["coder", "admin"]); s.add_argument("--projects", default="")
    s = sub.add_parser("grant"); s.add_argument("--email", required=True); s.add_argument("--projects", required=True)
    s = sub.add_parser("revoke"); s.add_argument("--email", required=True); s.add_argument("--projects", required=True)
    s = sub.add_parser("members"); s.add_argument("--project", required=True)
    s = sub.add_parser("reset-training"); s.add_argument("--email", required=True); s.add_argument("--project", required=True)
    s = sub.add_parser("import-training"); s.add_argument("--project", required=True); s.add_argument("--items", required=True); s.add_argument("--replace", action="store_true")
    s = sub.add_parser("set-instructions"); s.add_argument("--project", required=True); s.add_argument("--file", required=True)
    s = sub.add_parser("sync-exports"); s.add_argument("--out-dir", required=True)
    s = sub.add_parser("status"); s.add_argument("--project", default=None)
    s = sub.add_parser("export"); s.add_argument("--project", required=True); s.add_argument("--out", required=True)
    s = sub.add_parser("close"); s.add_argument("--project", required=True)
    s = sub.add_parser("reopen"); s.add_argument("--project", required=True)
    s = sub.add_parser("delete-project"); s.add_argument("--project", required=True); s.add_argument("--yes", action="store_true")
    a = ap.parse_args()
    c = Client(load_env())
    {"create-coder": cmd_create_coder, "list-coders": cmd_list_coders, "set-password": cmd_set_password, "deactivate": cmd_deactivate, "import": cmd_import,
     "status": cmd_status, "export": cmd_export, "close": lambda c, a: cmd_set_status(c, a, "closed"),
     "reopen": lambda c, a: cmd_set_status(c, a, "open"), "delete-project": cmd_delete_project, "invite": cmd_invite,
     "grant": cmd_grant, "revoke": cmd_revoke, "members": cmd_members, "reset-training": cmd_reset_training,
     "import-training": cmd_import_training, "set-instructions": cmd_set_instructions, "sync-exports": cmd_sync_exports}[a.cmd](c, a)


if __name__ == "__main__":
    main()
