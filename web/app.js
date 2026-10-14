// Smith web UI - vanilla ES module, no framework, no build step.

const app = document.getElementById("app");
const conn = document.getElementById("conn");

// ---- Session / auth ----
const SKEY = "smith.session";
function sessionToken() { return localStorage.getItem(SKEY) || ""; }
function setSession(t) { if (t) localStorage.setItem(SKEY, t); else localStorage.removeItem(SKEY); }
function authHeaders(extra) {
  const h = Object.assign({}, extra || {});
  const t = sessionToken();
  if (t) h["Authorization"] = "Bearer " + t;
  return h;
}
// For plain <a href> / EventSource URLs, where a bearer header can't be sent:
// carry the session as ?access_token= when we have one. The matching download
// routes accept it as a fallback to AuthorizedHuman (only needed under --require-login).
function dlUrl(path) {
  const t = sessionToken();
  if (!t) return path;
  return path + (path.includes("?") ? "&" : "?") + "access_token=" + encodeURIComponent(t);
}

// Auth + error handling, handing back the Response itself - for callers that need
// a response header (the log tail reports how many lines it skipped).
async function apiRes(path, opts) {
  opts = Object.assign({}, opts);
  opts.headers = authHeaders(opts.headers);
  const res = await fetch(path, opts);
  if (res.status === 401) { setSession(""); showSignIn(); throw new Error("unauthorized"); }
  if (!res.ok) throw new Error(path + " -> " + res.status);
  return res;
}

async function api(path, opts) {
  const res = await apiRes(path, opts);
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

// JSON POST through api() (auth + error handling included). `body` may be
// omitted for action endpoints that take no payload.
function apiPost(path, body) {
  return api(path, { method: "POST", headers: { "content-type": "application/json" },
                     body: body === undefined ? undefined : JSON.stringify(body) });
}

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function ago(ms) {
  if (!ms) return "—";
  const d = Math.max(0, Date.now() - ms);
  if (d < 60000) return Math.floor(d / 1000) + "s ago";
  if (d < 3600000) return Math.floor(d / 60000) + "m ago";
  return Math.floor(d / 3600000) + "h ago";
}
function dur(ms) {
  if (!ms) return "—";
  if (ms < 1000) return ms + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
  return Math.floor(ms / 60000) + "m " + Math.floor((ms % 60000) / 1000) + "s";
}
function badge(s) { return `<span class="badge ${esc(s)}">${esc(s)}</span>`; }
function terminal(s) { return ["success", "failed", "error", "lost", "cancelled", "superseded"].includes(s); }

// Stop a build from the UI. A queued build is dropped from the queue at once; a
// running one is signalled to the agent, which kills the build and reports back -
// so the answer is "cancelled" or "cancelling". Returns the new status text.
async function cancelBuild(jobId) {
  const r = await apiPost(`/api/builds/${encodeURIComponent(jobId)}/cancel`);
  return (r && r.status) || "cancelled";
}

// Shared form pieces: the target-platform <select>, the "can any online node
// build this variant" predicate, and the label+control row used by settings panels.
function platformSelect() {
  return el(`<select aria-label="Target platform" title="OS of the machine that runs this build. The rule needs a command for that OS; this does not install cross-compilation tools."><option value="">any platform</option><option value="windows">windows</option><option value="mac">mac</option><option value="linux">linux</option></select>`);
}
function variantBuildable(v, onlineOs) { return !v.os || v.os === "any" || onlineOs.has(v.os); }
const settingHelp = {
  "Cancel the running build on a newer commit": "Abort active automatic builds when a newer commit arrives. Off by default; queued automatic builds are already coalesced.",
  "Record": "Existing Cloudflare A record to keep pointed at this coordinator's public IP.",
  "Zone": "Cloudflare zone containing the DNS record.",
  "API token": "Private Cloudflare credential with DNS edit access. Leave unchanged to retain the saved token.",
  "Proxied": "Keep the DNS record proxied through Cloudflare.",
  "Check every (s)": "Interval in seconds between public-IP checks; updates only when the IP changes.",
  "Token": "GitHub credential used by agents to clone private repositories over HTTPS. Every eligible build agent receives it.",
  "Enabled": "Run the optional Discord bot when its token and dependencies are configured.",
  "Bot token": "Discord bot credential; keep it private. The bot runs on a selected build agent.",
  "Notify channel": "Discord channel ID for build result notifications.",
  "Command channels": "Comma-separated channel IDs where commands are accepted; empty allows any channel.",
  "Allow roles": "Comma-separated Discord role IDs allowed to issue commands.",
  "Allow users": "Comma-separated Discord user IDs allowed to issue commands.",
  "Ollama URL": "Ollama endpoint as reached from the bot's agent computer.",
  "Ollama model": "Model installed on the bot host; pull it with Ollama before use.",
  "Host node": "Optional agent hostname to pin the bot to; empty lets Smith choose a suitable GPU host.",
  "Confirm deploys": "Require the bot's explicit confirmation step before a deployment command.",
  "App id": "Discord application ID used to register slash commands.",
  "Guild id": "Optional Discord server ID for faster slash-command registration."
};
function settingRow(lab, ctrl) {
  const r = el(`<div class="setrow"><label>${lab}</label></div>`);
  const label = r.querySelector("label").textContent;
  ctrl.setAttribute("aria-label", label);
  ctrl.title = settingHelp[label] || label;
  ctrl.setAttribute("aria-description", ctrl.title);
  r.append(ctrl); return r;
}

// A reusable collapsible (native <details>) whose open/closed state persists in
// localStorage by `key`. `fillBody(container)` is invoked lazily the first time the
// section opens (it may be async) so deep content - e.g. a build's diagnostics - is
// only fetched on demand.
function collapsible(summaryHtml, fillBody, key, defaultOpen) {
  const d = document.createElement("details");
  d.className = "col";
  if (key) { const s = localStorage.getItem("smith.open." + key); d.open = s === null ? !!defaultOpen : s === "1"; }
  else d.open = !!defaultOpen;
  d.innerHTML = `<summary>${summaryHtml}</summary>`;
  const body = document.createElement("div");
  body.className = "cbody";
  d.append(body);
  let built = false;
  const ensure = () => { if (built) return; built = true; fillBody(body); };
  if (d.open) ensure();
  d.addEventListener("toggle", () => {
    if (d.open) ensure();
    if (key) localStorage.setItem("smith.open." + key, d.open ? "1" : "0");
  });
  return d;
}

// A de-cluttered label set: collapsed by default behind a "labels (N)" toggle so a
// node's long capability list doesn't sprawl across the row. Expands inline to chips.
// If opts.onClick is given each chip is clickable (the Agents page filters by label);
// opts.open forces the expanded state.
function labelChips(labels, opts) {
  opts = opts || {};
  const uniq = [...new Set(labels || [])].sort();
  const d = el(`<details class="labelchips"${opts.open ? " open" : ""}></details>`);
  if (!uniq.length) {
    d.append(el(`<summary><span class="muted">no labels</span></summary>`));
    return d;
  }
  d.append(el(`<summary>labels <span class="lc-count">${uniq.length}</span></summary>`));
  const body = el(`<div class="lc-body"></div>`);
  for (const l of uniq) {
    const chip = el(`<span class="lc-chip">${esc(l)}</span>`);
    if (opts.onClick) { chip.classList.add("clickable"); chip.title = "filter by " + l; chip.onclick = () => opts.onClick(l); }
    body.append(chip);
  }
  d.append(body);
  return d;
}

// Compact health chip from a build record's `diag` summary (errors/warnings/test-fails).
function diagBadge(diag) {
  if (!diag || !diag.parsed) return "";
  const e = diag.errors || 0, w = diag.warnings || 0, tf = diag.testsFailed || 0;
  if (!e && !w && !tf) return `<span class="diagbadge ok">clean</span>`;
  const bits = [];
  if (e) bits.push(`<span class="db err">${e}E</span>`);
  if (w) bits.push(`<span class="db warn">${w}W</span>`);
  if (tf) bits.push(`<span class="db err">${tf}✗</span>`);
  return `<span class="diagbadge">${bits.join("")}</span>`;
}

// One diagnostic row. When onJump + a log line are given the row is clickable and
// scrolls the build's log to that line.
function diagItem(it, cls, onJump) {
  const row = el(`<div class="diag-item ${cls}">${it.location ? `<span class="loc">${esc(it.location)}</span>` : ""}${it.code ? `<span class="code">${esc(it.code)}</span>` : ""}<span class="msg">${esc(it.text)}</span></div>`);
  if (onJump && it.line) { row.classList.add("jump"); row.title = "jump to log line " + it.line; row.onclick = () => onJump(it.line); }
  return row;
}
// A severity category (Errors/Warnings); when more than one tool is present the items
// are sub-grouped by tool (msvc/clang/linker/unity/generic) with per-tool counts.
function diagList(title, items, count, cls, onJump) {
  const det = el(`<details class="diag-cat"${cls === "err" ? " open" : ""}><summary>${title} (${count})</summary></details>`);
  const tools = [...new Set(items.map(it => it.tool || "generic"))];
  if (tools.length > 1) {
    for (const tool of tools) {
      const sub = items.filter(it => (it.tool || "generic") === tool);
      const g = el(`<div class="diag-group"><div class="diag-group-head">${esc(tool)} <span class="muted">${sub.length}</span></div></div>`);
      for (const it of sub) g.append(diagItem(it, cls, onJump));
      det.append(g);
    }
  } else {
    for (const it of items) det.append(diagItem(it, cls, onJump));
  }
  if (count > items.length) det.append(el(`<div class="muted more">…and ${count - items.length} more (see full log)</div>`));
  return det;
}
// The full diagnostics tree. opts: { onJump(line), filterable } — filterable adds a
// severity/tool filter bar (used in the single-build view, not the compact list).
function renderDiagnostics(d, opts) {
  opts = opts || {};
  const wrap = el(`<div class="diag"></div>`);
  if (!d || !d.parsed) { wrap.append(el(`<div class="muted">No diagnostics parsed.</div>`)); return wrap; }
  const tp = d.testsPassed || 0, tf = d.testsFailed || 0;
  const chips = el(`<div class="diag-chips"></div>`);
  chips.append(el(`<span class="chip ${d.errorCount ? "err" : "muted"}">${d.errorCount || 0} errors</span>`));
  chips.append(el(`<span class="chip ${d.warningCount ? "warn" : "muted"}">${d.warningCount || 0} warnings</span>`));
  if (tp || tf) chips.append(el(`<span class="chip ${tf ? "err" : "ok"}">${tp}✓ / ${tf}✗ tests</span>`));
  if (d.truncated) chips.append(el(`<span class="chip muted">truncated</span>`));
  wrap.append(chips);

  const state = { sev: "all", tool: "all" };
  const toolsPresent = [...new Set([...(d.errors || []), ...(d.warnings || [])].map(it => it.tool || "generic"))].sort();
  const body = el(`<div class="diag-body"></div>`);

  function build() {
    body.replaceChildren();
    const showErr = state.sev !== "warnings";
    const showWarn = state.sev !== "errors";
    const filt = (arr) => state.tool === "all" ? arr : arr.filter(it => (it.tool || "generic") === state.tool);
    if (showErr && (d.errors || []).length) {
      const e = filt(d.errors);
      if (e.length) body.append(diagList("Errors", e, state.tool === "all" ? d.errorCount : e.length, "err", opts.onJump));
    }
    if (showWarn && (d.warnings || []).length) {
      const w = filt(d.warnings);
      if (w.length) body.append(diagList("Warnings", w, state.tool === "all" ? d.warningCount : w.length, "warn", opts.onJump));
    }
    // Tests aren't tool-attributed — show them only in the unfiltered view.
    if (state.sev === "all" && state.tool === "all" && (d.suites || []).length) {
      const det = el(`<details class="diag-cat"${tf ? " open" : ""}><summary>Tests — ${tp} passed, ${tf} failed</summary></details>`);
      for (const s of d.suites) {
        const sp = s.passed >= 0 ? s.passed : 0, sf = s.failed >= 0 ? s.failed : 0;
        const bad = s.status === "failed" || sf > 0;
        const sd = el(`<details class="diag-suite"${bad ? " open" : ""}><summary><span class="${bad ? "err" : "ok"}">${bad ? "✗" : "✓"}</span> ${esc(s.name)} <span class="muted">${sp}/${sf}</span></summary></details>`);
        for (const f of (s.failures || [])) sd.append(diagItem({ text: f.text, line: f.line }, "err", opts.onJump));
        det.append(sd);
      }
      body.append(det);
    }
  }

  if (opts.filterable && (toolsPresent.length > 1 || ((d.errors || []).length && (d.warnings || []).length))) {
    const bar = el(`<div class="diag-filters"></div>`);
    const sevSel = el(`<select title="severity"><option value="all">all severities</option><option value="errors">errors only</option><option value="warnings">warnings only</option></select>`);
    const toolSel = el(`<select title="tool"><option value="all">all tools</option>${toolsPresent.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join("")}</select>`);
    sevSel.onchange = () => { state.sev = sevSel.value; build(); };
    toolSel.onchange = () => { state.tool = toolSel.value; build(); };
    bar.append(sevSel, toolSel);
    wrap.append(bar);
  }
  wrap.append(body);
  build();
  return wrap;
}

// Poll only while the page is actually on screen. A dashboard left open in a
// background tab was still polling the coordinator every 2-5s indefinitely -
// work nobody could see, on every open tab, forever. Coming back to the tab
// refreshes immediately so nothing looks stale.
const onVisible = [];
function pollWhileVisible(fn, everyMs) {
  onVisible.push(fn);
  return setInterval(() => { if (!document.hidden) fn(); }, everyMs);
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) for (const fn of onVisible) fn();
});

