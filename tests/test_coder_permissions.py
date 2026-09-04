#!/usr/bin/env python3
"""
Security test: log in as a coder (publishable key + email/password) and verify that row-level security hides what it
must hide. Needs two coder accounts created with `prism_admin.py create-coder` and, in .env:
    SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, TEST_CODER1_EMAIL, TEST_CODER1_PASSWORD, TEST_CODER2_EMAIL, TEST_CODER2_PASSWORD
and at least one open project with items; coder 1 must be a member of it (v1.1 roster), coder 2 should NOT be (to test the
membership check). Standard library only.  Exit 1 on any failure.
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "admin"))
from prism_admin import load_env  # noqa: E402


class Coder:
    def __init__(self, url, key, email, password):
        self.url, self.key = url.rstrip("/"), key
        tok = self._raw("POST", "/auth/v1/token?grant_type=password", {"email": email, "password": password})
        if "access_token" not in tok:
            sys.exit(f"login failed for {email}: {tok}")
        self.jwt, self.uid = tok["access_token"], tok["user"]["id"]

    def _raw(self, method, path, body=None, jwt=None, params=None):
        url = self.url + path + (("&" if "?" in path else "?") + urllib.parse.urlencode(params) if params else "")
        req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, method=method)
        req.add_header("apikey", self.key)
        req.add_header("Authorization", f"Bearer {jwt or self.key}")
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                t = r.read().decode()
                return json.loads(t) if t.strip() else None
        except urllib.error.HTTPError as e:
            return {"_http": e.code, "_body": e.read().decode()[:300]}

    def get(self, table, params=None):
        return self._raw("GET", f"/rest/v1/{table}", jwt=self.jwt, params=params)

    def post(self, table, body):
        return self._raw("POST", f"/rest/v1/{table}", body=body, jwt=self.jwt)

    def rpc(self, fn, body):
        return self._raw("POST", f"/rest/v1/rpc/{fn}", body=body, jwt=self.jwt)


def main() -> None:
    env = load_env()
    for k in ("SUPABASE_PUBLISHABLE_KEY", "TEST_CODER1_EMAIL", "TEST_CODER1_PASSWORD", "TEST_CODER2_EMAIL", "TEST_CODER2_PASSWORD"):
        if not env.get(k):
            sys.exit(f"{k} missing in .env")
    c1 = Coder(env["SUPABASE_URL"], env["SUPABASE_PUBLISHABLE_KEY"], env["TEST_CODER1_EMAIL"], env["TEST_CODER1_PASSWORD"])
    c2 = Coder(env["SUPABASE_URL"], env["SUPABASE_PUBLISHABLE_KEY"], env["TEST_CODER2_EMAIL"], env["TEST_CODER2_PASSWORD"])
    fails = []

    def check(name, ok, detail=""):
        print(f"  {'OK  ' if ok else 'FAIL'} {name} {detail}")
        if not ok:
            fails.append(name)

    projects = c1.get("projects", {"select": "id,name,status", "status": "eq.open"})
    check("coder can list open projects", isinstance(projects, list) and len(projects) > 0, str(projects)[:120])
    pid = projects[0]["id"] if isinstance(projects, list) and projects else None

    items = c1.get("items", {"select": "id,hidden", "limit": "5"})
    check("coder CANNOT read items (hidden) directly", items == [] or (isinstance(items, dict) and items.get("_http") in (401, 403)), str(items)[:120])

    # v1.1: membership + training gate.  A non-member must be refused; then complete the training items (if any).
    outsider = c2.rpc("claim_next_item", {"p_project": pid})
    members = c2.get("project_members", {"select": "project_id"})
    if isinstance(members, list) and not any(m["project_id"] == pid for m in members):
        check("non-member CANNOT claim", isinstance(outsider, dict) and outsider.get("_http") in (400, 401, 403), str(outsider)[:120])
    tr = c1.rpc("training_items", {"p_project": pid})
    if isinstance(tr, list) and tr:
        for it in tr:
            if not it.get("answered"):
                res = c1.rpc("training_check", {"p_item": it["item_id"], "p_values": {"is_synesthesia": "U"}})
                check(f"training feedback for {it['external_id']} hides nothing but the key", isinstance(res, list) and "gold_values" in res[0], str(res)[:100])
        done = c1.rpc("training_complete", {"p_project": pid})
        check("training_complete accepted", isinstance(done, str), str(done)[:80])
    claim = c1.rpc("claim_next_item", {"p_project": pid})
    row = claim[0] if isinstance(claim, list) and claim else None
    check("coder can claim an item through the function", row is not None and "display" in row and "hidden" not in row, str(claim)[:160])

    forged = c1.post("assignments", {"item_id": row["item_id"] if row else "00000000-0000-0000-0000-000000000000", "coder_id": c2.uid})
    check("coder CANNOT insert an assignment directly", isinstance(forged, dict) and forged.get("_http") in (401, 403), str(forged)[:120])

    own = c1.get("assignments", {"select": "id,coder_id"})
    check("coder sees only own assignments", isinstance(own, list) and all(a["coder_id"] == c1.uid for a in own), str(own)[:120])

    if row:
        sub = c1.rpc("submit_annotation", {"p_assignment": row["assignment_id"], "p_values": {"is_synesthesia": "U", "notes": "permission test"},
                                           "p_confidence": 1, "p_notes": "permission test", "p_time_spent_s": 3})
        check("coder can submit an annotation for own assignment", isinstance(sub, str), str(sub)[:120])
        other = c2.get("annotations", {"select": "id,assignment_id"})
        check("other coder CANNOT see that annotation", isinstance(other, list) and all(a["assignment_id"] != row["assignment_id"] for a in other), str(other)[:120])
        again = c2.rpc("submit_annotation", {"p_assignment": row["assignment_id"], "p_values": {}, "p_confidence": 1, "p_notes": "x", "p_time_spent_s": 1})
        check("other coder CANNOT submit for someone else's assignment", isinstance(again, dict) and again.get("_http") in (400, 401, 403), str(again)[:120])

    prof = c1.get("profiles", {"select": "user_id,role"})
    check("coder sees only own profile", isinstance(prof, list) and len(prof) == 1 and prof[0]["user_id"] == c1.uid, str(prof)[:120])
    stats = c1.rpc("admin_project_stats", {})
    check("admin stats are empty for a coder", stats == [] or (isinstance(stats, dict) and stats.get("_http") in (401, 403)), str(stats)[:120])
    prog = c1.rpc("my_progress", {})
    check("my_progress works for a coder", isinstance(prog, list), str(prog)[:120])
    print("ALL OK" if not fails else f"FAILED: {fails}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
