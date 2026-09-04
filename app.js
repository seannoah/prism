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

  // ---------------------------------------------------------------- admin
  async function loadAdmin() {
    const { data, error } = await sb.rpc("admin_project_stats");
    const tb = $("admin-table").querySelector("tbody");
    if (error) { tb.innerHTML = `<tr><td colspan="12" class="error">${esc(error.message)}</td></tr>`; return; }
    tb.innerHTML = (data || []).map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.status)}</td><td>${r.n_items}</td><td>${r.target_coverage}</td><td>${r.calibration_n}</td><td>${r.n_done}</td><td>${r.n_skipped}</td><td>${r.n_open_claims}</td><td>${r.items_at_target}</td><td>${r.coders_active}</td><td>${r.n_members ?? ""}</td><td>${r.n_trained ?? ""}${r.n_training ? ` (${r.n_training} items)` : ""}</td></tr>`).join("") || `<tr><td colspan="12" class="muted">No projects.</td></tr>`;
  }

  route();
})();