async function ping() {
  try { await api("/api/nodes"); conn.textContent = "● connected"; conn.className = "conn ok"; }
  catch { conn.textContent = "● offline"; conn.className = "conn bad"; }
}

// ---- Dashboard ----
function nodesTable(nodes, opts) {
  const t = el(`<table><thead><tr><th>Host</th><th>OS</th><th>Labels</th><th>Status</th><th>Seen</th></tr></thead><tbody></tbody></table>`);
  const tb = t.querySelector("tbody");
  for (const n of nodes) {
    const tr = el(`<tr>
      <td>${esc(n.hostname)}</td><td>${esc(n.os)}/${esc(n.arch)}</td>
      <td class="labels"></td>
      <td>${badge(n.status)}${n.currentJobId ? ` <a href="#/build/${esc(n.currentJobId)}">building</a>` : ""}</td>
      <td class="muted">${ago(n.lastSeenMs)}</td></tr>`);
    tr.querySelector(".labels").append(labelChips(n.labels, opts));
    tb.append(tr);
  }
  return t;
}

// The products a branch can build, from that branch's own smith.json (so a feature
// branch offers products it hasn't merged yet). Empty branch = the default branch.
// Resolves to {products, error?}; never throws (falls back to the project's list).
async function branchProducts(p, branch) {
  if (!branch) return { products: p.products || [] };
  try {
    const r = await api(`/api/projects/${encodeURIComponent(p.id)}/branch-products?branch=${encodeURIComponent(branch)}`);
    return { products: r.products || [], error: r.error, fromBranch: r.source === "branch" };
  } catch (e) { return { products: p.products || [], error: e.message }; }
}

// Call `apply(result, branch)` with branchProducts() whenever a branch input settles
// (change, or a pause in typing); a stale answer is dropped if the user kept typing.
function onBranchSettled(input, p, apply) {
  let timer = 0, seq = 0;
  const run = async () => {
    const mine = ++seq, v = input.value.trim();
    const r = await branchProducts(p, v);
    if (mine === seq) apply(r, v);
  };
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 600); });
  input.addEventListener("change", () => { clearTimeout(timer); run(); });
}

// A one-line note under a branch picker: what the product list came from, or why the
// branch couldn't be read. Empty for the default branch.
function branchNoteText(r, branch) {
  if (!branch) return "";
  if (r.error) return `${branch}: ${r.error} — showing the default branch's products`;
  if (!r.products.length) return `${branch}: no product has a rule for this branch`;
  return r.fromBranch ? `products from ${branch}'s smith.json` : "";
}

function triggerRow(p, nodes) {
  const row = el(`<div class="trigger-row"></div>`);
  const branch = el(`<input type="text" placeholder="branch (default)" aria-label="Build branch" title="Primary repository branch to build. Empty uses its configured default; branch patterns must match an enabled rule." />`);
  const plat = platformSelect();
  // Clean build: wipe untracked/ignored files (Unity Library/, IL2CPP intermediates)
  // before building. Off by default; covers both single triggers and chain runs.
  const cleanWrap = el(`<label class="clean-toggle" title="Wipe untracked + ignored files (build caches) before building"><input type="checkbox" /> clean</label>`);
  const clean = cleanWrap.querySelector("input");
  // Product buttons live in their own box so a branch change can swap them for the
  // products that branch's smith.json declares.
  const prodBox = el(`<span class="trigger-products"></span>`);
  const note = el(`<div class="muted branch-note"></div>`);
  row.append(branch, plat, cleanWrap, prodBox);
  const onlineOs = new Set(nodes.map(n => n.os));   // any listed node is reachable (reaped ones are removed)
  const trigger = async (prod, profile) => {
    try {
      const r = await apiPost("/api/trigger", { projectId: p.id, product: prod, profile: profile || "", targetOs: plat.value, branch: branch.value.trim(), reason: "manual", clean: clean.checked });
      location.hash = "#/build/" + r.jobId;
    } catch (e) { alert("Trigger failed: " + e.message); }
  };
  function renderProducts(products) {
    prodBox.replaceChildren();
    for (const prod of products) {
      const variants = prod.variants || [];
      if (variants.length) {
        const wrap = el(`<div class="product"><span>${esc(prod.name)}</span></div>`);
        const sel = document.createElement("select");
        for (const v of variants) {
          const buildable = variantBuildable(v, onlineOs);
          const opt = document.createElement("option");
          opt.value = v.name;
          // Slugs are the friendly aliases ("steam-windows"); the full profile name
          // stays available as the tooltip.
          opt.textContent = (v.slug || v.name) + (v.os && v.os !== "any" ? ` (${v.os})` : "") + (buildable ? "" : " — no node");
          opt.title = v.name;
          opt.disabled = !buildable;
          sel.append(opt);
        }
        const btn = el(`<button>Trigger ▶</button>`);
        btn.onclick = () => trigger(prod.name, sel.value);
        wrap.append(sel, btn);
        prodBox.append(wrap);
      } else {
        const b = el(`<div class="product"><span>${esc(prod.name)}</span><button>Trigger ▶</button></div>`);
        b.querySelector("button").onclick = () => trigger(prod.name, "");
        prodBox.append(b);
      }
    }
  }
  renderProducts(p.products || []);
  onBranchSettled(branch, p, (r, b) => { renderProducts(r.products); note.textContent = branchNoteText(r, b); });
  // Named chains from the repo's smith.json: one click queues the whole batch.
  for (const c of (p.chains || [])) {
    const b = el(`<div class="product"><button title="batch: parallel builds, then the follow-up if all succeed">Run ${esc(c.name)} ⛓</button></div>`);
    b.querySelector("button").onclick = async () => {
      try {
        await apiPost("/api/batch", { projectId: p.id, chain: c.name, branch: branch.value.trim(), clean: clean.checked });
        document.dispatchEvent(new CustomEvent("smith-batches-changed", { detail: p.id }));
      } catch (e) { alert("Batch failed: " + e.message); }
    };
    row.append(b);
  }
  row.append(note);
  return row;
}

