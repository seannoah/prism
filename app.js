/* PRISM v1.1 client: invite/recovery password set-up, project launcher (roster), instructions + training gate,
   pull-based coding queue with active-time tracking, progress/revisit, admin table. No build step. */
(function () {
  const cfg = window.PRISM_CONFIG;
  const initialHash = location.hash || "";
  const needPassword = /type=(invite|recovery|signup)/.test(initialHash);
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey);
  const $ = (id) => document.getElementById(id);
  const state = { user: null, profile: null, projects: [], project: null, item: null, spec: [], training: [], tIndex: 0,
                  itemSeconds: 0, sessionSeconds: 0, sessionId: null, sessionProject: null, lastActivity: Date.now(),
                  ticking: null, heartbeat: null, needPassword };

  // ---------------------------------------------------------------- helpers
  const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const md = (t) => esc(t).replace(/^## (.*)$/gm, "<h2>$1</h2>").replace(/^# (.*)$/gm, "<h2>$1</h2>")
                          .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>");
  function show(screen) {
    document.querySelectorAll(".screen").forEach((s) => (s.hidden = true));
    $(`screen-${screen}`).hidden = false;
    document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("active", a.getAttribute("href") === `#${screen}`));
  }
  function parseRoute() {
    const h = (location.hash || "#home").slice(1);
    if (h.includes("=")) return { screen: "home", arg: null };   // auth tokens in the hash
    const [screen, arg] = h.split("/");
    return { screen: screen || "home", arg: arg || null };
  }
  async function route() {
    if (!state.user) return show("login");
    if (state.needPassword) return show("setpw");
    const { screen, arg } = parseRoute();
    if (screen === "admin" && state.profile?.role !== "admin") { location.hash = "#home"; return; }
    if (["start", "training", "work"].includes(screen)) {
      const p = state.projects.find((x) => x.project_id === arg);
      if (!p) { location.hash = "#home"; return; }
      state.project = p;
    }
    show(screen);
    if (screen === "home") await loadHome();
    if (screen === "start") loadStart();
    if (screen === "training") await loadTraining();
    if (screen === "work") await loadWork();
    if (screen === "progress") await loadProgress();
    if (screen === "admin") await loadAdmin();
  }
  window.addEventListener("hashchange", route);
  ["keydown", "mousedown", "mousemove", "scroll", "touchstart"].forEach((e) => document.addEventListener(e, () => (state.lastActivity = Date.now()), { passive: true }));

  // ---------------------------------------------------------------- auth
  $("login-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    $("login-error").hidden = true; $("login-info").hidden = true;
    const { error } = await sb.auth.signInWithPassword({ email: $("login-email").value.trim(), password: $("login-password").value });
    if (error) { $("login-error").textContent = error.message; $("login-error").hidden = false; }
  });
  $("forgot").addEventListener("click", async () => {
    const email = $("login-email").value.trim();
    if (!email) { $("login-error").textContent = "Enter your e-mail address first."; $("login-error").hidden = false; return; }
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    $("login-error").hidden = !error; $("login-info").hidden = !!error;
    if (error) $("login-error").textContent = error.message; else $("login-info").textContent = "If that address has an account, a reset link is on its way.";
  });
  $("setpw-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const a = $("setpw-1").value, b = $("setpw-2").value;
    if (a !== b) { $("setpw-error").textContent = "The two passwords differ."; $("setpw-error").hidden = false; return; }
    const { error } = await sb.auth.updateUser({ password: a });
    if (error) { $("setpw-error").textContent = error.message; $("setpw-error").hidden = false; return; }
    state.needPassword = false;
    location.hash = "#home";
    route();
  });
  $("logout").addEventListener("click", async () => { stopTimers(); await sb.auth.signOut(); location.hash = ""; });
  sb.auth.onAuthStateChange(async (event, session) => {
    if (event === "PASSWORD_RECOVERY") state.needPassword = true;
    state.user = session?.user || null;
    if (!state.user) { state.profile = null; $("nav").hidden = true; return route(); }
    const { data } = await sb.from("profiles").select("*").eq("user_id", state.user.id).maybeSingle();
    state.profile = data;
    if (!data || !data.active) { $("login-error").textContent = "This account is not activated for PRISM."; $("login-error").hidden = false; await sb.auth.signOut(); return; }
    $("who").textContent = data.display_name;
    $("nav-admin").hidden = data.role !== "admin";
    $("nav").hidden = false;
    if (!state.needPassword && (location.hash === "" || location.hash.includes("="))) location.hash = "#home";
    await loadProjects();
    route();
  });

  // ---------------------------------------------------------------- projects (roster)
  async function loadProjects() {
    const { data, error } = await sb.rpc("my_projects");
    if (error) { console.error(error); state.projects = []; return; }
    state.projects = data || [];
    // the form spec is not part of my_projects(); fetch it for the granted projects
    if (state.projects.length) {
      const ids = state.projects.map((p) => p.project_id);
      const { data: specs } = await sb.from("projects").select("id,form_spec,rubric_url").in("id", ids);
      for (const s of specs || []) { const p = state.projects.find((x) => x.project_id === s.id); if (p) { p.form_spec = s.form_spec; p.rubric_url = s.rubric_url; } }
    }
    $("revisit-project").innerHTML = state.projects.map((p) => `<option value="${p.project_id}">${esc(p.name)}</option>`).join("");
  }
  const trainingPending = (p) => p.training_required && Number(p.n_training) > 0 && !p.training_done_at;
  async function loadHome() {
    await loadProjects();
    const box = $("project-cards");
    if (!state.projects.length) { box.innerHTML = `<p class="muted">No projects have been assigned to you yet.</p>`; return; }
    box.innerHTML = state.projects.map((p) => {
      const pend = trainingPending(p);
      const meta = `${p.n_items} items in the shared pool, each rated by ${p.target_coverage} people · you: ${p.n_done} done, ${p.n_skipped} skipped, ${fmt(Number(p.active_seconds))} active` +
                   (Number(p.n_training) ? ` · training ${p.training_done_at ? "completed" : `${p.n_training_answered}/${p.n_training} done`}` : "") +
                   (p.status !== "open" ? " · closed" : "");
      const btn = p.status !== "open" ? `<a href="#progress" class="secondary-link">Review</a>`
                : `<a href="#start/${p.project_id}"><button>${pend ? "Start (training first)" : Number(p.n_done) ? "Continue" : "Start"}</button></a>`;
      return `<div class="card"><div><h3>${esc(p.name)}</h3><div class="meta">${esc(p.description || "")}</div><div class="meta">${meta}</div></div>${btn}</div>`;
    }).join("");
  }

  // ---------------------------------------------------------------- start screen (instructions)
  function loadStart() {
    const p = state.project;
    $("start-title").textContent = p.name;
    $("start-summary").textContent = `${p.n_items} items in a pool shared by all coders; each item is rated by ${p.target_coverage} people, ` +
      `so you will see a share of them, handed out one at a time` +
      (Number(p.calibration_n) ? `. The first ${p.calibration_n} (the calibration block) are the same for everyone` : "") +
      (Number(p.n_training) ? `. ${p.n_training} training items with feedback come first.` : ".");
    $("start-instructions").innerHTML = md(p.instructions_text || p.rubric_text || "No instructions have been added to this project yet.");
    const pend = trainingPending(p);
    $("start-training").hidden = !pend;
    $("start-coding").hidden = pend;
    $("start-training").textContent = Number(p.n_training_answered) ? "Continue the training items" : "Begin the training items";
  }
  $("start-training").addEventListener("click", () => (location.hash = `#training/${state.project.project_id}`));
  $("start-coding").addEventListener("click", () => (location.hash = `#work/${state.project.project_id}`));

  // ---------------------------------------------------------------- training loop
  async function loadTraining() {
    const { data, error } = await sb.rpc("training_items", { p_project: state.project.project_id });
    if (error) { $("training-error").textContent = error.message; $("training-error").hidden = false; return; }
    state.training = data || [];
    state.tIndex = state.training.findIndex((t) => !t.answered);
    if (state.tIndex < 0) return finishTraining();
    showTrainingItem();
  }
  function wireToggle(btnId, boxId, label, text) {
    const btn = $(btnId), box = $(boxId);
    btn.hidden = !text;
    box.innerHTML = md(text || "");
    btn.onclick = () => { box.hidden = !box.hidden; btn.textContent = (box.hidden ? "Show " : "Hide ") + label; };
  }
  function showTrainingItem() {
    const t = state.training[state.tIndex];
    wireToggle("training-rubric-toggle", "training-rubric", "rubric", state.project.rubric_text);
    wireToggle("training-instr-toggle", "training-instr", "instructions", state.project.instructions_text);
    $("training-label").textContent = `Training item ${state.tIndex + 1} of ${state.training.length} · ${state.project.name}`;
    $("training-text").textContent = t.display?.text || "";
    $("training-context").hidden = !t.display?.context; $("training-context").textContent = t.display?.context || "";
    renderForm(state.project.form_spec || [], null, $("training-form"));
    $("training-feedback").hidden = true; $("training-next").hidden = true; $("training-check").hidden = false; $("training-error").hidden = true;
    window.scrollTo({ top: 0 });
  }
  $("training-check").addEventListener("click", async (ev) => {
    ev.preventDefault();
    const values = readValues($("training-form"));
    const err = validate(values, $("training-form"));
    if (err) { $("training-error").textContent = err; $("training-error").hidden = false; return; }
    const t = state.training[state.tIndex];
    const { data, error } = await sb.rpc("training_check", { p_item: t.item_id, p_values: values });
    if (error) { $("training-error").textContent = error.message; $("training-error").hidden = false; return; }
    const r = Array.isArray(data) ? data[0] : data;
    const gold = r?.gold_values || {};
    const goldTxt = Object.entries(gold).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join("; ") : v}`).join("   ");
    const fb = $("training-feedback");
    fb.classList.toggle("miss", r && r.matches_key === false);
    fb.innerHTML = `<strong>${r?.matches_key === false ? "Different from the key." : r?.matches_key ? "Matches the key." : "Recorded."}</strong>\n` +
                   `Expected: ${esc(goldTxt)}\n\n${esc(r?.explanation || "")}`;
    fb.hidden = false; $("training-check").hidden = true; $("training-next").hidden = false;
    t.answered = true;
  });
  $("training-next").addEventListener("click", (ev) => {
    ev.preventDefault();
    state.tIndex = state.training.findIndex((t, i) => i > state.tIndex && !t.answered);
    if (state.tIndex < 0) state.tIndex = state.training.findIndex((t) => !t.answered);
    if (state.tIndex < 0) return finishTraining();
    showTrainingItem();
  });
  async function finishTraining() {
    const { error } = await sb.rpc("training_complete", { p_project: state.project.project_id });
    if (error) { $("training-error").textContent = error.message; $("training-error").hidden = false; return; }
    await loadProjects();
    location.hash = `#work/${state.project.project_id}`;
  }

  // ---------------------------------------------------------------- work screen
  async function loadWork() {
    const p = state.project;
    if (trainingPending(p)) { location.hash = `#start/${p.project_id}`; return; }
    $("work-project").textContent = p.name;
    wireToggle("rubric-toggle", "rubric", "rubric", p.rubric_text || (p.rubric_url ? `Rubric: ${p.rubric_url}` : ""));
    wireToggle("instr-toggle", "instr", "instructions", p.instructions_text);
    await startSession(p.project_id);
    await claimNext();
  }
  async function claimNext() {
    $("item").hidden = true; $("pool-empty").hidden = true; $("form-error").hidden = true;
    $("item-status").textContent = "Fetching the next item…";
    const { data, error } = await sb.rpc("claim_next_item", { p_project: state.project.project_id });
    if (error) { $("item-status").textContent = `Could not fetch an item: ${error.message}`; return; }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) { $("item-status").textContent = ""; $("pool-empty").hidden = false; state.item = null; stopItemTimer(); return; }
    state.item = row;
    $("item-status").textContent = "";
    $("item-label").textContent = row.is_calibration ? `Calibration item ${row.seq + 1} of ${row.calibration_n} · ${row.external_id}` : `Item ${row.external_id}`;
    $("item-text").textContent = row.display?.text || "";
    const ctx = row.display?.context;
    $("item-context").hidden = !ctx; $("item-context").textContent = ctx || "";
    renderForm(state.project.form_spec || [], null, $("annotation-form"));
    $("item").hidden = false;
    startItemTimer();
    window.scrollTo({ top: 0 });
  }

  // ---------------------------------------------------------------- generic form rendering
  function renderForm(spec, values, form) {
    form.dataset.spec = JSON.stringify(spec);
    form.innerHTML = spec.map((fld) => {
      const req = fld.required ? " req" : "";
      const v = values ? values[fld.key] : undefined;
      const name = `${form.id}_${fld.key}`;
      if (fld.type === "choice") {
        return `<fieldset data-key="${esc(fld.key)}"><legend class="${req.trim()}">${esc(fld.label)}</legend>` +
          (fld.options || []).map((o) => `<label class="opt"><input type="radio" name="${esc(name)}" value="${esc(o)}" ${v === o ? "checked" : ""}>${esc(o)}</label>`).join("") + `</fieldset>`;
      }
      if (fld.type === "multi") {
        return `<fieldset data-key="${esc(fld.key)}"><legend class="${req.trim()}">${esc(fld.label)}</legend>` +
          (fld.options || []).map((o) => `<label class="opt"><input type="checkbox" name="${esc(name)}" value="${esc(o)}" ${Array.isArray(v) && v.includes(o) ? "checked" : ""}>${esc(o)}</label>`).join("") + `</fieldset>`;
      }
      if (fld.type === "int") {
        return `<fieldset data-key="${esc(fld.key)}"><legend class="${req.trim()}">${esc(fld.label)}</legend><input type="number" name="${esc(name)}" min="${fld.min ?? ""}" max="${fld.max ?? ""}" step="1" value="${v ?? ""}" style="max-width:120px"></fieldset>`;
      }
      return `<fieldset data-key="${esc(fld.key)}"><legend class="${req.trim()}">${esc(fld.label)}</legend><textarea name="${esc(name)}">${esc(v ?? "")}</textarea></fieldset>`;
    }).join("");
    const apply = () => applyShowIf(form);
    form.onchange = apply; form.oninput = apply;
    apply();
  }
  function readValues(form, includeHidden = false) {
    const spec = JSON.parse(form.dataset.spec || "[]");
    const out = {};
    for (const fld of spec) {
      const fs = form.querySelector(`fieldset[data-key="${CSS.escape(fld.key)}"]`);
      if (!fs || (!includeHidden && fs.classList.contains("hidden-field"))) continue;
      if (fld.type === "choice") { const c = fs.querySelector("input:checked"); out[fld.key] = c ? c.value : null; }
      else if (fld.type === "multi") out[fld.key] = [...fs.querySelectorAll("input:checked")].map((i) => i.value);
      else if (fld.type === "int") { const x = fs.querySelector("input").value; out[fld.key] = x === "" ? null : Number(x); }
      else out[fld.key] = fs.querySelector("textarea").value.trim();
    }
    return out;
  }
  function applyShowIf(form) {
    const spec = JSON.parse(form.dataset.spec || "[]");
    const vals = readValues(form, true);
    for (const fld of spec) {
      const fs = form.querySelector(`fieldset[data-key="${CSS.escape(fld.key)}"]`);
      if (!fs || !fld.show_if) continue;
      const ok = Object.entries(fld.show_if).every(([k, allowed]) => { const v = vals[k]; return Array.isArray(v) ? v.some((x) => allowed.includes(x)) : allowed.includes(v); });
      fs.classList.toggle("hidden-field", !ok);
    }
  }
  function validate(values, form) {
    const spec = JSON.parse(form.dataset.spec || "[]");
    for (const fld of spec) {
      const fs = form.querySelector(`fieldset[data-key="${CSS.escape(fld.key)}"]`);
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
    const form = $("annotation-form");
    const values = readValues(form);
    const err = validate(values, form);
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
    if (state.sessionId && state.sessionProject === pid) return;
    stopTimers();
    const { data } = await sb.rpc("heartbeat", { p_session: null, p_project: pid, p_active_seconds: 0 });
    state.sessionId = data || null; state.sessionProject = pid; state.sessionSeconds = 0;
    state.heartbeat = setInterval(() => { if (state.sessionId) sb.rpc("heartbeat", { p_session: state.sessionId, p_project: pid, p_active_seconds: state.sessionSeconds }); }, cfg.heartbeatSeconds * 1000);
  }
  function stopTimers() { stopItemTimer(); if (state.heartbeat) clearInterval(state.heartbeat); state.heartbeat = null; state.sessionId = null; state.sessionProject = null; state.sessionSeconds = 0; }
  window.addEventListener("beforeunload", () => { if (state.sessionId) sb.rpc("heartbeat", { p_session: state.sessionId, p_project: state.sessionProject, p_active_seconds: state.sessionSeconds }); });

  // ---------------------------------------------------------------- progress + revisit
  async function loadProgress() {
    const { data, error } = await sb.rpc("my_progress");
    const tb = $("progress-table").querySelector("tbody");
    if (error) { tb.innerHTML = `<tr><td colspan="6" class="error">${esc(error.message)}</td></tr>`; return; }
    tb.innerHTML = (data || []).map((r) => `<tr><td>${esc(r.project_name)}</td><td>${esc(r.status)}</td><td>${r.n_done}</td><td>${r.n_skipped}</td><td>${fmt(Number(r.active_seconds))}</td><td>${r.n_items}</td></tr>`).join("") || `<tr><td colspan="6" class="muted">Nothing yet.</td></tr>`;
    loadRevisit();
  }
  $("revisit-project").addEventListener("change", loadRevisit);
  async function loadRevisit() {
    const pid = $("revisit-project").value;
    const project = state.projects.find((p) => p.project_id === pid);
    const box = $("revisit-list");
    if (!project) { box.innerHTML = ""; return; }
    const { data, error } = await sb.rpc("my_recent_annotations", { p_project: pid, p_n: 20 });
    if (error) { box.innerHTML = `<p class="error">${esc(error.message)}</p>`; return; }
    if (!data?.length) { box.innerHTML = `<p class="muted">No answers in this project yet.</p>`; return; }
    box.innerHTML = data.map((a) => {
      const v = a.revised_answers || a.answers;
      return `<div class="revisit" data-id="${a.annotation_id}"><div><strong>${esc(a.external_id)}</strong> · ${new Date(a.submitted_at).toLocaleString()}${a.revised_at ? " · revised" : ""}</div>` +
        `<div class="snippet">${esc((a.display?.text || "").slice(0, 240))}${(a.display?.text || "").length > 240 ? "…" : ""}</div>` +
        `<div class="snippet">Answer: ${esc(JSON.stringify(v))}</div>` +
        (project.status === "open" ? `<button class="link revise" data-id="${a.annotation_id}">Edit this answer</button><div class="edit" hidden></div>` : "") + `</div>`;
    }).join("");
    box.querySelectorAll("button.revise").forEach((b) => b.addEventListener("click", () => openRevise(project, data.find((x) => x.annotation_id === b.dataset.id), b.parentElement.querySelector(".edit"))));
  }
  function openRevise(project, ann, holder) {
    holder.hidden = false;
    holder.innerHTML = `<form id="revise-${ann.annotation_id}"></form><button class="save">Save revision</button> <button class="secondary cancel">Cancel</button><p class="error" hidden></p>`;
    const form = holder.querySelector("form");
    renderForm(project.form_spec || [], ann.revised_answers || ann.answers, form);
    holder.querySelector(".cancel").addEventListener("click", () => (holder.hidden = true));
    holder.querySelector(".save").addEventListener("click", async () => {
      const out = readValues(form);
      const { error } = await sb.rpc("revise_annotation", { p_annotation: ann.annotation_id, p_values: out, p_confidence: Number.isInteger(out.confidence) ? out.confidence : null, p_notes: out.notes || null });
      const err = holder.querySelector(".error");
      if (error) { err.textContent = error.message; err.hidden = false; return; }
      loadRevisit();
    });
  }

  // ---------------------------------------------------------------- admin dashboard (v1.2)
  const adm = { overview: [], coders: [], tab: "projects" };
  document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => {
    adm.tab = b.dataset.tab;
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".tabpane").forEach((p) => (p.hidden = p.id !== `admin-${adm.tab}`));
    if (adm.tab === "calibration") loadCalibration();
  }));
  function adminMsg(text, isErr) { const m = $("admin-msg"); m.textContent = text; m.hidden = !text; m.className = isErr ? "error" : "muted"; }
  async function adminCall(fn, args, okText) {
    const { error } = await sb.rpc(fn, args);
    if (error) return adminMsg(error.message, true);
    adminMsg(okText || "Saved.");
    await loadAdmin();
  }
  async function loadAdmin() {
    const [ov, co] = await Promise.all([sb.rpc("admin_overview"), sb.rpc("admin_coders")]);
    if (ov.error || co.error) { $("admin-projects").innerHTML = `<p class="error">${esc((ov.error || co.error).message)} — has migration 003 been run?</p>`; return; }
    adm.overview = ov.data || []; adm.coders = co.data || [];
    renderAdminProjects(); renderAdminRAs(); renderAdminAccess();
    $("cal-project").innerHTML = adm.overview.map((p) => `<option value="${p.project_id}">${esc(p.name)}</option>`).join("");
    if (adm.tab === "calibration") loadCalibration();
  }
  function bar(done, total, cls) { const pct = total ? Math.round(100 * done / total) : 0; return `<span class="bar"><span class="${cls || ""}" style="width:${pct}%"></span></span> <span class="small">${done}/${total} (${pct}%)</span>`; }
  function renderAdminProjects() {
    const box = $("admin-projects");
    if (!adm.overview.length) { box.innerHTML = `<p class="muted">No projects yet.</p>`; return; }
    box.innerHTML = adm.overview.map((p) => {
      const hist = Object.entries(p.coverage_hist || {}).sort((x, y) => Number(x[0]) - Number(y[0])).map(([k, v]) => `${k}: ${v}`).join(", ");
      return `<div class="card" data-id="${p.project_id}"><div>
        <h3>${esc(p.name)} <span class="small ${p.status === "open" ? "ok" : "warn"}">${esc(p.status)}</span></h3>
        <div class="meta">${esc(p.description || "")}</div>
        <div class="meta">Items at target coverage: ${bar(Number(p.items_at_target), Number(p.n_items), Number(p.items_at_target) === Number(p.n_items) && p.n_items > 0 ? "full" : "")}</div>
        <div class="meta">Ratings done ${p.n_done} (${p.n_items} items × ${p.target_coverage} = ${Number(p.n_items) * Number(p.target_coverage)} needed) · skipped ${p.n_skipped} · open claims ${p.n_open_claims} · ${p.hours} h logged</div>
        <div class="meta">Items by number of ratings: ${esc(hist || "–")} · members ${p.n_members} (${p.n_trained} trained) · training items ${p.n_training}</div>
        <div class="meta tight">Target coverage <input type="number" min="1" max="10" value="${p.target_coverage}" data-f="target"> ·
          calibration items <input type="number" min="0" value="${p.calibration_n}" data-f="cal"> ·
          <label class="opt"><input type="checkbox" data-f="train" ${p.training_required ? "checked" : ""}> training required</label>
          <button class="secondary save-project">Save</button>
          <button class="secondary toggle-status">${p.status === "open" ? "Close project" : "Reopen"}</button></div>
      </div></div>`;
    }).join("");
    box.querySelectorAll(".save-project").forEach((b) => b.addEventListener("click", () => {
      const card = b.closest(".card");
      adminCall("admin_set_project", { p_project: card.dataset.id, p_status: null, p_target: Number(card.querySelector('[data-f="target"]').value),
                                       p_calibration: Number(card.querySelector('[data-f="cal"]').value), p_training_required: card.querySelector('[data-f="train"]').checked }, "Project settings saved.");
    }));
    box.querySelectorAll(".toggle-status").forEach((b) => b.addEventListener("click", () => {
      const card = b.closest(".card"); const p = adm.overview.find((x) => x.project_id === card.dataset.id);
      const next = p.status === "open" ? "closed" : "open";
      if (next === "closed" && !confirm(`Close ${p.name}? Coders can no longer submit or revise until it is reopened.`)) return;
      adminCall("admin_set_project", { p_project: p.project_id, p_status: next, p_target: null, p_calibration: null, p_training_required: null }, `Project ${next}.`);
    }));
  }
  function renderAdminRAs() {
    const box = $("admin-ras");
    const people = [...new Map(adm.coders.map((r) => [r.user_id, r])).values()];
    if (!people.length) { box.innerHTML = `<p class="muted">No accounts.</p>`; return; }
    const projects = adm.overview;
    let html = `<table class="small"><thead><tr><th>RA</th><th>Role</th><th>Active</th>` + projects.map((p) => `<th>${esc(p.name)}</th>`).join("") + `</tr></thead><tbody>`;
    for (const person of people) {
      html += `<tr><td>${esc(person.display_name)}<br><span class="muted">${esc(person.email || "")}</span></td><td>${esc(person.role)}</td>` +
        `<td><button class="secondary tight-btn set-active" data-user="${person.user_id}" data-active="${person.active ? 0 : 1}">${person.active ? "Deactivate" : "Activate"}</button></td>`;
      for (const p of projects) {
        const r = adm.coders.find((x) => x.user_id === person.user_id && x.project_id === p.project_id);
        if (!r || !r.member) { html += `<td class="muted">–</td>`; continue; }
        const cal = r.calibration_with_key > 0 ? ` · calibration agreement ${Math.round(100 * Number(r.calibration_agreement))}% (${r.calibration_with_key} keyed)` : (Number(r.calibration_coded) ? ` · ${r.calibration_coded} calibration items coded` : "");
        html += `<td>${r.n_done} done, ${r.n_skipped} skipped, ${r.hours} h<br><span class="muted">training ${r.training_done_at ? "done" : "pending"}${r.last_seen ? " · last " + new Date(r.last_seen).toLocaleDateString() : ""}${esc(cal)}</span>` +
                `<br><button class="link reset-training" data-user="${person.user_id}" data-project="${p.project_id}">reset training</button></td>`;
      }
      html += `</tr>`;
    }
    box.innerHTML = html + `</tbody></table>`;
    box.querySelectorAll(".set-active").forEach((b) => b.addEventListener("click", () => adminCall("admin_set_active", { p_user: b.dataset.user, p_active: b.dataset.active === "1" }, "Account updated.")));
    box.querySelectorAll(".reset-training").forEach((b) => b.addEventListener("click", () => { if (confirm("Reset this coder's training for the project?")) adminCall("admin_reset_training", { p_user: b.dataset.user, p_project: b.dataset.project }, "Training reset."); }));
  }
  function renderAdminAccess() {
    const box = $("admin-access");
    const people = [...new Map(adm.coders.map((r) => [r.user_id, r])).values()];
    const projects = adm.overview;
    if (!people.length || !projects.length) { box.innerHTML = `<p class="muted">Nothing to show yet.</p>`; return; }
    let html = `<p class="muted">Tick a box to give an RA access to a project (they then see it on their launcher); untick to remove it. Their existing answers are kept.</p>` +
      `<table class="small"><thead><tr><th>RA</th>` + projects.map((p) => `<th>${esc(p.name)}</th>`).join("") + `</tr></thead><tbody>`;
    for (const person of people) {
      html += `<tr><td>${esc(person.display_name)}</td>` + projects.map((p) => {
        const r = adm.coders.find((x) => x.user_id === person.user_id && x.project_id === p.project_id);
        return `<td><input type="checkbox" class="grant" data-user="${person.user_id}" data-project="${p.project_id}" ${r && r.member ? "checked" : ""}></td>`;
      }).join("") + `</tr>`;
    }
    box.innerHTML = html + `</tbody></table>`;
    box.querySelectorAll(".grant").forEach((cb) => cb.addEventListener("change", () =>
      adminCall(cb.checked ? "admin_grant" : "admin_revoke", { p_user: cb.dataset.user, p_project: cb.dataset.project }, cb.checked ? "Access granted." : "Access removed.")));
  }
  $("cal-project").addEventListener("change", loadCalibration);
  async function loadCalibration() {
    const pid = $("cal-project").value;
    const box = $("cal-list");
    if (!pid) { box.innerHTML = ""; return; }
    const project = adm.overview.find((p) => p.project_id === pid);
    const { data: specRow } = await sb.from("projects").select("form_spec").eq("id", pid).maybeSingle();
    const spec = specRow?.form_spec || [];
    const { data, error } = await sb.rpc("admin_calibration_items", { p_project: pid });
    if (error) { box.innerHTML = `<p class="error">${esc(error.message)}</p>`; return; }
    if (!data?.length) { box.innerHTML = `<p class="muted">This project has no calibration block (calibration items = 0).</p>`; return; }
    box.innerHTML = `<p class="muted">The first ${project.calibration_n} items of the pool, with every coder's answer. Set a key for an item to make agreement with it count in the RA table; the key is never shown to coders on real items.</p>` +
      data.map((it) => {
        const rows = (it.answers || []).map((a) => `<tr><td>${esc(a.coder)}</td><td>${esc(JSON.stringify(a.answers))}</td><td>${a.confidence ?? ""}</td><td>${esc(a.notes || "")}</td></tr>`).join("");
        return `<div class="calitem" data-id="${it.item_id}"><div><strong>${esc(it.external_id)}</strong> (item ${it.seq + 1}) ${it.gold_values ? `<span class="ok small">key set: ${esc(JSON.stringify(it.gold_values))}</span>` : `<span class="muted small">no key yet</span>`}</div>` +
          `<div class="text">${esc(it.display?.text || "")}</div>` +
          (rows ? `<table><thead><tr><th>coder</th><th>answer</th><th>conf.</th><th>notes</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="muted small">No answers yet.</p>`) +
          `<button class="link set-key">${it.gold_values ? "Change the key" : "Set the key"}</button><div class="keyform" hidden></div></div>`;
      }).join("");
    box.querySelectorAll(".set-key").forEach((b) => b.addEventListener("click", () => {
      const holder = b.parentElement.querySelector(".keyform"); const it = data.find((x) => x.item_id === b.parentElement.dataset.id);
      holder.hidden = false;
      holder.innerHTML = `<form id="key-${it.item_id}"></form><label>Explanation shown to coders in training (optional) <textarea class="expl">${esc(it.explanation || "")}</textarea></label><button class="save-key">Save key</button> <button class="secondary cancel-key">Cancel</button>`;
      renderForm(spec, it.gold_values || null, holder.querySelector("form"));
      holder.querySelector(".cancel-key").addEventListener("click", () => (holder.hidden = true));
      holder.querySelector(".save-key").addEventListener("click", async () => {
        const vals = readValues(holder.querySelector("form"));
        await adminCall("admin_set_gold", { p_item: it.item_id, p_gold: vals, p_explanation: holder.querySelector(".expl").value || null }, "Key saved.");
        loadCalibration();
      });
    }));
  }

  route();
})();
