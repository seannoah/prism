/* PRISM v1 client: login, pull-based coding queue, timers, progress, admin table.  No build step. */
(function () {
  const cfg = window.PRISM_CONFIG;
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey);
  const $ = (id) => document.getElementById(id);
  const state = { user: null, profile: null, projects: [], project: null, item: null, spec: [],
                  itemSeconds: 0, sessionSeconds: 0, sessionId: null, lastActivity: Date.now(), ticking: null, heartbeat: null };

  // ---------------------------------------------------------------- helpers
  const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function show(screen) {
    document.querySelectorAll(".screen").forEach((s) => (s.hidden = true));
    $(`screen-${screen}`).hidden = false;
    document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("active", a.getAttribute("href") === `#${screen}`));
  }
  function route() {
    const h = (location.hash || "#work").slice(1);
    if (!state.user) return show("login");
    if (h === "admin" && state.profile?.role !== "admin") return (location.hash = "#work");
    show(h);
    if (h === "progress") loadProgress();
    if (h === "admin") loadAdmin();
    if (h === "work" && !state.item) loadWork();
  }
  window.addEventListener("hashchange", route);
  ["keydown", "mousedown", "mousemove", "scroll", "touchstart"].forEach((e) => document.addEventListener(e, () => (state.lastActivity = Date.now()), { passive: true }));

  // ---------------------------------------------------------------- auth
  $("login-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    $("login-error").hidden = true;
    const { error } = await sb.auth.signInWithPassword({ email: $("login-email").value.trim(), password: $("login-password").value });
    if (error) { $("login-error").textContent = error.message; $("login-error").hidden = false; }
  });
  $("logout").addEventListener("click", async () => { stopTimers(); await sb.auth.signOut(); location.hash = ""; });
  sb.auth.onAuthStateChange(async (_event, session) => {
    state.user = session?.user || null;
    if (!state.user) { state.profile = null; $("nav").hidden = true; return route(); }
    const { data } = await sb.from("profiles").select("*").eq("user_id", state.user.id).maybeSingle();
    state.profile = data;
    if (!data || !data.active) { $("login-error").textContent = "This account is not activated for PRISM."; $("login-error").hidden = false; await sb.auth.signOut(); return; }
    $("who").textContent = data.display_name;
    $("nav-admin").hidden = data.role !== "admin";
    $("nav").hidden = false;
    await loadProjects();
    route();
  });

  // ---------------------------------------------------------------- projects
  async function loadProjects() {
    const { data, error } = await sb.from("projects").select("id,name,description,rubric_url,rubric_text,form_spec,target_coverage,calibration_n,status").order("created_at");
    if (error) return console.error(error);
    state.projects = data || [];
    for (const sel of [$("project-select"), $("revisit-project")]) {
      sel.innerHTML = state.projects.map((p) => `<option value="${p.id}">${esc(p.name)}${p.status !== "open" ? " (closed)" : ""}</option>`).join("");
    }
    const open = state.projects.find((p) => p.status === "open") || state.projects[0];
    if (open) { $("project-select").value = open.id; $("revisit-project").value = open.id; }
  }
  $("project-select").addEventListener("change", () => { state.item = null; loadWork(); });
  $("revisit-project").addEventListener("change", loadRevisit);
  $("rubric-toggle").addEventListener("click", () => { const r = $("rubric"); r.hidden = !r.hidden; $("rubric-toggle").textContent = r.hidden ? "Show rubric" : "Hide rubric"; });

  // ---------------------------------------------------------------- work screen
  async function loadWork() {
    const pid = $("project-select").value;
    state.project = state.projects.find((p) => p.id === pid);
    if (!state.project) { $("item-status").textContent = "No projects yet."; return; }
    $("rubric").textContent = state.project.rubric_text || (state.project.rubric_url ? `Rubric: ${state.project.rubric_url}` : "");
    $("rubric-toggle").hidden = !state.project.rubric_text && !state.project.rubric_url;
    startSession(pid);
    await claimNext();
  }
  async function claimNext() {
    $("item").hidden = true; $("pool-empty").hidden = true; $("form-error").hidden = true;
    $("item-status").textContent = "Fetching the next item…";
    const { data, error } = await sb.rpc("claim_next_item", { p_project: state.project.id });
    if (error) { $("item-status").textContent = `Could not fetch an item: ${error.message}`; return; }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) { $("item-status").textContent = ""; $("pool-empty").hidden = false; state.item = null; stopItemTimer(); return; }
    state.item = row;
    $("item-status").textContent = "";
    $("item-label").textContent = row.is_calibration ? `Calibration item ${row.seq + 1} of ${row.calibration_n} · ${row.external_id}` : `Item ${row.external_id}`;
    $("item-text").textContent = row.display?.text || "";
    const ctx = row.display?.context;
    $("item-context").hidden = !ctx; $("item-context").textContent = ctx || "";
    renderForm(state.project.form_spec || []);
    $("item").hidden = false;
    startItemTimer();
    window.scrollTo({ top: 0 });
  }
  function renderForm(spec, values) {
    state.spec = spec;
    const f = $("annotation-form");
    f.innerHTML = spec.map((fld) => {
      const req = fld.required ? " req" : "";
      const v = values ? values[fld.key] : undefined;
      if (fld.type === "choice") {
        return `<fieldset data-key="${esc(fld.key)}"><legend class="${req.trim()}">${esc(fld.label)}</legend>` +
          (fld.options || []).map((o) => `<label class="opt"><input type="radio" name="${esc(fld.key)}" value="${esc(o)}" ${v === o ? "checked" : ""}>${esc(o)}</label>`).join("") + `</fieldset>`;
      }
      if (fld.type === "multi") {
        return `<fieldset data-key="${esc(fld.key)}"><legend class="${req.trim()}">${esc(fld.label)}</legend>` +
          (fld.options || []).map((o) => `<label class="opt"><input type="checkbox" name="${esc(fld.key)}" value="${esc(o)}" ${Array.isArray(v) && v.includes(o) ? "checked" : ""}>${esc(o)}</label>`).join("") + `</fieldset>`;
      }
      if (fld.type === "int") {
        return `<fieldset data-key="${esc(fld.key)}"><legend class="${req.trim()}">${esc(fld.label)}</legend><input type="number" name="${esc(fld.key)}" min="${fld.min ?? ""}" max="${fld.max ?? ""}" step="1" value="${v ?? ""}" style="max-width:120px"></fieldset>`;
      }
      return `<fieldset data-key="${esc(fld.key)}"><legend class="${req.trim()}">${esc(fld.label)}</legend><textarea name="${esc(fld.key)}">${esc(v ?? "")}</textarea></fieldset>`;
    }).join("");
    f.addEventListener("change", applyShowIf);
    f.addEventListener("input", applyShowIf);
    applyShowIf();
  }
  function readValues() {
    const out = {};
    for (const fld of state.spec) {
      const fs = document.querySelector(`fieldset[data-key="${CSS.escape(fld.key)}"]`);
      if (!fs || fs.classList.contains("hidden-field")) continue;
      if (fld.type === "choice") { const c = fs.querySelector("input:checked"); out[fld.key] = c ? c.value : null; }
      else if (fld.type === "multi") out[fld.key] = [...fs.querySelectorAll("input:checked")].map((i) => i.value);
      else if (fld.type === "int") { const x = fs.querySelector("input").value; out[fld.key] = x === "" ? null : Number(x); }
      else out[fld.key] = fs.querySelector("textarea").value.trim();
    }
    return out;
  }
  function applyShowIf() {
    const vals = readValuesLoose();
    for (const fld of state.spec) {
      const fs = document.querySelector(`fieldset[data-key="${CSS.escape(fld.key)}"]`);
      if (!fs || !fld.show_if) continue;
      const ok = Object.entries(fld.show_if).every(([k, allowed]) => { const v = vals[k]; return Array.isArray(v) ? v.some((x) => allowed.includes(x)) : allowed.includes(v); });
      fs.classList.toggle("hidden-field", !ok);
    }
  }
  function readValuesLoose() {   // like readValues but ignores visibility (used to evaluate show_if)
    const out = {};
    for (const fld of state.spec) {
      const fs = document.querySelector(`fieldset[data-key="${CSS.escape(fld.key)}"]`);
      if (!fs) continue;
      if (fld.type === "choice") { const c = fs.querySelector("input:checked"); out[fld.key] = c ? c.value : null; }
      else if (fld.type === "multi") out[fld.key] = [...fs.querySelectorAll("input:checked")].map((i) => i.value);
      else if (fld.type === "int") { const x = fs.querySelector("input").value; out[fld.key] = x === "" ? null : Number(x); }
      else out[fld.key] = fs.querySelector("textarea").value.trim();
    }
    return out;
  }
  function validate(values) {
    for (const fld of state.spec) {
      const fs = document.querySelector(`fieldset[data-key="${CSS.escape(fld.key)}"]`);
      if (!fs || fs.classList.contains("hidden-field") || !fld.required) continue;
      const v = values[fld.key];
      if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) return `Please answer: ${fld.label}`;
      if (fld.type === "int" && ((fld.min != null && v < fld.min) || (fld.max != null && v > fld.max))) return `${fld.label}: must be between ${fld.min} and ${fld.max}`;
    }
    return null;
  }
  $("submit").addEventListener("click", async (ev) => {
    ev.preventDefault();
    if (!state.item) return;
    const values = readValues();
    const err = validate(values);
    if (err) { $("form-error").textContent = err; $("form-error").hidden = false; return; }
    $("submit").disabled = true;
    const conf = Number.isInteger(values.confidence) ? values.confidence : null;
    const { error } = await sb.rpc("submit_annotation", { p_assignment: state.item.assignment_id, p_values: values, p_confidence: conf,
                                                          p_notes: values.notes || null, p_time_spent_s: state.itemSeconds });
    $("submit").disabled = false;
    if (error) { $("form-error").textContent = error.message; $("form-error").hidden = false; return; }
    state.item = null;
    await claimNext();
  });
  $("skip").addEventListener("click", async (ev) => {
    ev.preventDefault();
    if (!state.item) return;
    const reason = prompt("Why are you skipping this item? (required)");
    if (!reason || !reason.trim()) return;
    const { error } = await sb.rpc("skip_item", { p_assignment: state.item.assignment_id, p_reason: reason.trim() });
    if (error) { $("form-error").textContent = error.message; $("form-error").hidden = false; return; }
    state.item = null;
    await claimNext();
  });

  // ---------------------------------------------------------------- timers (active seconds only)
  function active() { return !document.hidden && Date.now() - state.lastActivity < cfg.idleSeconds * 1000; }
  function startItemTimer() {
    state.itemSeconds = 0; $("timer").textContent = "0:00";
    if (state.ticking) clearInterval(state.ticking);
    state.ticking = setInterval(() => { if (active()) { state.itemSeconds++; state.sessionSeconds++; $("timer").textContent = fmt(state.itemSeconds); } }, 1000);
  }
  function stopItemTimer() { if (state.ticking) clearInterval(state.ticking); state.ticking = null; }
  async function startSession(pid) {
    if (state.sessionId) return;
    const { data } = await sb.rpc("heartbeat", { p_session: null, p_project: pid, p_active_seconds: 0 });
    state.sessionId = data || null;
    state.heartbeat = setInterval(() => { if (state.sessionId) sb.rpc("heartbeat", { p_session: state.sessionId, p_project: state.project?.id || null, p_active_seconds: state.sessionSeconds }); }, cfg.heartbeatSeconds * 1000);
  }
  function stopTimers() { stopItemTimer(); if (state.heartbeat) clearInterval(state.heartbeat); state.heartbeat = null; state.sessionId = null; state.sessionSeconds = 0; }
  window.addEventListener("beforeunload", () => { if (state.sessionId) sb.rpc("heartbeat", { p_session: state.sessionId, p_project: state.project?.id || null, p_active_seconds: state.sessionSeconds }); });

  // ---------------------------------------------------------------- progress + revisit
  async function loadProgress() {
    const { data, error } = await sb.rpc("my_progress");
    const tb = $("progress-table").querySelector("tbody");
    if (error) { tb.innerHTML = `<tr><td colspan="6" class="error">${esc(error.message)}</td></tr>`; return; }
    tb.innerHTML = (data || []).map((r) => `<tr><td>${esc(r.project_name)}</td><td>${esc(r.status)}</td><td>${r.n_done}</td><td>${r.n_skipped}</td><td>${fmt(Number(r.active_seconds))}</td><td>${r.n_items}</td></tr>`).join("") || `<tr><td colspan="6" class="muted">Nothing yet.</td></tr>`;
    loadRevisit();
  }
  async function loadRevisit() {
    const pid = $("revisit-project").value;
    const project = state.projects.find((p) => p.id === pid);
    const box = $("revisit-list");
    if (!project) { box.innerHTML = ""; return; }
    const { data, error } = await sb.rpc("my_recent_annotations", { p_project: pid, p_n: 20 });
    if (error) { box.innerHTML = `<p class="error">${esc(error.message)}</p>`; return; }
    if (!data?.length) { box.innerHTML = `<p class="muted">No answers in this project yet.</p>`; return; }
    box.innerHTML = data.map((a) => {
      const v = a.revised_values || a.values;
      return `<div class="revisit" data-id="${a.annotation_id}"><div><strong>${esc(a.external_id)}</strong> · ${new Date(a.submitted_at).toLocaleString()}${a.revised_at ? " · revised" : ""}</div>` +
        `<div class="snippet">${esc((a.display?.text || "").slice(0, 240))}${(a.display?.text || "").length > 240 ? "…" : ""}</div>` +
        `<div class="snippet">Answer: ${esc(JSON.stringify(v))}</div>` +
        (project.status === "open" ? `<button class="link revise" data-id="${a.annotation_id}">Edit this answer</button><div class="edit" hidden></div>` : "") + `</div>`;
    }).join("");
    box.querySelectorAll("button.revise").forEach((b) => b.addEventListener("click", () => openRevise(project, data.find((x) => x.annotation_id === b.dataset.id), b.parentElement.querySelector(".edit"))));
  }
  function openRevise(project, ann, holder) {
    holder.hidden = false;
    const values = ann.revised_values || ann.values;
    holder.innerHTML = `<form class="revise-form"></form><button class="save">Save revision</button> <button class="secondary cancel">Cancel</button><p class="error" hidden></p>`;
    const form = holder.querySelector("form");
    const saved = state.spec; const prevForm = $("annotation-form");
    // render the project's form into the holder using the same renderer
    state.spec = project.form_spec || [];
    const html = [];
    for (const fld of state.spec) {
      const v = values[fld.key];
      if (fld.type === "choice") html.push(`<fieldset data-key="${esc(fld.key)}"><legend>${esc(fld.label)}</legend>` + (fld.options || []).map((o) => `<label class="opt"><input type="radio" name="r_${esc(fld.key)}" value="${esc(o)}" ${v === o ? "checked" : ""}>${esc(o)}</label>`).join("") + `</fieldset>`);
      else if (fld.type === "multi") html.push(`<fieldset data-key="${esc(fld.key)}"><legend>${esc(fld.label)}</legend>` + (fld.options || []).map((o) => `<label class="opt"><input type="checkbox" name="r_${esc(fld.key)}" value="${esc(o)}" ${Array.isArray(v) && v.includes(o) ? "checked" : ""}>${esc(o)}</label>`).join("") + `</fieldset>`);
      else if (fld.type === "int") html.push(`<fieldset data-key="${esc(fld.key)}"><legend>${esc(fld.label)}</legend><input type="number" name="r_${esc(fld.key)}" min="${fld.min ?? ""}" max="${fld.max ?? ""}" value="${v ?? ""}" style="max-width:120px"></fieldset>`);
      else html.push(`<fieldset data-key="${esc(fld.key)}"><legend>${esc(fld.label)}</legend><textarea name="r_${esc(fld.key)}">${esc(v ?? "")}</textarea></fieldset>`);
    }
    form.innerHTML = html.join("");
    state.spec = saved;
    holder.querySelector(".cancel").addEventListener("click", () => (holder.hidden = true));
    holder.querySelector(".save").addEventListener("click", async () => {
      const out = {};
      for (const fld of project.form_spec || []) {
        const fs = form.querySelector(`fieldset[data-key="${CSS.escape(fld.key)}"]`);
        if (fld.type === "choice") { const c = fs.querySelector("input:checked"); out[fld.key] = c ? c.value : null; }
        else if (fld.type === "multi") out[fld.key] = [...fs.querySelectorAll("input:checked")].map((i) => i.value);
        else if (fld.type === "int") { const x = fs.querySelector("input").value; out[fld.key] = x === "" ? null : Number(x); }
        else out[fld.key] = fs.querySelector("textarea").value.trim();
      }
      const { error } = await sb.rpc("revise_annotation", { p_annotation: ann.annotation_id, p_values: out, p_confidence: Number.isInteger(out.confidence) ? out.confidence : null, p_notes: out.notes || null });
      const err = holder.querySelector(".error");
      if (error) { err.textContent = error.message; err.hidden = false; return; }
      loadRevisit();
    });
    void prevForm;
  }

  // ---------------------------------------------------------------- admin
  async function loadAdmin() {
    const { data, error } = await sb.rpc("admin_project_stats");
    const tb = $("admin-table").querySelector("tbody");
    if (error) { tb.innerHTML = `<tr><td colspan="10" class="error">${esc(error.message)}</td></tr>`; return; }
    tb.innerHTML = (data || []).map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.status)}</td><td>${r.n_items}</td><td>${r.target_coverage}</td><td>${r.calibration_n}</td><td>${r.n_done}</td><td>${r.n_skipped}</td><td>${r.n_open_claims}</td><td>${r.items_at_target}</td><td>${r.coders_active}</td></tr>`).join("") || `<tr><td colspan="10" class="muted">No projects.</td></tr>`;
  }

  route();
})();