// Ad-hoc batch composer: pick variants across products, optionally a follow-up
// product (one whose rules consume artifact inputs), queue everything at once.
function batchComposer(p, nodes) {
  const products = p.products || [];
  const anyVariants = products.some(x => (x.variants || []).length);
  const thenProducts = products.filter(x => x.hasInputs);
  if (!anyVariants && products.length < 2) return null;   // nothing worth batching
  const onlineOs = new Set(nodes.map(n => n.os));

  const wrap = el(`<div class="autobuilds"><h3>Batch <span class="muted">— parallel builds, follow-up only if all succeed</span></h3></div>`);
  const form = el(`<div class="ab-add batch-form"></div>`);
  const branch = el(`<input type="text" placeholder="branch (default)" aria-label="Build branch" title="Primary repository branch to build. Empty uses its configured default; branch patterns must match an enabled rule." />`);
  const boxes = [];
  for (const prod of products) {
    const variants = prod.variants || [];
    if (variants.length) {
      for (const v of variants) {
        const ok = variantBuildable(v, onlineOs);
        const lab = el(`<label class="batch-pick" title="${esc(v.name)}"><input type="checkbox" ${ok ? "" : "disabled"} /> ${esc(prod.name)}/${esc(v.slug || v.name)}</label>`);
        boxes.push({ box: lab.querySelector("input"), product: prod.name, profile: v.name });
        form.append(lab);
      }
    } else if (!prod.hasInputs) {
      const lab = el(`<label class="batch-pick"><input type="checkbox" /> ${esc(prod.name)}</label>`);
      boxes.push({ box: lab.querySelector("input"), product: prod.name, profile: "" });
      form.append(lab);
    }
  }
  const thens = [];
  for (const prod of thenProducts) {
    const lab = el(`<label class="batch-pick batch-then" title="runs only if every selected build succeeds"><input type="checkbox" /> then: ${esc(prod.name)}</label>`);
    thens.push({ box: lab.querySelector("input"), product: prod.name });
    form.append(lab);
  }
  const cleanLab = el(`<label class="batch-pick" title="Wipe untracked + ignored files (build caches) before each build"><input type="checkbox" /> clean</label>`);
  const cleanBox = cleanLab.querySelector("input");
  form.append(cleanLab);
  const queue = el(`<button>Queue batch ▶</button>`);
  queue.onclick = async () => {
    const builds = boxes.filter(b => b.box.checked).map(b => ({ product: b.product, profile: b.profile }));
    if (!builds.length) { alert("pick at least one build"); return; }
    const then = thens.filter(t => t.box.checked).map(t => ({ product: t.product }));
    queue.disabled = true;
    try {
      await apiPost("/api/batch", { projectId: p.id, builds, then, branch: branch.value.trim(), clean: cleanBox.checked });
      for (const b of boxes) b.box.checked = false;
      for (const t of thens) t.box.checked = false;
      document.dispatchEvent(new CustomEvent("smith-batches-changed", { detail: p.id }));
    } catch (e) { alert("Batch failed: " + e.message); }
    queue.disabled = false;
  };
  form.prepend(branch);
  form.append(queue);
  wrap.append(form);
  return wrap;
}

// Recent batches for a project, with per-job chips; auto-refreshes while one is live.
function batchesSection(p) {
  const wrap = el(`<div class="autobuilds batches"><h3>Batches</h3><div class="batch-list"><span class="muted">Loading…</span></div></div>`);
  const list = wrap.querySelector(".batch-list");
  let timer = null;

  function jobChip(j) {
    return `<a class="batch-job" href="#/build/${esc(j.jobId)}" title="${esc(j.product)}${j.variant ? "/" + esc(j.variant) : ""}">` +
           `#${esc(j.buildNumber || "?")} ${badge(j.status)}</a>`;
  }
  function row(b) {
    const jobs = (b.builds || []).map(jobChip).join(" ");
    const then = (b.then || []).filter(j => j.jobId).map(jobChip).join(" ");
    return el(`<div class="batch-row">${badge(b.status)} <b>${esc(b.name)}</b> ` +
      `<span class="muted">${esc(b.branch)}${b.commit ? " @ " + esc(b.commit.slice(0, 7)) : ""}</span> ` +
      `${jobs}${then ? ` <span class="muted">→</span> ${then}` : ""} ` +
      `<span class="muted">${esc(b.detail || "")}</span></div>`);
  }
  async function refresh() {
    try {
      const batches = await api(`/api/projects/${encodeURIComponent(p.id)}/batches`);
      list.replaceChildren();
      if (!batches.length) { list.append(el(`<span class="muted">No batches yet.</span>`)); }
      for (const b of batches) list.append(row(b));
      const live = batches.some(b => b.status === "building" || b.status === "deploying");
      if (live && !timer) timer = setInterval(() => {
        if (!wrap.isConnected) { clearInterval(timer); timer = null; return; }
        if (!document.hidden) refresh();
      }, 4000);
      if (!live && timer) { clearInterval(timer); timer = null; }
    } catch { list.replaceChildren(el(`<span class="muted">Could not load batches.</span>`)); }
  }
  document.addEventListener("smith-batches-changed", (e) => { if (e.detail === p.id && wrap.isConnected) refresh(); });
  refresh();
  return wrap;
}

// One build, collapsible; expanding lazily fetches + renders its diagnostics tree.
function buildNode(b) {
  const summary =
    `<span class="bnum">#${esc(b.buildNumber)}</span> ${badge(b.status)} ` +
    `<span class="bprod">${esc(b.product)}${b.variant ? " / " + esc(b.variant) : ""}</span> ` +
    `<span class="muted bbr">${esc(b.branch)}</span> ${diagBadge(b.diag)} ` +
    `<span class="muted bwhen">${ago(b.createdAt)} · ${dur(b.durationMs)}</span>` +
    `<a class="blink" href="#/build/${esc(b.jobId)}">open ↗</a>` +
    (terminal(b.status) ? "" : `<button class="ghost bcancel" title="Cancel this build">Cancel</button>`);
  const d = collapsible(summary, async (body) => {
    body.append(el(`<div class="muted">Loading diagnostics…</div>`));
    try {
      const diag = await api(`/api/builds/${encodeURIComponent(b.jobId)}/diagnostics`);
      body.replaceChildren(diag && diag.parsed ? renderDiagnostics(diag)
        : el(`<div class="muted">No diagnostics yet (build ${esc(b.status)}). <a href="#/build/${esc(b.jobId)}">open ↗</a></div>`));
    } catch { body.replaceChildren(el(`<div class="muted">Could not load diagnostics.</div>`)); }
  }, "build." + b.jobId, false);
  const link = d.querySelector("summary .blink");
  if (link) link.addEventListener("click", e => e.stopPropagation());   // don't toggle when following the link
  const cancel = d.querySelector("summary .bcancel");
  if (cancel) cancel.addEventListener("click", async (e) => {
    e.preventDefault(); e.stopPropagation();   // a click inside <summary> would toggle the section
    if (!confirm(`Cancel build #${b.buildNumber} (${b.product}${b.variant ? " / " + b.variant : ""})?`)) return;
    cancel.disabled = true; cancel.textContent = "Cancelling…";
    try { const st = await cancelBuild(b.jobId); cancel.textContent = st === "cancelling" ? "Cancelling…" : "Cancelled"; }
    catch (err) { alert("cancel failed: " + err.message); cancel.disabled = false; cancel.textContent = "Cancel"; }
  });
  return d;
}

// UI-managed autobuilds for one project: a list of poll rules + an add form.
// Each rule polls a branch every N and builds a product (optionally pinned to a
// platform) when the commit changes. Server-side, independent of the repo smith.json.
function autobuildsSection(p) {
  const base = `/api/projects/${encodeURIComponent(p.id)}/autobuilds`;
  const products = (p.products || []).map(x => x.name);
  const wrap = el(`<div class="autobuilds"><h3>Autobuilds <span class="muted">— poll a branch, build on change</span></h3><div class="ab-list"><span class="muted">Loading…</span></div></div>`);
  const list = wrap.querySelector(".ab-list");

  async function refresh() {
    try { renderList(await api(base)); }
    catch { list.replaceChildren(el(`<span class="muted">Could not load autobuilds.</span>`)); }
  }
  async function save(rule) {
    return apiPost(base, rule);
  }
  function fmtEvery(s) { return s % 3600 === 0 ? s / 3600 + "h" : s % 60 === 0 ? s / 60 + "m" : s + "s"; }

  function ruleRow(r) {
    const row = el(`<div class="ab-rule"></div>`);
    const en = el(`<input type="checkbox" title="Enable or pause polling this branch for new commits" ${r.enabled ? "checked" : ""} />`);
    en.onchange = async () => { try { await save(Object.assign({}, r, { enabled: en.checked })); } catch (e) { alert("update failed: " + e.message); en.checked = r.enabled; } };
    const del = el(`<button class="ghost" title="Delete this server-side polling rule; repository triggers remain unchanged" aria-label="Delete autobuild rule">✕</button>`);
    del.onclick = async () => { if (!confirm(`Delete autobuild for ${r.branch} → ${r.product}?`)) return; try { await apiPost(`/api/autobuilds/${encodeURIComponent(r.id)}/delete`); refresh(); } catch (e) { alert("delete failed: " + e.message); } };
    const meta = el(`<span class="ab-meta"><span class="ab-br">${esc(r.branch)}</span> <span class="muted">every</span> ${esc(fmtEvery(r.intervalSeconds))} <span class="muted">→</span> <b>${esc(r.product)}</b>${r.targetOs ? ` <span class="ab-os">${esc(r.targetOs)}</span>` : ""} <span class="muted ab-sha">${r.lastSha ? "watching " + esc(r.lastSha.slice(0, 7)) : "(not yet polled)"}</span></span>`);
    row.append(en, meta, del);
    return row;
  }

  function addForm() {
    const f = el(`<div class="ab-add"></div>`);
    const branch = el(`<input type="text" placeholder="branch (e.g. main)" class="ab-branch" />`);
    const interval = el(`<input type="number" min="1" value="5" class="ab-int" />`);
    const unit = el(`<select><option value="60">min</option><option value="1">sec</option><option value="3600">hr</option></select>`);
    const prod = document.createElement("select");
    const setProducts = (names) => {
      prod.replaceChildren();
      for (const pn of names) { const o = document.createElement("option"); o.value = pn; o.textContent = pn; prod.append(o); }
    };
    setProducts(products);
    // A branch can build products its smith.json has and the default branch doesn't
    // (yet): list that branch's products as soon as it's typed.
    const note = el(`<div class="muted branch-note"></div>`);
    onBranchSettled(branch, p, (r, b) => { setProducts(r.products.map(x => x.name)); note.textContent = branchNoteText(r, b); });
    const plat = el(`<select title="target platform"><option value="">any platform</option><option value="windows">windows</option><option value="mac">mac</option><option value="linux">linux</option></select>`);
    const add = el(`<button>Add ▶</button>`);
    add.onclick = async () => {
      if (!prod.value) { alert(branch.value.trim() ? "no product builds this branch" : "this project has no build products"); return; }
      const secs = Math.max(1, parseInt(interval.value || "5", 10)) * parseInt(unit.value, 10);
      add.disabled = true;
      try { await save({ branch: branch.value.trim(), intervalSeconds: secs, product: prod.value, targetOs: plat.value, enabled: true }); branch.value = ""; refresh(); }
      catch (e) { alert("add failed: " + e.message); }
      add.disabled = false;
    };
    f.append(branch, el(`<span class="muted">every</span>`), interval, unit, prod, plat, add, note);
    return f;
  }

  // The repo's own smith.json triggers build too; show them (read-only) so a project
  // that builds on push from its smith.json doesn't look like it has no autobuilds.
  function repoTriggerRow(t) {
    const when = t.type === "poll" ? `<span class="muted">every</span> ${esc(fmtEvery(t.intervalSeconds))}`
      : t.type === "schedule" ? `<span class="muted">at</span> <code>${esc(t.cron)}</code>`
      : `<span class="muted">on webhook</span>`;
    const sha = t.type !== "poll" ? "" : t.lastSha ? "watching " + esc(t.lastSha.slice(0, 7)) : "(not yet polled)";
    return el(`<div class="ab-rule ab-repo" title="Defined in the repo's smith.json (triggers) — change it there"><span class="ab-src">smith.json</span>` +
      `<span class="ab-meta"><span class="ab-br">${esc(t.branch)}</span> ${when} <span class="muted">→</span> <b>${esc(t.product)}</b> <span class="muted ab-sha">${sha}</span></span></div>`);
  }

  function renderList(rules) {
    list.replaceChildren();
    const repo = p.repoTriggers || [];
    for (const t of repo) list.append(repoTriggerRow(t));
    if (!rules.length && !repo.length) list.append(el(`<div class="muted ab-empty">No autobuild rules yet — add one below.</div>`));
    for (const r of rules) list.append(ruleRow(r));
    list.append(addForm());
  }
  refresh();
  return wrap;
}

// One project, collapsible; summary shows the latest build's health rollup.
function projectNode(p, nodes, builds) {
  const latest = builds[0];
  const rollup = latest
    ? `${badge(latest.status)} ${diagBadge(latest.diag)}`
    : `<span class="muted">no builds</span>`;
  const summary = `<b>${esc(p.name || p.id)}</b> <span class="rollup">${rollup}</span>`;
  return collapsible(summary, (body) => {
    if (p.description) body.append(el(`<div class="muted">${esc(p.description)}</div>`));
    body.append(triggerRow(p, nodes));
    const composer = batchComposer(p, nodes);
    if (composer) body.append(composer);
    body.append(batchesSection(p));
    body.append(autobuildsSection(p));
    if (builds.length) {
      body.append(el(`<h3>Recent builds</h3>`));
      const list = el(`<div class="builds"></div>`);
      for (const b of builds.slice(0, 12)) list.append(buildNode(b));
      body.append(list);
    }
  }, "proj." + p.id, false);
}

// Mirror of the server's ValidateGitUrl for instant inline feedback.
function validateGitUrlClient(raw) {
  const url = (raw || "").trim();
  if (!url) return "enter a repository URL or path";
  const sep = url.indexOf("://");
  if (sep !== -1) {
    const scheme = url.slice(0, sep).toLowerCase();
    if (!["http", "https", "ssh", "git", "file"].includes(scheme)) return "unsupported scheme '" + scheme + "'";
    return "";
  }
  const c0 = url[0];
  if (/^[A-Za-z]:[\\/]/.test(url)) return "";   // Windows drive path
  if (url.startsWith("\\\\")) return "";          // UNC
  if ((c0 === "/" || c0 === "\\") && url.includes("@") && url.includes(":"))
    return "looks like a git URL with a stray leading '/' - remove it";
  return "";
}

let requestTimer = null;   // polls /api/project-requests while the Add panel is shown
async function refreshRequests(listEl) {
  let reqs;
  try { reqs = await api("/api/project-requests"); } catch { return; }
  if (!reqs.length) { listEl.replaceChildren(el(`<div class="muted">No add requests yet.</div>`)); return; }
  listEl.replaceChildren();
  for (const r of reqs) {
    const right =
      r.status === "done" ? `<span class="ok">✓ ${esc(r.projectId)}</span>` :
      r.status === "failed" ? `<span class="fail" title="${esc(r.error)}">${esc(r.error || "failed")}</span>` :
      r.status === "cloning" ? `<span class="muted">cloning…</span>` :
      `<span class="muted">queued</span>`;
    listEl.append(el(`<div class="req"><span class="pill ${esc(r.status)}">${esc(r.status)}</span><span class="requrl">${esc(r.url)}</span>${r.branch ? ` <span class="muted">@${esc(r.branch)}</span>` : ""}<span class="reqright">${right}</span></div>`));
  }
}

// Add one repo at a time: '+' validates inline, POSTs, clears the box (no blocking);
// each repo appears in the persisted request list as it clones in the background.
function addProjectBody(body) {
  body.append(el(`<div class="muted">Add a repo by URL; Smith reads its <code>smith.json</code>. Add several in a row — they clone in the background.</div>`));
  const row = el(`<div class="trigger-row">
    <input type="text" class="addurl" placeholder="git@github.com:org/repo.git  (or a local path)" aria-label="Repository URL or local path" title="Repository accessible from the coordinator and its agents, containing smith.json at the root" style="width:380px" />
    <input type="text" class="addbranch" placeholder="branch (optional)" aria-label="Project source branch" title="Branch containing smith.json; leave empty to use the repository default" />
    <button class="addbtn" title="Clone this repository in the coordinator’s managed project area and read its smith.json" aria-label="Add project">+</button></div>`);
  const errEl = el(`<div class="adderr" style="display:none"></div>`);
  const listWrap = el(`<div class="reqlist"></div>`);
  const urlIn = row.querySelector(".addurl");
  const brIn = row.querySelector(".addbranch");
  const submit = async () => {
    const url = urlIn.value.trim();
    const e = validateGitUrlClient(url);
    if (e) { errEl.textContent = e; errEl.style.display = ""; return; }
    errEl.style.display = "none";
    try {
      const res = await fetch("/api/projects", {
        method: "POST", headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ url, branch: brIn.value.trim() })
      });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || ("HTTP " + res.status)); }
      urlIn.value = ""; urlIn.focus();   // clear immediately; the clone runs in the background
      refreshRequests(listWrap);
    } catch (err) { errEl.textContent = err.message; errEl.style.display = ""; }
  };
  row.querySelector(".addbtn").onclick = submit;
  urlIn.addEventListener("keydown", (ev) => { if (ev.key === "Enter") submit(); });
  body.append(row, errEl, el(`<h3>Project requests</h3>`), listWrap);
  refreshRequests(listWrap);
  if (requestTimer) clearInterval(requestTimer);
  requestTimer = pollWhileVisible(() => refreshRequests(listWrap), 2000);
}

// A clickable overview tile (optionally a link). Used by the slim dashboard.
function statCard(big, label, sub, href) {
  const inner = `<div class="stat-big">${esc(big)}</div><div class="stat-label">${esc(label)}</div>` +
    (sub ? `<div class="stat-sub muted">${esc(sub)}</div>` : "");
  return el(href ? `<a class="card" href="${href}">${inner}</a>` : `<div class="card">${inner}</div>`);
}
// One row in the dashboard's recent-builds list.
function recentRow(b) {
  return el(`<a class="recent-row" href="#/build/${esc(b.jobId)}">` +
    `<span class="bnum">#${esc(b.buildNumber)}</span> ${badge(b.status)} ` +
    `<span class="bprod">${esc(b.projectId)}/${esc(b.product)}${b.variant ? " · " + esc(b.variant) : ""}</span> ` +
    `${diagBadge(b.diag)} <span class="muted bwhen">${ago(b.createdAt)} · ${dur(b.durationMs)}</span></a>`);
}

// ---- Dashboard: slim overview (count cards + recent activity) ----
// One request. This used to fetch every project's entire build history - two
// requests plus one per project - to render three counters and ten rows; with a
// few thousand builds that is ~1.2MB of JSON for ~4KB of screen.
async function viewDashboard() {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const ov = await api("/api/overview?since=" + startOfDay.getTime());
  const root = el(`<div></div>`);
  const recent = ov.recent || [];

  const cards = el(`<div class="cards"></div>`);
  cards.append(statCard(String(ov.nodes), ov.nodes === 1 ? "node" : "nodes", `${ov.idleNodes} idle`, "#/agents"));
  cards.append(statCard(String(ov.projects), ov.projects === 1 ? "project" : "projects", "", "#/projects"));
  cards.append(statCard(String(ov.buildsSince), "builds today", "", null));
  root.append(cards);

  const panel = el(`<div class="panel"><h2>Recent builds</h2></div>`);
  if (!recent.length) panel.append(el(`<div class="muted">No builds yet. Trigger one from <a href="#/projects">Projects</a>.</div>`));
  else { const list = el(`<div class="recent"></div>`); for (const b of recent) list.append(recentRow(b)); panel.append(list); }
  root.append(panel);

  app.replaceChildren(root);
}

// ---- Projects: triggers, batches, autobuilds, recent builds (no nodes) ----
async function viewProjects() {
  const [nodes, projects] = await Promise.all([api("/api/nodes"), api("/api/projects")]);
  const root = el(`<div></div>`);
  root.append(collapsible(`<b>Add project</b>`, addProjectBody, "addproj", false));
  const projSummary = `<b>Projects</b> <span class="count">${projects.length}</span>`;
  root.append(collapsible(projSummary, async (body) => {
    if (!projects.length) {
      body.append(el(`<div class="muted">No projects loaded. Add one above, or start the coordinator with <code>--project &lt;path-to-smith.json&gt;</code>.</div>`));
      return;
    }
    // Each project shows its newest 12 builds, so ask for exactly that many
    // rather than its whole history.
    const allBuilds = await Promise.all(projects.map(p =>
      api(`/api/projects/${encodeURIComponent(p.id)}/builds?limit=12`).catch(() => [])));
    projects.forEach((p, i) => body.append(projectNode(p, nodes, allBuilds[i])));
  }, "projects", true));
  app.replaceChildren(root);
}

// ---- Agents: node inspection with label/status filters ----
let agentFilter = { label: "", status: "" };
function agentsTable(nodes, onLabel) {
  const t = el(`<table class="agents-table"><thead><tr><th>Host</th><th>OS</th><th>Labels</th><th>Status</th><th>Doing</th><th>GPU</th><th title="A model is running on this agent (needed to host the Discord bot)">Model on agent</th><th>Version</th><th>Seen</th></tr></thead><tbody></tbody></table>`);
  const tb = t.querySelector("tbody");
  for (const n of nodes) {
    const doing = n.currentJobId
      ? `<a href="#/build/${esc(n.currentJobId)}">${n.currentBuildNumber ? "#" + esc(n.currentBuildNumber) + " " : ""}${esc(n.currentProduct || "build")}${n.currentVariant ? " / " + esc(n.currentVariant) : ""}</a>`
      : `<span class="muted">—</span>`;
    const gpu = n.gpuTotalMb ? `${Math.round((n.gpuFreeMb || 0) / 1024)}/${Math.round(n.gpuTotalMb / 1024)} GiB free` : `<span class="muted">—</span>`;
    const tr = el(`<tr>
      <td>${esc(n.hostname)}</td><td>${esc(n.os)}/${esc(n.arch)}</td>
      <td class="labels"></td>
      <td>${badge(n.status)}</td>
      <td>${doing}</td>
      <td class="muted">${gpu}</td>
      <td>${n.ollama ? "✓" : "<span class='muted'>—</span>"}</td>
      <td class="muted">${esc(n.agentVersion || "—")}</td>
      <td class="muted">${ago(n.lastSeenMs)}</td></tr>`);
    tr.querySelector(".labels").append(labelChips(n.labels, { onClick: onLabel }));
    tb.append(tr);
  }
  return t;
}
async function viewAgents() {
  const nodes = await api("/api/nodes");
  const root = el(`<div class="panel agents"></div>`);
  root.append(el(`<div class="panelhead"><h2>Agents <span class="count">${nodes.length}</span></h2></div>`));

  const allLabels = [...new Set(nodes.flatMap(n => n.labels || []))].sort();
  const bar = el(`<div class="agent-filters"></div>`);
  const labelSel = el(`<select aria-label="Filter agents by capability" title="Show machines advertising this exact capability label; labels do not install tools"><option value="">all labels</option>${allLabels.map(l => `<option value="${esc(l)}">${esc(l)}</option>`).join("")}</select>`);
  const statusSel = el(`<select aria-label="Filter agents by status" title="Idle machines can accept compatible work; busy machines are building; offline machines have stopped reporting"><option value="">all status</option><option value="idle">idle</option><option value="busy">busy</option><option value="offline">offline</option></select>`);
  const clear = el(`<button class="ghost">clear</button>`);
  labelSel.value = agentFilter.label; statusSel.value = agentFilter.status;
  const tableWrap = el(`<div></div>`);
  const render = () => {
    let list = nodes;
    if (agentFilter.status) list = list.filter(n => n.status === agentFilter.status);
    if (agentFilter.label) list = list.filter(n => (n.labels || []).includes(agentFilter.label));
    tableWrap.replaceChildren(list.length
      ? agentsTable(list, (l) => { agentFilter.label = l; labelSel.value = l; render(); })
      : el(`<div class="muted">No agents match these filters.</div>`));
  };
  labelSel.onchange = () => { agentFilter.label = labelSel.value; render(); };
  statusSel.onchange = () => { agentFilter.status = statusSel.value; render(); };
  clear.onclick = () => { agentFilter = { label: "", status: "" }; labelSel.value = ""; statusSel.value = ""; render(); };
  bar.append(labelSel, statusSel, clear);
  root.append(bar, tableWrap);
  if (!nodes.length) tableWrap.append(el(`<div class="muted">No agents registered yet. Start one with <code>smith agent</code>.</div>`));
  else render();
  app.replaceChildren(root);
}

// ---- Build detail with live log ----
let activeSource = null;
async function viewBuild(jobId) {
  if (activeSource) { activeSource.close(); activeSource = null; }
  const root = el(`<div></div>`);
  const meta = el(`<div class="panel"><div class="panelhead"><h2>Build <span class="muted">${esc(jobId.slice(0, 8))}</span></h2>` +
    `<button class="ghost" id="cancelbuild" title="Cancel this build" style="display:none">Cancel build</button></div><div class="kv" id="kv"></div></div>`);
  const diagPanel = el(`<div class="panel" id="diagpanel" style="display:none"><h2>Diagnostics</h2><div id="diag"></div></div>`);
  const logPanel = el(`<div class="panel"><div class="panelhead"><h2>Log</h2><button class="ghost" id="dllog" title="Download the full log">Download full log</button></div><div class="log" id="log"></div></div>`);
  root.append(meta, diagPanel, logPanel);
  app.replaceChildren(root);
  const logEl = root.querySelector("#log");

  // ---- log: capped, chunked, append-only rendering ----
  // A 3MB Unity log used to render one <div> per line and reflow on every line.
  // Then it became one text node rebuilt from a 5000-line join every frame, which
  // re-laid-out the whole box for each batch. Now the retained tail lives in
  // fixed-size text nodes: new lines only extend the last one (the browser keeps
  // the layout of everything above it) and trimming removes a whole leading node
  // instead of copying the buffer. Incoming lines are coalesced into one append
  // per animation frame, so the cost tracks frames, not lines.
  const MAXLOGLINES = 5000;
  const CHUNKLINES = 500;
  let chunks = [];       // Text nodes, oldest first
  let chunkLines = [];   // line count per chunk, parallel to `chunks`
  let shown = 0;         // lines currently in the DOM
  let dropped = 0;       // lines not shown: trimmed here, or skipped by the server
  let queued = [], pending = false, stick = true, headEl = null;

  const atBottom = () => logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
  // Track "is the user parked at the bottom" from the scroll event: measuring it
  // during the frame would force an extra layout right before we append.
  logEl.addEventListener("scroll", () => { stick = atBottom(); }, { passive: true });

  function showDropped() {
    if (!dropped) return;
    if (!headEl) { headEl = el(`<div class="loghead"></div>`); logEl.prepend(headEl); }
    headEl.textContent =
      `… ${dropped} earlier line${dropped === 1 ? "" : "s"} hidden — use "Download full log" …`;
  }

  function flush() {
    pending = false;
    const lines = queued;
    queued = [];
    let i = 0;
    while (i < lines.length) {
      let last = chunks.length - 1;
      if (last < 0 || chunkLines[last] >= CHUNKLINES) {
        const t = document.createTextNode("");
        logEl.append(t);
        chunks.push(t); chunkLines.push(0);
        last = chunks.length - 1;
      }
      const take = lines.slice(i, i + (CHUNKLINES - chunkLines[last]));
      chunks[last].appendData((shown ? "\n" : "") + take.join("\n"));
      chunkLines[last] += take.length;
      shown += take.length;
      i += take.length;
    }
    // Trim whole chunks off the top - one removeChild per CHUNKLINES lines,
    // instead of re-slicing a 5000-entry buffer on every line that arrives.
    while (chunks.length > 1 && shown - chunkLines[0] >= MAXLOGLINES) {
      logEl.removeChild(chunks[0]);
      shown -= chunkLines[0];
      dropped += chunkLines[0];
      chunks.shift(); chunkLines.shift();
      if (chunks[0].data[0] === "\n") chunks[0].deleteData(0, 1);   // the joining newline
      showDropped();
    }
    if (stick) logEl.scrollTop = logEl.scrollHeight;
  }

  function addLines(arr) {
    if (!arr.length) return;
    for (const l of arr) queued.push(l);
    if (!pending) { pending = true; requestAnimationFrame(flush); }
  }

  // Scroll the log to a diagnostic's line. Only the last MAXLOGLINES are retained,
  // so map the 1-based full-log line into the visible window; if it fell off the
  // top, point the user at the full log instead.
  function jumpToLogLine(lineNo) {
    if (!lineNo) return;
    let idx = (lineNo - 1) - dropped;
    if (idx < 0) { alert(`Line ${lineNo} is above the visible window — use "Download full log".`); return; }
    if (idx >= shown) return;   // not streamed in yet
    let c = 0;
    while (c < chunks.length && idx >= chunkLines[c]) { idx -= chunkLines[c]; c += 1; }
    if (c >= chunks.length) return;
    const text = chunks[c].data;
    let pos = text[0] === "\n" ? 1 : 0;   // chunks after the first open with the joining newline
    for (let k = 0; k < idx; k += 1) {
      const nl = text.indexOf("\n", pos);
      if (nl < 0) { pos = text.length; break; }
      pos = nl + 1;
    }
    const r = document.createRange();
    r.setStart(chunks[c], Math.min(pos, text.length));
    r.setEnd(chunks[c], Math.min(pos + 1, text.length));
    stick = false;
    logEl.scrollTop += r.getBoundingClientRect().top - logEl.getBoundingClientRect().top
                       - logEl.clientHeight / 3;
    logEl.classList.add("flash"); setTimeout(() => logEl.classList.remove("flash"), 600);
  }

  async function loadDiag(status) {
    if (!terminal(status)) return;
    try {
      const d = await api("/api/builds/" + encodeURIComponent(jobId) + "/diagnostics");
      if (d && d.parsed && ((d.errorCount || 0) || (d.warningCount || 0) || (d.suites || []).length)) {
        root.querySelector("#diag").replaceChildren(renderDiagnostics(d, { filterable: true, onJump: jumpToLogLine }));
        diagPanel.style.display = "";
      }
    } catch { /* no diagnostics */ }
  }

  async function refreshMeta() {
    const b = await api("/api/builds/" + encodeURIComponent(jobId));
    const arts = (b.artifacts || []).map(a =>
      `<a href="${dlUrl("/api/builds/" + encodeURIComponent(jobId) + "/artifacts/" + encodeURIComponent(a))}" download>${esc(a)}</a>`).join(", ") || "<span class='muted'>none</span>";
    root.querySelector("#kv").innerHTML = `
      <div>Project</div><div>${esc(b.projectId)} · ${esc(b.product)}${b.variant ? " / " + esc(b.variant) : ""} · ${esc(b.rule)}</div>
      <div>Build</div><div>#${esc(b.buildNumber)} on ${esc(b.branch)}${b.commit ? " @ " + esc(b.commit.slice(0, 7)) : ""}</div>
      <div>Author</div><div>${esc(b.authorName || "—")}${b.authorEmail ? ` <span class="muted">&lt;${esc(b.authorEmail)}&gt;</span>` : ""}</div>
      <div>Status</div><div>${badge(b.status)} <span class="phase">${esc(b.phase)}</span> ${b.exitCode !== undefined ? `<span class="muted">exit ${esc(b.exitCode)}</span>` : ""}</div>
      <div>Node</div><div>${esc(b.nodeName || (b.nodeId ? b.nodeId.slice(0, 8) : "—"))}</div>
      <div>Duration</div><div>${dur(b.durationMs)}</div>
      <div>Artifacts</div><div>${arts}</div>`;
    // Only an in-flight build can be cancelled; the button disappears once it settles.
    const cb = root.querySelector("#cancelbuild");
    cb.style.display = terminal(b.status) ? "none" : "";
    if (!terminal(b.status) && !cb.disabled) cb.textContent = "Cancel build";
    return b;
  }
  const b0 = await refreshMeta();
  await loadDiag(b0.status);

  // Cancel: a queued build dies immediately, a running one is told to abort and
  // settles when the agent reports back (the log stream's "done" refreshes this view).
  root.querySelector("#cancelbuild").onclick = async () => {
    const btn = root.querySelector("#cancelbuild");
    if (!confirm(`Cancel build #${b0.buildNumber} (${b0.projectId} / ${b0.product})?`)) return;
    btn.disabled = true; btn.textContent = "Cancelling…";
    try {
      await cancelBuild(jobId);
      await refreshMeta();   // queued: already gone. running: settles when the agent reports back
    } catch (e) {
      alert("cancel failed: " + e.message);
      btn.disabled = false; btn.textContent = "Cancel build";
    }
  };

  // Download full log: fetch via api() (so the session token rides along) and save a
  // blob - an <a download> can't carry the auth header.
  root.querySelector("#dllog").onclick = async () => {
    const btn = root.querySelector("#dllog"), old = btn.textContent;
    btn.disabled = true; btn.textContent = "…";
    try {
      const text = await api("/api/builds/" + encodeURIComponent(jobId) + "/log");
      const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      const a = document.createElement("a"); a.href = url;
      a.download = `${b0.projectId}-build-${b0.buildNumber}.log`; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { alert("download failed: " + e.message); }
    btn.disabled = false; btn.textContent = old;
  };

  // Finished build: ask for only the tail we can actually show. A 3MB Unity log
  // costs seconds to ship and split when the window is 5000 lines; the server
  // reports how many lines it skipped so diagnostics still line up, and "Download
  // full log" is unchanged.
  if (terminal(b0.status)) {
    try {
      const res = await apiRes(`/api/builds/${encodeURIComponent(jobId)}/log?tail=${MAXLOGLINES}`);
      dropped = parseInt(res.headers.get("X-Log-Skipped-Lines") || "0", 10) || 0;
      showDropped();
      const lines = (await res.text()).split("\n");
      if (lines.length && lines[lines.length - 1] === "") lines.pop();   // trailing newline
      addLines(lines);
    } catch { logEl.textContent = "(log unavailable)"; }
  } else {
    const tok = sessionToken();
    const src = new EventSource("/api/builds/" + encodeURIComponent(jobId) + "/stream" +
      (tok ? "?access_token=" + encodeURIComponent(tok) : ""));
    activeSource = src;
    // The server skips the backlog we could never show and packs many lines into
    // one event, so opening a build that is already 20k lines deep is one batch
    // rather than 20k separate messages.
    src.addEventListener("skipped", (e) => {
      try { dropped = JSON.parse(e.data).lines || 0; } catch { /* older coordinator */ }
      showDropped();
    });
    src.onmessage = (e) => addLines(e.data.split("\n"));
    src.addEventListener("done", async () => { src.close(); activeSource = null; const b = await refreshMeta(); await loadDiag(b.status); });
    src.onerror = () => { /* stream ended or build already finished */ };
  }
}

// ---- Settings ----
async function viewSettings() {
  const [projects, users] = await Promise.all([api("/api/projects"), api("/api/users").catch(() => [])]);
  const root = el(`<div></div>`);

  // Build history — clear a project's finished builds.
  const hist = el(`<div class="panel"><h2>Build history</h2>
    <div class="muted">Remove a project's finished builds (logs, diagnostics, artifacts). In-flight builds are kept.</div></div>`);
  if (!projects.length) hist.append(el(`<div class="muted">No projects.</div>`));
  for (const p of projects) {
    const row = el(`<div class="setrow"><span>${esc(p.name || p.id)}</span></div>`);
    const btn = el(`<button class="ghost">Clear history</button>`);
    btn.onclick = async () => {
      if (!confirm(`Clear all finished builds for ${p.name || p.id}? This cannot be undone.`)) return;
      btn.disabled = true; btn.textContent = "Clearing…";
      try { const r = await apiPost(`/api/projects/${encodeURIComponent(p.id)}/clear-builds`); btn.textContent = `Cleared ${r.cleared}`; }
      catch (e) { alert("Clear failed: " + e.message); btn.disabled = false; btn.textContent = "Clear history"; }
    };
    row.append(btn);
    hist.append(row);
  }
  root.append(hist);

  // Build triggers — what Smith does with a burst of commits.
  const trig = el(`<div class="panel"><h2>Build triggers</h2>
    <div class="muted">A poll / autobuild / webhook build <b>replaces</b> a still-queued build of the same product, branch and platform instead of joining the queue behind it — so a burst of pushes builds <b>once</b>, on the newest commit. Below: whether the build already <b>running</b> is abandoned for that newer commit too.</div>
    <div class="setform" id="trigform"><span class="muted">Loading…</span></div></div>`);
  root.append(trig);
  (async () => {
    let cfg; try { cfg = await api("/api/config"); } catch { trig.querySelector("#trigform").textContent = "Could not load config."; return; }
    const f = trig.querySelector("#trigform"); f.replaceChildren();
    const cancelRunning = el(`<input type="checkbox" />`); cancelRunning.checked = !!cfg.cancelRunningOnNewCommit;
    const save = el(`<button>Save</button>`);
    save.onclick = async () => {
      const ob = save.textContent; save.disabled = true; save.textContent = "Saving…";
      try {
        await apiPost("/api/config", { cancelRunningOnNewCommit: cancelRunning.checked });
        save.textContent = "Saved ✓"; setTimeout(() => { save.textContent = ob; }, 1800);
      } catch (e) { alert("Save failed: " + e.message); save.textContent = ob; }
      save.disabled = false;
    };
    f.append(settingRow("Cancel the running build on a newer commit", cancelRunning),
             el(`<div class="muted">Off by default: if commits can land faster than a build takes, cancelling on every push means no build ever finishes.</div>`),
             save);
  })();

  // Dynamic DNS — keep a Cloudflare A record on this coordinator's public IP (no JSON editing).
  const dns = el(`<div class="panel"><h2>Dynamic DNS <span class="dnsstatus muted"></span></h2>
    <div class="muted">Point a Cloudflare A record at this box's public IP and keep it current behind a changing home IP. Off until a record + API token are set.</div>
    <div class="setform" id="dnsform"><span class="muted">Loading…</span></div></div>`);
  root.append(dns);
  (async () => {
    let cfg; try { cfg = await api("/api/config"); } catch { dns.querySelector("#dnsform").textContent = "Could not load config."; return; }
    const d = cfg.dns || {};
    const f = dns.querySelector("#dnsform"); f.replaceChildren();
    const inp = (ph, val, type) => { const i = el(`<input />`); i.type = type || "text"; if (ph) i.placeholder = ph; if (val != null) i.value = val; return i; };
    const record = inp("smith.example.com", d.record);
    const zone = inp("example.com (optional — inferred from record)", d.zone);
    const token = inp(d.apiTokenSet ? "•••••• set (blank = keep)" : "Cloudflare API token (DNS:Edit on the zone)", "", "password"); token.autocomplete = "new-password";
    const proxied = el(`<input type="checkbox" />`); proxied.checked = d.proxied !== false;
    const interval = inp("", d.intervalSeconds || 300, "number"); interval.min = 30; interval.style.width = "90px";
    const save = el(`<button>Save &amp; apply</button>`);
    const st = dns.querySelector(".dnsstatus");
    const show = () => { st.textContent = d.configured ? ("● active" + (d.lastIp ? " · " + d.lastIp : "")) : "○ inactive"; };
    show();
    save.onclick = async () => {
      const ob = save.textContent; save.disabled = true; save.textContent = "Saving…";
      try {
        await apiPost("/api/config", { dns: {
          provider: "cloudflare", record: record.value.trim(), zone: zone.value.trim(),
          apiToken: token.value, proxied: proxied.checked, intervalSeconds: Math.max(30, parseInt(interval.value || "300", 10)) } });
        token.value = "";
        const fresh = await api("/api/config"); Object.assign(d, fresh.dns || {}); show();
        token.placeholder = d.apiTokenSet ? "•••••• set (blank = keep)" : "Cloudflare API token (DNS:Edit on the zone)";
        save.textContent = "Saved ✓"; setTimeout(() => { save.textContent = ob; }, 1800);
      } catch (e) { alert("Save failed: " + e.message); save.textContent = ob; }
      save.disabled = false;
    };
    f.append(settingRow("Record", record), settingRow("Zone", zone), settingRow("API token", token), settingRow("Proxied", proxied), settingRow("Check every (s)", interval), save);
  })();

  // GitHub access — a token so build agents can clone private GitHub repos over HTTPS
  // without a per-host SSH key. Write-only; reaches agents as a git http.extraheader.
  const gh = el(`<div class="panel"><h2>GitHub access <span class="ghstatus muted"></span></h2>
    <div class="muted">Lets build agents check out <b>private</b> GitHub repos over HTTPS — no per-host SSH key needed. Use a fine-grained PAT with read-only <b>Contents</b> on the repos you build (or a classic <code>repo</code> token). Stored write-only and never shown again; leave blank to keep the current one.</div>
    <div class="setform" id="ghform"><span class="muted">Loading…</span></div></div>`);
  root.append(gh);
  (async () => {
    let cfg; try { cfg = await api("/api/config"); } catch { gh.querySelector("#ghform").textContent = "Could not load config."; return; }
    const f = gh.querySelector("#ghform"); f.replaceChildren();
    const ph = () => cfg.githubTokenSet ? "•••••• set (blank = keep)" : "GitHub token (ghp_… or github_pat_…)";
    const token = el(`<input type="password" />`); token.placeholder = ph(); token.autocomplete = "new-password"; token.style.width = "360px";
    const save = el(`<button>Save</button>`);
    const st = gh.querySelector(".ghstatus");
    const show = () => { st.textContent = cfg.githubTokenSet ? "● token set" : "○ none (per-host SSH)"; };
    show();
    save.onclick = async () => {
      const ob = save.textContent; save.disabled = true; save.textContent = "Saving…";
      try {
        await apiPost("/api/config", { githubToken: token.value });
        token.value = "";
        const fresh = await api("/api/config"); cfg.githubTokenSet = fresh.githubTokenSet; show(); token.placeholder = ph();
        save.textContent = "Saved ✓"; setTimeout(() => { save.textContent = ob; }, 1800);
      } catch (e) { alert("Save failed: " + e.message); save.textContent = ob; }
      save.disabled = false;
    };
    f.append(settingRow("Token", token), save);
  })();

  // Discord bot — an Ollama-powered bot the coordinator runs on the agent with the most
  // free GPU memory. Drives builds/deploys/projects + posts build notifications.
  const dc = el(`<div class="panel"><h2>Discord bot <span class="dcstatus muted"></span></h2>
    <div class="muted">Runs a Discord bot (slash commands + natural language, answered by a model running on one of your agents) on the agent with the most free GPU memory. It can trigger builds, deploys (with confirmation) and add projects, and posts build notifications. Off until enabled with a bot token.</div>
    <div class="setform" id="dcform"><span class="muted">Loading…</span></div></div>`);
  root.append(dc);
  (async () => {
    let cfg; try { cfg = await api("/api/config"); } catch { dc.querySelector("#dcform").textContent = "Could not load config."; return; }
    const d = cfg.discord || {};
    const f = dc.querySelector("#dcform"); f.replaceChildren();
    const inp = (ph, val, type) => { const i = el(`<input />`); i.type = type || "text"; if (ph) i.placeholder = ph; if (val != null) i.value = val; i.style.flex = "1"; return i; };
    const csv = (arr) => (arr || []).join(", ");
    const enabled = el(`<input type="checkbox" />`); enabled.checked = !!d.enabled;
    const token = inp(d.tokenSet ? "•••••• set (blank = keep)" : "Discord bot token", "", "password"); token.autocomplete = "new-password";
    const appId = inp("application id (optional)", d.appId);
    const guildId = inp("guild id (optional, faster slash-command sync)", d.guildId);
    const notifyCh = inp("notify channel id", d.notifyChannelId);
    const cmdCh = inp("command channel ids (comma-separated; blank = any)", csv(d.commandChannels));
    const roles = inp("allowed role ids (comma-separated)", csv(d.allowRoles));
    const users = inp("allowed user ids (comma-separated)", csv(d.allowUsers));
    const ollamaUrl = inp("http://127.0.0.1:11434", d.ollamaUrl);
    const ollamaModel = inp("qwen3.5:9b", d.ollamaModel);
    const pinNode = inp("auto (most free GPU) — or a node hostname", d.pinNode);
    const cb = (v) => { const c = el(`<input type="checkbox" />`); c.checked = !!v; return c; };
    const nStart = cb(d.notifyStart), nRun = cb(d.notifyRunning), nOk = cb(d.notifySuccess), nFail = cb(d.notifyFail), confirmDeploy = cb(d.confirmDeploy !== false);
    const save = el(`<button>Save &amp; apply</button>`);
    const st = dc.querySelector(".dcstatus");
    const show = () => { st.textContent = d.configured ? ("● " + (d.status || "on") + (d.hostNode ? "" : "")) : "○ off"; };
    show();
    const toggles = el(`<div class="setrow"><label>Notify on</label></div>`);
    const lbl = (t, c) => { const w = el(`<label class="chk"></label>`); w.append(c, document.createTextNode(" " + t)); return w; };
    toggles.append(lbl("start", nStart), lbl("running", nRun), lbl("success", nOk), lbl("fail", nFail));
    save.onclick = async () => {
      const ob = save.textContent; save.disabled = true; save.textContent = "Saving…";
      const split = (s) => s.split(",").map(x => x.trim()).filter(Boolean);
      try {
        await apiPost("/api/config", { discord: {
          enabled: enabled.checked, token: token.value, appId: appId.value.trim(), guildId: guildId.value.trim(),
          notifyChannelId: notifyCh.value.trim(), commandChannels: split(cmdCh.value), allowRoles: split(roles.value), allowUsers: split(users.value),
          ollamaUrl: ollamaUrl.value.trim(), ollamaModel: ollamaModel.value.trim(), pinNode: pinNode.value.trim(),
          notifyStart: nStart.checked, notifyRunning: nRun.checked, notifySuccess: nOk.checked, notifyFail: nFail.checked, confirmDeploy: confirmDeploy.checked } });
        token.value = "";
        const fresh = await api("/api/config"); Object.assign(d, fresh.discord || {}); show();
        token.placeholder = d.tokenSet ? "•••••• set (blank = keep)" : "Discord bot token";
        save.textContent = "Saved ✓"; setTimeout(() => { save.textContent = ob; }, 1800);
      } catch (e) { alert("Save failed: " + e.message); save.textContent = ob; }
      save.disabled = false;
    };
    f.append(settingRow("Enabled", enabled), settingRow("Bot token", token), settingRow("Notify channel", notifyCh), toggles,
      settingRow("Command channels", cmdCh), settingRow("Allow roles", roles), settingRow("Allow users", users),
      settingRow("Model address", ollamaUrl), settingRow("Model", ollamaModel), settingRow("Host node", pinNode),
      settingRow("Confirm deploys", confirmDeploy), settingRow("App id", appId), settingRow("Guild id", guildId), save);
  })();

  // Users — tie commit emails to a person (powers failure attribution + targeted alerts).
  const panel = el(`<div class="panel"><h2>Users</h2>
    <div class="muted">A user's <b>google email</b> is their sign-in identity — adding one here also <b>grants access</b> to someone outside the allowed domains. Their <b>git emails</b> attribute build failures to them and target alerts.</div></div>`);
  const list = el(`<div class="userlist"></div>`);
  const reload = async () => { try { renderUsers(await api("/api/users")); } catch { /* ignore */ } };
  function renderUsers(arr) {
    list.replaceChildren();
    if (!arr.length) { list.append(el(`<div class="muted">No users yet.</div>`)); return; }
    for (const u of arr) {
      const row = el(`<div class="userrow">
        <div class="uhead"><b>${esc(u.displayName)}</b> <span class="badge ${u.role === "admin" ? "busy" : "idle"}">${esc(u.role)}</span></div>
        <div class="muted">${u.email ? "✉ " + esc(u.email) : "<i>no sign-in email</i>"}</div>
        <div class="muted emails">git: ${(u.gitEmails || []).map(e => esc(e)).join(", ") || "<i>none</i>"}</div>
        <div class="muted">${u.notifyOwnFailuresOnly ? "alerts: own failures only" : "alerts: all failures"}</div></div>`);
      const del = el(`<button class="ghost">Remove</button>`);
      del.onclick = async () => {
        if (!confirm(`Remove user ${u.displayName}?`)) return;
        try { await apiPost(`/api/users/${encodeURIComponent(u.id)}/delete`); reload(); }
        catch (e) { alert(e.message); }
      };
      row.append(del);
      list.append(row);
    }
  }
  renderUsers(users);
  panel.append(list);

  const form = el(`<div class="userform">
    <input type="text" class="uname" placeholder="display name" />
    <input type="text" class="uemail" placeholder="google email (sign-in + access)" style="width:260px" />
    <input type="text" class="uemails" placeholder="git emails (comma-separated)" style="width:280px" />
    <label class="chk"><input type="checkbox" class="uown" checked /> own failures only</label>
    <button class="uadd">Add user</button></div>`);
  form.querySelector(".uadd").onclick = async () => {
    const displayName = form.querySelector(".uname").value.trim();
    if (!displayName) { alert("enter a display name"); return; }
    const email = form.querySelector(".uemail").value.trim();
    const gitEmails = form.querySelector(".uemails").value.split(",").map(s => s.trim()).filter(Boolean);
    const notifyOwnFailuresOnly = form.querySelector(".uown").checked;
    try {
      const res = await fetch("/api/users", { method: "POST", headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ displayName, email, gitEmails, notifyOwnFailuresOnly }) });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || ("HTTP " + res.status)); }
      form.querySelector(".uname").value = ""; form.querySelector(".uemail").value = ""; form.querySelector(".uemails").value = "";
      reload();
    } catch (e) { alert(e.message); }
  };
  panel.append(el(`<h3>Add user</h3>`), form);
  root.append(panel);

  app.replaceChildren(root);
}

// ---- Router ----
// Mark the nav link matching the current top-level section so navigation reads as real.
function setActiveNav(section) {
  document.querySelectorAll("header nav a").forEach(a => {
    const target = (a.getAttribute("href") || "").replace(/^#/, "") || "/";
    a.classList.toggle("active", target === section);
  });
}
function route() {
  if (requestTimer) { clearInterval(requestTimer); requestTimer = null; }   // stop request polling off-projects
  const h = location.hash.replace(/^#/, "") || "/";
  const m = h.match(/^\/build\/(.+)$/);
  if (m) { setActiveNav("/"); return viewBuild(m[1]); }
  if (h === "/projects") { setActiveNav("/projects"); return viewProjects(); }
  if (h === "/agents") { setActiveNav("/agents"); return viewAgents(); }
  if (h === "/settings") { setActiveNav("/settings"); return viewSettings(); }
  setActiveNav("/");
  return viewDashboard();
}
window.addEventListener("hashchange", route);

// ---- Auth bootstrap + sign-in ----
let authConfig = { enabled: false };

function setSignedOutChrome(on) { document.body.classList.toggle("signedout", on); }

function renderMe(user) {
  const me = document.getElementById("me");
  if (!me) return;
  if (!user) { me.replaceChildren(); return; }
  const box = el(`<div class="meuser"><span class="mename">${esc(user.displayName || user.email)}</span>` +
    `<span class="badge ${user.role === "admin" ? "busy" : "idle"}">${esc(user.role)}</span>` +
    `<button class="ghost signout">Sign out</button></div>`);
  box.querySelector(".signout").onclick = async () => {
    try { await fetch("/api/auth/logout", { method: "POST", headers: authHeaders() }); } catch { /* ignore */ }
    setSession(""); showSignIn();
  };
  me.replaceChildren(box);
}
function renderSignInLink() {   // additive mode: offer sign-in without blocking
  const me = document.getElementById("me");
  if (!me) return;
  const b = el(`<button class="ghost">Sign in</button>`);
  b.onclick = () => showSignIn();
  me.replaceChildren(b);
}

function showSignIn(msg) {
  setSignedOutChrome(true);
  renderMe(null);
  const who = (authConfig.domains || []).join(", ");
  const card = el(`<div class="signin"><div class="signin-card">
    <img src="/smith-gun.png" alt="Smith" class="signin-logo" />
    <h1>Sign in to Smith</h1>
    <div class="muted">${who ? "Use your " + esc(who) + " account." : "Use your Google account."}</div>
    <div id="gbtn" class="gbtn"></div>
    <div class="signin-err" id="signin-err">${msg ? esc(msg) : ""}</div>
  </div></div>`);
  app.replaceChildren(card);
  mountGoogleButton();
}

async function onCredential(resp) {
  const errEl = document.getElementById("signin-err");
  try {
    const r = await fetch("/api/auth/google", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: resp.credential }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
    setSession(j.token);
    setSignedOutChrome(false);
    renderMe(j.user);
    ping(); if (!window.__smithPing) window.__smithPing = pollWhileVisible(ping, 5000);
    location.hash = "#/"; route();
  } catch (e) { if (errEl) errEl.textContent = e.message; }
}

let gisLoading = null;
function loadGis() {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (gisLoading) return gisLoading;
  gisLoading = new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client"; s.async = true; s.defer = true;
    s.onload = () => resolve(); s.onerror = () => resolve();   // offline -> button just won't render
    document.head.appendChild(s);
  });
  return gisLoading;
}
async function mountGoogleButton() {
  await loadGis();
  const host = document.getElementById("gbtn");
  if (!host) return;
  if (!window.google?.accounts?.id) { host.textContent = "Google sign-in is unavailable (no network to accounts.google.com)."; return; }
  window.google.accounts.id.initialize({ client_id: authConfig.clientId, callback: onCredential });
  window.google.accounts.id.renderButton(host, { theme: "filled_blue", size: "large", text: "signin_with" });
  window.google.accounts.id.prompt();
}

// Config-file health (GET /api/config/status). A broken smith-coordinator.json used to be
// silently ignored; now Smith falls back to a last-known-good copy and says so here, on
// every page, until the file is fixed and the coordinator restarted.
async function checkConfigStatus() {
  const box = document.getElementById("cfgalert");
  if (!box) return;
  let st;
  try { st = await api("/api/config/status"); }
  catch { return; }   // coordinator unreachable (the conn badge says so) or predates this endpoint
  if (!st || st.ok) { box.hidden = true; return; }
  box.classList.toggle("warn", st.severity === "warn");
  box.innerHTML = `<b>${st.severity === "warn" ? "Config needs a restart" : "Config file invalid"}:</b> ${esc(st.message)}`;
  box.hidden = false;
}

async function boot() {
  try { authConfig = await (await fetch("/api/auth/config")).json(); } catch { authConfig = { enabled: false }; }
  if (authConfig.enabled) {
    const t = sessionToken();
    if (t) {
      try { renderMe(await api("/api/auth/me")); }
      catch { if (authConfig.requireLogin) return; }   // api() already showed sign-in on 401
    } else if (authConfig.requireLogin) {
      showSignIn(); return;
    } else {
      renderSignInLink();
    }
  }
  setSignedOutChrome(false);
  ping(); window.__smithPing = pollWhileVisible(ping, 5000);
  checkConfigStatus(); pollWhileVisible(checkConfigStatus, 30000);
  route();
}
boot();
