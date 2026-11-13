// synthmatch UI
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

const state = { inst: null, info: null, job: null, pollTimer: null, lib: { rec: "", group: "" } };
const GROUP_NAMES = { "SN-A": "SuperNATURAL Acoustic", "SN-S": "SuperNATURAL Synth", PCM: "PCM Synth" };

// 公開版でブラウザごとに楽譜を分けるための ID（ランダム。サーバーには X-Client-Id で送る）
const CLIENT_ID = (() => {
  let id = store.get("client_id");
  if (!/^[0-9a-f]{32}$/.test(id || "")) {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    id = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    store.set("client_id", id);
  }
  return id;
})();
const isActive = (job) => job?.status === "running" || job?.status === "queued";

// 共有ページ（scripts/export_share.py で書き出したもの）はサーバーがないので、書き出した JSON を読む
const SHARE = window.SYNTHMATCH_SHARE || null;
function shareFile(path) {
  if (path === "/api/sheets") return "data/sheets.json";
  const m = path.match(/^\/api\/sheets\/([^/]+)(\/sync)?$/);
  return m ? `data/${m[1]}/${m[2] ? "sync" : "sheet"}.json` : null;
}

async function api(path, opts = {}) {
  if (SHARE) {
    if (path === "/api/config") return { public: true, share: true };
    const file = shareFile(path);
    if (!file) throw new Error("共有ページでは使えません");
    const res = await fetch(file);
    if (!res.ok) throw new Error("見つかりません");
    return res.json();
  }
  const res = await fetch(path, { ...opts, headers: { ...(opts.headers || {}), "X-Client-Id": CLIENT_ID } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.detail || `${res.status} ${res.statusText}`);
  return body;
}
const post = (path, data) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data ?? {}) });

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 5000);
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) return "-";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}時間${m}分` : m ? `${m}分${s}秒` : `${s}秒`;
}
const clock = (t) => (isFinite(t) ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}` : "0:00");

// ---------- ジャケット風アートワーク ----------
function splitCat(cat) {
  const i = (cat || "").indexOf(":");
  return i >= 0 ? [cat.slice(0, i), cat.slice(i + 1)] : ["", cat || ""];
}
function catIcon(cat) {
  const c = cat.toLowerCase();
  if (/pad|string|choir|orch/.test(c)) return "i-verb";
  if (/bass/.test(c)) return "i-env";
  if (/brass|sax|flute|wind|reed|harmonica/.test(c)) return "i-filter";
  if (/piano|organ|clav|harpsi|keys|polykey/.test(c)) return "i-midi";
  if (/fx|puls|hit|noise|beat|drum|perc|seq/.test(c)) return "i-noise";
  return "i-wave";
}
function hue(text) {
  let h = 0;
  for (const ch of text.toLowerCase()) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}
function art(category, cls = "") {
  const name = splitCat(category)[1] || "?";
  return `<div class="art ${cls}" style="--h:${hue(name)}"><svg><use href="#${catIcon(name)}"/></svg></div>`;
}

// ---------- 画面切り替え ----------
function showView(name) {
  $$(".nav button").forEach((b) => (b.getAttribute("data-view") === name ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
  $$(".view").forEach((v) => (v.hidden = v.id !== `view-${name}`));
  store.set("view", name);
  $(".content").scrollTop = 0;
  if (name === "library") loadPresets();
  if (name === "match") loadHistory();
  if (name === "sheet") loadSheets();
  document.dispatchEvent(new CustomEvent("viewchange", { detail: name }));
}
$$(".nav button").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));

// ---------- 楽器 ----------
async function loadInstruments() {
  const list = await api("/api/instruments");
  const sel = $("#instrument");
  sel.innerHTML = list.map((i) => `<option value="${esc(i.id)}">${esc(i.name)}${i.error ? "（設定エラー）" : ""}</option>`).join("");
  const fromUrl = new URLSearchParams(location.search).get("instrument");
  const saved = store.get("instrument");
  const pick = list.find((i) => i.id === fromUrl) || list.find((i) => i.id === saved && !i.error) || list.find((i) => i.type === "hardware" && !i.error) || list[0];
  if (pick) sel.value = pick.id;
  await selectInstrument(sel.value);
}
$("#instrument").addEventListener("change", (e) => selectInstrument(e.target.value));

async function selectInstrument(id) {
  state.inst = id;
  store.set("instrument", id);
  state.lib.group = "";
  await refreshInfo();
  loadDevices();
  if (!$("#view-library").hidden) loadPresets();
}

const perPreset = () => (state.info?.type === "hardware" ? 15 : 0.3);

async function refreshInfo() {
  const info = await api(`/api/instruments/${state.inst}`);
  state.info = info;
  const pct = info.total ? info.recorded / info.total : 0;

  $("#inst-settings").innerHTML = `<dt>設定ファイル</dt><dd><code>${esc(info.file)}</code></dd>` +
    Object.entries(info.settings).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  $("#stat-recorded").textContent = info.recorded.toLocaleString();
  $("#stat-total").textContent = info.total.toLocaleString();
  $("#ring-pct").textContent = `${Math.floor(pct * 100)}%`;
  $("#ring-fg").style.strokeDashoffset = 326.7 * (1 - pct);
  $("#stat-remaining").textContent = info.total === info.recorded ? "完了" : `約${fmtTime((info.total - info.recorded) * perPreset())}`;
  $("#side-count").textContent = `${info.recorded} / ${info.total}`;
  $("#side-bar").style.width = `${pct * 100}%`;

  const cats = info.categories.slice().sort((a, b) => a.name.localeCompare(b.name));
  const opts = `<option value="">すべてのカテゴリ</option>` + cats.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}（${c.recorded}/${c.total}）</option>`).join("");
  for (const id of ["#build-category", "#lib-category"]) {
    const sel = $(id), v = sel.value;
    sel.innerHTML = opts;
    sel.value = cats.some((c) => c.name === v) ? v : "";
  }

  const groups = {};
  for (const c of cats) (groups[splitCat(c.name)[0]] ||= []).push(c);
  const selected = $("#build-category").value;
  $("#cat-groups").innerHTML = Object.entries(groups).map(([g, list]) => {
    const t = list.reduce((a, c) => a + c.total, 0), r = list.reduce((a, c) => a + c.recorded, 0);
    return `<div class="cat-group">
      ${g ? `<div class="cat-group-head"><h3>${esc(GROUP_NAMES[g] || g)}</h3><div class="bar"><span style="width:${(r / t) * 100}%"></span></div><span class="muted small">${r}/${t}</span></div>` : ""}
      <div class="cat-grid">${list.map((c) => `
        <button class="cat ${c.recorded === c.total ? "complete" : ""}" data-cat="${esc(c.name)}" aria-pressed="${c.name === selected}">
          ${art(c.name)}
          <span class="cat-body">
            <span class="cat-name">${esc(splitCat(c.name)[1])}</span>
            <span class="cat-num">${c.recorded} / ${c.total}</span>
            <span class="bar"><span style="width:${(c.recorded / c.total) * 100}%"></span></span>
          </span>
        </button>`).join("")}</div></div>`;
  }).join("");
  $$(".cat").forEach((el) => el.addEventListener("click", () => {
    const sel = $("#build-category");
    sel.value = sel.value === el.dataset.cat ? "" : el.dataset.cat;
    syncCatSelection();
    $(".content").scrollTo({ top: 0, behavior: "smooth" });
  }));

  const scope = $("#match-scope"), scopeVal = scope.value;
  const recGroups = Object.entries(groups).filter(([g, list]) => g && list.some((c) => c.recorded));
  const recCats = cats.filter((c) => c.recorded);
  scope.innerHTML = `<option value="">録音済みの全音色（${info.recorded}）</option>` +
    (recGroups.length ? `<optgroup label="種類">${recGroups.map(([g, list]) => `<option value="${esc(g)}:">${esc(GROUP_NAMES[g] || g)}（${list.reduce((a, c) => a + c.recorded, 0)}）</option>`).join("")}</optgroup>` : "") +
    (recCats.length ? `<optgroup label="カテゴリ">${recCats.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}（${c.recorded}）</option>`).join("")}</optgroup>` : "");
  scope.value = [...scope.options].some((o) => o.value === scopeVal) ? scopeVal : "";

  const groupNames = Object.keys(groups).filter(Boolean);
  $("#lib-group-chips").innerHTML = groupNames.map((g) => `<button class="chip" data-group="${esc(g)}" aria-pressed="${state.lib.group === g}">${esc(GROUP_NAMES[g] || g)}</button>`).join("");
  $$("[data-group]").forEach((b) => b.addEventListener("click", () => {
    state.lib.group = state.lib.group === b.dataset.group ? "" : b.dataset.group;
    $$("[data-group]").forEach((x) => x.setAttribute("aria-pressed", x.dataset.group === state.lib.group));
    loadPresets();
  }));
  updateEstimate();
}

function syncCatSelection() {
  const v = $("#build-category").value;
  $$(".cat").forEach((el) => el.setAttribute("aria-pressed", el.dataset.cat === v));
  updateEstimate();
}

function updateEstimate() {
  if (!state.info) return;
  const cat = $("#build-category").value;
  const c = cat ? state.info.categories.find((x) => x.name === cat) : state.info;
  if (!c) return;
  let n = $("#build-overwrite").checked ? c.total : c.total - c.recorded;
  const limit = parseInt($("#build-limit").value);
  if (limit) n = Math.min(limit, n || c.total);
  $("#build-estimate").textContent = n ? `${n} 音色・約${fmtTime(n * perPreset())}` : "すべて録音済み";
}
$("#build-category").addEventListener("input", syncCatSelection);
["#build-limit", "#build-overwrite"].forEach((s) => $(s).addEventListener("input", updateEstimate));

async function loadDevices() {
  const box = $("#devices");
  box.innerHTML = `<span class="muted">確認中…</span>`;
  const pills = $("#conn-pills"), stat = $("#stat-conn");
  try {
    const d = await api("/api/devices");
    box.innerHTML = `
      <p class="eyebrow">MIDI出力</p><ul>${d.midi_outputs.map((n) => `<li>${esc(n)}</li>`).join("") || "<li class='muted'>なし</li>"}</ul>
      <p class="eyebrow">オーディオ入力</p><ul>${d.audio_inputs.map((a) => `<li>${esc(a.name)} <span class="muted">(${a.channels}ch, ${a.sample_rate}Hz)</span></li>`).join("") || "<li class='muted'>なし</li>"}</ul>
      ${d.errors.map((e) => `<p class="muted small">${esc(e)}</p>`).join("")}
      <p class="muted small">名前が違う場合は ${esc(state.info?.file ?? "楽器設定")} を書き換えて、ページを再読み込みしてください。</p>`;
    if (state.info?.type !== "hardware") {
      pills.innerHTML = stat.innerHTML = `<span class="pill ok">接続不要</span>`;
      return;
    }
    const has = (list, want) => list.some((n) => n.toLowerCase().includes(want.toLowerCase()));
    const port = state.info.settings["MIDI出力"], dev = state.info.settings["録音デバイス"];
    const midiOk = has(d.midi_outputs, port);
    const audioOk = dev.startsWith("(") || has(d.audio_inputs.map((a) => a.name), dev);
    const html = `<span class="pill ${midiOk ? "ok" : "warn"}">MIDI ${midiOk ? "OK" : "未接続"}</span><span class="pill ${audioOk ? "ok" : "warn"}">録音 ${audioOk ? "OK" : "未接続"}</span>`;
    pills.innerHTML = stat.innerHTML = html;
    $("#devices-box").open = !(midiOk && audioOk);
  } catch (e) {
    box.textContent = e.message;
  }
}
$("#refresh-devices").addEventListener("click", loadDevices);

// ---------- テスト録音 ----------
$("#test-preset-q").addEventListener("input", async (e) => {
  const q = e.target.value.trim();
  if (q.length < 2) return;
  const r = await api(`/api/instruments/${state.inst}/presets?q=${encodeURIComponent(q)}&limit=30`);
  $("#test-preset-list").innerHTML = r.presets.map((p) => `<option value="${esc(p.name)}">${esc(p.category)}</option>`).join("");
});

$("#test-btn").addEventListener("click", async () => {
  let preset_id = null;
  const q = $("#test-preset-q").value.trim();
  if (q) {
    const r = await api(`/api/instruments/${state.inst}/presets?q=${encodeURIComponent(q)}&limit=50`);
    const hit = r.presets.find((p) => p.name === q) || r.presets[0];
    if (!hit) return toast("その名前の音色が見つかりません");
    preset_id = hit.id;
  }
  $("#test-result").innerHTML = `<div class="verdict"><span class="rec-dot"></span><div class="verdict-body">録音しています…</div></div>`;
  startJob(() => post(`/api/instruments/${state.inst}/test`, { preset_id }));
});

// ---------- ライブラリ録音 ----------
$("#build-btn").addEventListener("click", () => {
  startJob(() => post(`/api/instruments/${state.inst}/build`, {
    category: $("#build-category").value || null,
    limit: parseInt($("#build-limit").value) || null,
    overwrite: $("#build-overwrite").checked,
  }));
});

function recordOne(id, name, recorded) {
  if (recorded && !confirm(`「${name}」を録音し直しますか？`)) return;
  startJob(() => post(`/api/instruments/${state.inst}/build`, { ids: [id], overwrite: true }));
}

async function findPreset(q) {
  const r = await api(`/api/instruments/${state.inst}/presets?q=${encodeURIComponent(q)}&limit=50`);
  return r.presets.find((p) => p.name.toLowerCase() === q.toLowerCase()) || r.presets[0];
}
$("#one-q").addEventListener("input", async (e) => {
  const q = e.target.value.trim();
  if (q.length < 2) return;
  const r = await api(`/api/instruments/${state.inst}/presets?q=${encodeURIComponent(q)}&limit=30`);
  $("#one-list").innerHTML = r.presets.map((p) => `<option value="${esc(p.name)}">${esc(p.category)}${p.recorded ? "・録音済み" : ""}</option>`).join("");
});
$("#one-btn").addEventListener("click", async () => {
  const q = $("#one-q").value.trim();
  if (!q) return toast("録音したい音色名を入力してください");
  const p = await findPreset(q);
  if (!p) return toast("その名前の音色が見つかりません");
  recordOne(p.id, p.name, p.recorded);
});

// ---------- ライブラリ ----------
let presetTimer;
async function loadPresets() {
  if (!state.inst) return;
  const params = new URLSearchParams({ limit: 240 });
  const q = $("#lib-q").value.trim();
  if (q) params.set("q", q);
  const cat = $("#lib-category").value || state.lib.group;
  if (cat) params.set("category", cat);
  if (state.lib.rec) params.set("recorded", state.lib.rec);
  const r = await api(`/api/instruments/${state.inst}/presets?${params}`);
  $("#lib-count").textContent = r.total > r.presets.length ? `${r.total.toLocaleString()} 音色中 ${r.presets.length} 音色を表示（検索やカテゴリで絞り込めます）` : `${r.total.toLocaleString()} 音色`;
  if (!r.presets.length) {
    $("#lib-tiles").innerHTML = `<div class="empty-state" style="grid-column:1/-1">条件に合う音色がありません</div>`;
    return;
  }
  $("#lib-tiles").innerHTML = r.presets.map((p, i) => `
    <div class="tile ${p.recorded ? "" : "unrec"}" data-i="${i}">
      <div class="tile-art-wrap">
        ${art(p.category)}
        ${p.audio ? `<button class="fab" data-play="${i}" aria-label="${esc(p.name)}を再生"><svg><use href="#i-play"/></svg></button>` : ""}
      </div>
      <div class="tile-title" title="${esc(p.name)}（クリックで詳細）">${esc(p.name)}</div>
      <div class="tile-sub">${esc(splitCat(p.category)[1])}</div>
      <div class="tile-foot">
        ${p.recorded ? `<span class="pill ok">済</span>` : `<span class="pill">未録音</span>`}
        <button class="btn ghost small" data-rec="${i}"><svg><use href="#${p.recorded ? "i-redo" : "i-rec"}"/></svg>${p.recorded ? "録り直す" : "録音"}</button>
      </div>
    </div>`).join("");
  $$("[data-play]", $("#lib-tiles")).forEach((b) => b.addEventListener("click", () => {
    const p = r.presets[b.dataset.play];
    player.play({ src: p.audio, title: p.name, sub: p.category, category: p.category });
  }));
  $$("[data-rec]", $("#lib-tiles")).forEach((b) => b.addEventListener("click", () => {
    const p = r.presets[b.dataset.rec];
    recordOne(p.id, p.name, p.recorded);
  }));
  $$(".tile", $("#lib-tiles")).forEach((t) => t.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    openTone(r.presets[t.dataset.i].id);
  }));
}
$("#lib-q").addEventListener("input", () => { clearTimeout(presetTimer); presetTimer = setTimeout(loadPresets, 250); });
$("#lib-category").addEventListener("input", loadPresets);
$$("[data-rec]", $("#lib-chips")).forEach((b) => b.addEventListener("click", () => {
  state.lib.rec = b.dataset.rec;
  $$("[data-rec]", $("#lib-chips")).forEach((x) => x.setAttribute("aria-pressed", x === b));
  loadPresets();
}));

// ---------- 音色の詳細（分析） ----------
const TRAITS = [
  { key: "brightness", label: "明るさ", ends: ["暗い", "明るい"], fmt: (v) => `${v.toFixed(2)} oct`, desc: "音の重心が基音から何オクターブ上にあるか" },
  { key: "attack_ms", label: "アタック", ends: ["速い", "ゆっくり"], fmt: (v) => `${Math.round(v)} ms`, desc: "立ち上がりにかかる時間" },
  { key: "sustain_db", label: "サステイン", ends: ["減衰する", "伸びる"], fmt: (v) => `${v.toFixed(1)} dB`, desc: "押さえている間の音量の下がり方" },
  { key: "release_s", label: "余韻", ends: ["短い", "長い"], fmt: (v) => `${v.toFixed(2)} s`, desc: "鍵盤を離してからの余韻（リリース＋リバーブ）" },
  { key: "noisiness", label: "ノイズ感", ends: ["きれい", "ノイズ寄り"], fmt: (v) => v.toFixed(2), desc: "ノイズっぽさ" },
];

async function openTone(presetId) {
  const dlg = $("#tone-dialog");
  let d;
  try {
    d = await api(`/api/instruments/${state.inst}/preset?preset_id=${encodeURIComponent(presetId)}`);
  } catch (e) { return toast(e.message); }
  const midi = d.midi && d.midi.msb !== undefined ? `<span class="pill plain">MSB ${d.midi.msb} / LSB ${d.midi.lsb} / PC ${d.midi.pc}</span>` : "";
  const traits = d.profile ? TRAITS.map((t) => {
    const v = d.profile[t.key], p = d.percentile?.[t.key];
    return `<div class="trait ${v == null ? "na" : ""}" title="${esc(t.desc)}">
      <div class="trait-top"><b>${t.label}</b><span>${v == null ? "測れませんでした" : `${t.fmt(v)}${p == null ? "" : ` ・ ライブラリ内 ${p}%`}`}</span></div>
      <div class="trait-scale">${p == null ? "" : `<i style="left:${p}%"></i>`}</div>
      <div class="trait-ends"><span>${t.ends[0]}</span><span>${t.ends[1]}</span></div>
    </div>`;
  }).join("") : `<div class="empty-state">まだ録音していないので、分析結果はありません。<br>「この音色を録音」を押すと録音して分析します。</div>`;
  $("#tone-body").innerHTML = `
    <div class="tone-head">
      ${art(d.category)}
      <div>
        <div class="eyebrow">${esc(splitCat(d.category)[0] ? GROUP_NAMES[splitCat(d.category)[0]] || splitCat(d.category)[0] : "音色")}</div>
        <h2 id="tone-name">${esc(d.name)}</h2>
        <div class="muted small">${esc(splitCat(d.category)[1])}</div>
        <div class="tone-meta">${d.recorded ? `<span class="pill ok">録音済み</span>` : `<span class="pill">未録音</span>`}${midi}</div>
      </div>
      <button class="icon-btn close" aria-label="閉じる"><svg><use href="#i-x"/></svg></button>
    </div>
    <div class="tone-content">
      <div class="tone-actions">
        ${d.audio ? `<button class="btn primary" data-act="play"><svg><use href="#i-play"/></svg>聴く</button>` : ""}
        <button class="btn" data-act="rec"><svg><use href="#${d.recorded ? "i-redo" : "i-rec"}"/></svg>${d.recorded ? "録り直す" : "この音色を録音"}</button>
        <button class="btn ghost" data-act="find"><svg><use href="#i-find"/></svg>このカテゴリの中から曲に合う音色を探す</button>
      </div>
      <div>
        <div class="section-head" style="margin:0 0 10px"><h2 style="font-size:16px">音の特徴</h2>
          ${d.profile ? `<span class="muted small">ライブラリの ${d.library_size} 音色の中での位置</span>` : ""}</div>
        <div class="traits">${traits}</div>
      </div>
    </div>`;
  $(".close", dlg).addEventListener("click", () => dlg.close());
  $("[data-act=play]", dlg)?.addEventListener("click", () => player.play({ src: d.audio, title: d.name, sub: d.category, category: d.category }));
  $("[data-act=rec]", dlg).addEventListener("click", () => { dlg.close(); recordOne(d.id, d.name, d.recorded); });
  $("[data-act=find]", dlg).addEventListener("click", () => {
    dlg.close();
    showView("match");
    const scope = $("#match-scope");
    if ([...scope.options].some((o) => o.value === d.category)) scope.value = d.category;
    else toast("このカテゴリはまだ録音済みの音色がありません");
  });
  if (!dlg.open) dlg.showModal();
}
$("#tone-dialog").addEventListener("click", (e) => { if (e.target.id === "tone-dialog") e.target.close(); });

// ---------- 曲から探す ----------
const orb = $("#song-drop");
const songInput = $("input[name=song]", orb);
const midiInput = $("input[name=midi]");
function showSong() {
  const f = songInput.files[0];
  orb.classList.toggle("has-file", !!f);
  $("#finder-title").textContent = f ? f.name : "曲をドロップして音色を探す";
  $("#finder-sub").textContent = f ? `${(f.size / 1024 / 1024).toFixed(1)} MB ・ 準備OK。「探す」を押してください` : "mp3 / wav をドロップ、または丸をクリックして選択";
  $("#match-btn").disabled = !f || isActive(state.job);
}
songInput.addEventListener("change", showSong);
const finder = $("#match-form");
finder.addEventListener("dragover", (e) => { e.preventDefault(); orb.classList.add("over"); });
finder.addEventListener("dragleave", (e) => { if (!finder.contains(e.relatedTarget)) orb.classList.remove("over"); });
finder.addEventListener("drop", (e) => {
  e.preventDefault();
  orb.classList.remove("over");
  const files = [...e.dataTransfer.files];
  const mid = files.find((f) => /\.midi?$/i.test(f.name));
  const song = files.find((f) => f !== mid);
  const put = (input, file) => { const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; };
  if (song) { put(songInput, song); showSong(); }
  if (mid) { put(midiInput, mid); showMidi(); }
});
function showMidi() {
  const f = midiInput.files[0];
  $("#midi-btn").classList.toggle("has-file", !!f);
  $("#midi-btn span").textContent = f ? `MIDI: ${f.name}` : "MIDIを追加（任意）";
}
midiInput.addEventListener("change", showMidi);

finder.addEventListener("submit", (e) => {
  e.preventDefault();
  const fd = new FormData(finder);
  fd.set("instrument_id", state.inst);
  if (!midiInput.files.length) fd.delete("midi");
  $("#match-result").innerHTML = "";
  $("#match-log").textContent = "アップロード中…";
  startJob(() => api("/api/match", { method: "POST", body: fd }));
});

function hintIcon(h) {
  if (/カットオフ|cutoff|フィルター/i.test(h)) return "i-filter";
  if (/リバーブ|reverb|余韻|残響/i.test(h)) return "i-verb";
  if (/ノイズ|noise/i.test(h)) return "i-noise";
  return "i-env";
}
const hintList = (hints) => hints.length
  ? hints.map((h) => `<li><svg><use href="#${hintIcon(h)}"/></svg><span>${esc(h)}</span></li>`).join("")
  : `<li class="none"><svg><use href="#i-check"/></svg><span>大きな違いは見つかりませんでした</span></li>`;

function renderMatch(r, scroll = false) {
  const [best, ...rest] = r.candidates;
  if (!best) { $("#match-result").innerHTML = `<div class="empty-state">候補が見つかりませんでした</div>`; return; }
  const target = { src: r.target_audio, title: "取り出したキーボードの音", sub: "原曲", category: "" };
  const cand = (c) => ({ src: c.audio, title: c.name, sub: c.category, category: c.category });
  $("#match-result").innerHTML = `
    <div class="result-hero">
      ${art(best.category)}
      <div>
        <div class="eyebrow">いちばん近い音色</div>
        <h2>${esc(best.name)}</h2>
        <div class="meta">${esc(best.category)} ・ スコア ${best.score}（${best.stage === "rerank" ? "実際に鳴らして比較" : "ライブラリで比較"}）</div>
        <div class="hero-actions">
          ${best.audio ? `<button class="btn primary" data-ab="0"><svg><use href="#i-play"/></svg>原曲とA/B比較</button>
          <button class="btn" data-cand="0"><svg><use href="#i-play"/></svg>この音色を聴く</button>` : ""}
          <button class="btn ghost" data-target><svg><use href="#i-play"/></svg>取り出した音</button>
        </div>
        <ul class="hints">${hintList(best.hints)}</ul>
        <div class="links"><a href="${esc(r.report_html || r.report_md)}" target="_blank">レポートを開く</a><a href="${esc(r.midi)}" download>MIDIをダウンロード</a>${r.category ? `<span class="muted">探した範囲: ${esc(r.category)}</span>` : ""}</div>
      </div>
    </div>
    ${rest.length ? `<div class="section-head"><h2>ほかの候補</h2><span class="muted small">上から近い順。スコアは小さいほど近い</span></div>
    <div class="list others">${rest.map((c, i) => `
      <div class="row">
        <span class="rank-num">${c.rank}</span>
        ${art(c.category)}
        <div class="row-body">
          <div class="row-title">${esc(c.name)}</div>
          <div class="row-sub">${esc(c.category)} ・ ${c.stage === "rerank" ? `スコア ${c.score}（実際に鳴らして比較）` : `ライブラリで比較（スコア ${c.score}・参考値）`}</div>
          ${c.hints.length ? `<ul class="row-hints">${c.hints.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>` : ""}
        </div>
        ${c.audio ? `<button class="btn small" data-ab="${i + 1}">A/B</button><button class="icon-btn" data-cand="${i + 1}" aria-label="再生"><svg><use href="#i-play"/></svg></button>` : ""}
      </div>`).join("")}</div>` : ""}`;
  const all = r.candidates;
  $$("[data-ab]", $("#match-result")).forEach((b) => b.addEventListener("click", () => player.compare(target, cand(all[b.dataset.ab]))));
  $$("[data-cand]", $("#match-result")).forEach((b) => b.addEventListener("click", () => player.play(cand(all[b.dataset.cand]))));
  $("[data-target]", $("#match-result")).addEventListener("click", () => player.play(target));
  if (scroll) $("#match-result").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function loadHistory() {
  const rows = await api("/api/history").catch(() => []);
  $("#history").innerHTML = rows.map((h) => `
    <div class="row">
      ${art(h.top_category || h.top || h.name)}
      <div class="row-body">
        <div class="row-title">${esc(h.name.replace(/^\d{8}-\d{6}_/, ""))}</div>
        <div class="row-sub">${esc(h.name.slice(0, 15).replace(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2}).*/, "$1/$2/$3 $4:$5"))} ・ 1位: ${esc(h.top ?? "-")} ・ ${esc(h.instrument)}</div>
      </div>
      <a href="${esc(h.report)}" target="_blank">レポート</a>
    </div>`).join("") || `<div class="empty-state">まだありません。上の丸に曲をドロップして始めましょう。</div>`;
}

// ---------- 楽譜にする ----------
const sheetOrb = $("#sheet-drop");
const sheetInput = $("input[name=file]", sheetOrb);
const sheetForm = $("#sheet-form");

function showSheetFile() {
  const f = sheetInput.files[0];
  sheetOrb.classList.toggle("has-file", !!f);
  $("#sheet-title").textContent = f ? f.name : "ピアノの音から楽譜を作る";
  $("#sheet-sub").textContent = f ? `${(f.size / 1024 / 1024).toFixed(1)} MB ・ 準備OK。「楽譜にする」を押してください` : "ピアノだけの mp3 / wav / mp4 / 動画をドロップ、または丸をクリックして選択";
  $("#sheet-btn").disabled = !f || isActive(state.job);
}
sheetInput.addEventListener("change", showSheetFile);
sheetForm.addEventListener("dragover", (e) => { e.preventDefault(); sheetOrb.classList.add("over"); });
sheetForm.addEventListener("dragleave", (e) => { if (!sheetForm.contains(e.relatedTarget)) sheetOrb.classList.remove("over"); });
sheetForm.addEventListener("drop", (e) => {
  e.preventDefault();
  sheetOrb.classList.remove("over");
  const f = e.dataTransfer.files[0];
  if (!f) return;
  const dt = new DataTransfer();
  dt.items.add(f);
  sheetInput.files = dt.files;
  showSheetFile();
});
sheetForm.addEventListener("submit", (e) => {
  e.preventDefault();
  $("#sheet-result").innerHTML = "";
  $("#sheet-log").textContent = "アップロード中…";
  startJob(() => api("/api/sheet", { method: "POST", body: new FormData(sheetForm) }));
});

function renderSheetJob(job) {
  const running = isActive(job);
  $("#sheet-run").hidden = job.status === "done";
  const log = job.log.join("\n");
  $("#sheet-log").textContent = log + (job.error ? `\n\nエラー: ${job.error}` : "");
  $("#sheet-log").scrollTop = 1e9;
  const m = [...log.matchAll(/\[(\d)\/4\]/g)].pop();
  const step = job.status === "done" ? 5 : m ? +m[1] : 1;
  $$("#sheet-steps li").forEach((li) => {
    const n = +li.dataset.step;
    li.classList.toggle("done", n < step);
    li.classList.toggle("active", running && n === step);
  });
  $("#sheet-status").textContent = job.status === "queued"
    ? `順番待ち（${job.position}番目）。前の人の処理が終わると自動で始まります`
    : running ? job.message : { cancelled: "中止しました", error: `エラー: ${job.error}` }[job.status] || "";
  $("[data-cancel]", $("#sheet-run")).hidden = !running;
}

// 調の名前を日本語に（例: "F# minor" → 嬰ヘ短調）
function keyJa(k) {
  const m = /^([A-G])([#b]?) (major|minor)$/.exec(k || "");
  if (!m) return k || "-";
  const name = { C: "ハ", D: "ニ", E: "ホ", F: "ヘ", G: "ト", A: "イ", B: "ロ" }[m[1]];
  return `${m[2] === "#" ? "嬰" : m[2] === "b" ? "変" : ""}${name}${m[3] === "major" ? "長調" : "短調"}`;
}

// 調号（♯は正・♭は負）と、その調号の長調・短調
const KEY_SIGS = {
  "-7": ["Cb", "Ab"], "-6": ["Gb", "Eb"], "-5": ["Db", "Bb"], "-4": ["Ab", "F"], "-3": ["Eb", "C"], "-2": ["Bb", "G"], "-1": ["F", "D"],
  "0": ["C", "A"], "1": ["G", "E"], "2": ["D", "B"], "3": ["A", "F#"], "4": ["E", "C#"], "5": ["B", "G#"], "6": ["F#", "D#"], "7": ["C#", "A#"],
};
const sigLabel = (n) => (n === 0 ? "なし" : `${n > 0 ? "♯" : "♭"}${Math.abs(n)}つ`);
// 同じ調号の長調・短調（例: ♭5つ → 変ニ長調／変ロ短調）
const keyPair = (n) => { const [maj, min] = KEY_SIGS[String(n)] || ["C", "A"]; return `${keyJa(maj + " major")}／${keyJa(min + " minor")}`; };
const SIG_RANGE = Object.keys(KEY_SIGS).map(Number).filter((n) => Math.abs(n) <= 6).sort((a, b) => a - b);
function keyModeOptions(m) {
  const manual = m.key_fixed || m.key_plan_fixed;
  return [
    `<option value="keep" selected>${manual ? "今のまま（手で直した調号）" : "今のまま"}</option>`,
    `<option value="auto">自動で推定し直す（転調も検出）</option>`,
    ...SIG_RANGE.map((n) => `<option value="whole:${n}">曲全体を ${sigLabel(n)}（${esc(keyPair(n))}）</option>`),
  ].join("");
}
const BAR_BEATS = { "4/4": 4, "3/4": 3, "2/4": 2, "6/8": 3 };
// 調号の区間（古い結果には key_plan がないので、転調の一覧から作る）
function keyPlanOf(m) {
  if (m.key_plan?.length) return m.key_plan.map((p) => ({ ...p }));
  const bar = BAR_BEATS[m.time_signature] || 4;
  return [{ measure: 1, sharps: m.key_sharps ?? 0 }, ...(m.modulations || [])].map((x) => ({ beat: (x.measure - 1) * bar, measure: x.measure, sharps: x.sharps }));
}

function sheetArt(title) {
  return `<div class="art" style="--h:${hue(title || "score")}"><svg><use href="#i-score"/></svg></div>`;
}

function renderSheet(m, scroll = false) {
  const u = m.urls;
  const opt = (vals, cur) => vals.map(([v, t]) => `<option value="${v}" ${String(v) === String(cur) ? "selected" : ""}>${t}</option>`).join("");
  $("#sheet-result").innerHTML = `
    <div class="card">
      <div class="sheet-head">
        <div>
          <div class="eyebrow">楽譜</div>
          <h2>${esc(m.title)}</h2>
          <div class="facts">
            <div class="fact"><b>${sigLabel(m.key_sharps ?? 0)}</b><span>調号（${esc(keyPair(m.key_sharps ?? 0))}）${m.key_fixed || m.key_plan_fixed ? "・指定" : ""}${m.modulations?.length ? `・転調${m.modulations.length}回` : ""}</span></div>
            <div class="fact"><b>${esc(m.time_signature)}</b><span>拍子</span></div>
            <div class="fact"><b>${Math.round(m.bpm)}</b><span>テンポ${m.bpm_fixed ? "（指定）" : "（自動）"}</span></div>
            <div class="fact"><b>${m.measures}</b><span>小節</span></div>
            <div class="fact"><b>${m.notes}</b><span>音</span></div>
          </div>
          <div class="mods">
            <span class="muted small">${keyPlanOf(m).length > 1 ? "転調" : "調号"}</span>
            ${keyPlanOf(m).map((x, i) => `<span class="mod-item">${i ? '<span class="mod-arrow">→</span>' : ""}<label class="mod">
              <b>小節${x.measure}〜</b>
              <select data-section="${i}" aria-label="小節${x.measure}からの調号">
                ${SIG_RANGE.map((n) => `<option value="${n}" ${n === x.sharps ? "selected" : ""}>${sigLabel(n)}</option>`).join("")}
                ${i ? `<option value="remove">転調をなくす</option>` : ""}
              </select>
              <small>${esc(keyPair(x.sharps))}</small></label></span>`).join("")}
            ${m.key_fixed || m.key_plan_fixed
              ? `<span class="pill warn plain-pill">手で指定中</span><button class="btn ghost small" data-key-auto><svg><use href="#i-redo"/></svg>自動に戻す</button>`
              : `<span class="muted small edit-only">区間ごとに調号を選び直せます（ほかの区間はそのまま）</span>`}
          </div>
          <div class="hero-actions">
            <button class="btn primary" data-sheet-ab="score"><svg><use href="#i-play"/></svg>原曲 ↔ 楽譜どおり</button>
            <button class="btn" data-sheet-ab="preview"><svg><use href="#i-play"/></svg>原曲 ↔ 採譜（演奏そのまま）</button>
          </div>
          ${m.playback === "simple" ? `<p class="muted small">※ ピアノ音源（FluidSynth）が使えなかったため、簡易な音で鳴らしています。</p>` : ""}
        </div>
        <div class="downloads">
          <a class="btn" href="${esc(u.pdf)}" download="${esc(m.title)}.pdf"><svg><use href="#i-download"/></svg>PDF（印刷用）</a>
          <a class="btn" href="${esc(u.musicxml)}" download="${esc(m.title)}.musicxml"><svg><use href="#i-download"/></svg>MusicXML（MuseScoreで編集）</a>
          <a class="btn" href="${esc(u.score_midi)}" download="${esc(m.title)}.mid"><svg><use href="#i-download"/></svg>MIDI（楽譜どおり）</a>
          <a class="btn ghost" href="${esc(u.transcription_midi)}" download="${esc(m.title)}_演奏.mid"><svg><use href="#i-download"/></svg>MIDI（演奏そのまま）</a>
          ${u.score_audio ? `<a class="btn ghost" href="${esc(u.score_audio)}" download="${esc(m.title)}_楽譜どおり.wav"><svg><use href="#i-download"/></svg>音声（楽譜どおり）</a>` : ""}
        </div>
      </div>
      <div class="roll-wrap">
        <div class="roll-box"><canvas class="roll" id="sheet-roll"></canvas><div class="roll-head" id="roll-head" hidden></div></div>
        <div class="roll-legend"><span><i style="background:var(--accent)"></i>右手</span><span><i style="background:var(--accent-2)"></i>左手</span><span><i class="ghost-key"></i>弾いていないと判断して除いた音</span><span>横 = 時間・縦 = 音の高さ</span></div>
        ${m.cleanup && m.sensitivity !== "off" ? `<p class="muted small">弾いていないと思われる弱い音・短すぎる音を <b>${m.cleanup.removed}</b> 個除き、少しずれて弾いた <b>${m.cleanup.merged}</b> 個の音を和音にそろえました。除きすぎ・残しすぎと感じたら「音を拾う量」を変えて作り直してください。</p>` : ""}
      </div>
      <form class="rebuild edit-only" id="sheet-rebuild">
        <label class="field">調号<select name="key_mode">${keyModeOptions(m)}</select></label>
        <label class="field">音を拾う量<select name="sensitivity">${opt([["low", "少なめ"], ["normal", "ふつう"], ["high", "多め"], ["off", "除かない"]], m.sensitivity || "normal")}</select></label>
        <label class="field">拍子<select name="time_signature">${opt([["4/4", "4/4"], ["3/4", "3/4"], ["2/4", "2/4"], ["6/8", "6/8"]], m.time_signature)}</select></label>
        <label class="field">テンポ（空欄で自動）<input name="bpm" type="number" min="30" max="300" step="0.1" value="${m.bpm_fixed ? m.bpm : ""}" placeholder="自動（${Math.round(m.bpm)}）"></label>
        <label class="field">リズムの細かさ<select name="grid">${opt([[4, "16分音符まで"], [2, "8分音符まで"]], m.grid)}</select></label>
        <label class="field">右手と左手の境目<select name="split">${opt([[55, "G3"], [60, "C4（真ん中のド）"], [64, "E4"]], m.split)}</select></label>
        <button class="btn" type="submit"><svg><use href="#i-redo"/></svg>この設定で作り直す</button>
      </form>
      <p class="muted small edit-only">作り直しは採譜をやり直さないので数秒で終わります。拍がずれていると感じたら、テンポを指定するか拍子を変えてみてください。</p>
    </div>
    <div class="score-bar">
      <label class="check"><input type="checkbox" id="score-follow" ${store.get("scoreFollow") === "0" ? "" : "checked"}>再生位置についていく</label>
      <span class="muted small">小節をクリックすると、そこから再生します</span>
    </div>
    <div class="pages" id="sheet-pages"><div class="loading">楽譜を読み込んでいます…</div></div>`;

  // 再生中の音が楽譜のどこにあたるか（kind: perf = 原曲・演奏そのまま、score = 楽譜どおりの音）
  const timed = (track, kind) => ({
    ...track, sheet: m.name, kind,
    toQ: (t) => scoreView.toQ(m.name, kind, t),
    fromQ: (q) => scoreView.fromQ(m.name, kind, q),
  });
  const orig = timed({ src: u.audio, title: `${m.title}（原曲）`, sub: "原曲", category: "" }, "perf");
  const other = {
    preview: [timed({ src: u.preview, title: "採譜（演奏そのまま）", sub: m.title, category: "" }, "perf"), "B 採譜"],
    score: [timed({ src: u.score_audio || u.preview, title: "楽譜どおりの音", sub: m.title, category: "" }, u.score_audio ? "score" : "perf"), "B 楽譜"],
  };
  const compare = (which) => {
    const [track, label] = other[which];
    player.compare(orig, track, ["A 原曲", label]);
  };
  $$("[data-sheet-ab]").forEach((b) => b.addEventListener("click", () => compare(b.dataset.sheetAb)));
  $("#score-follow").addEventListener("change", (e) => store.set("scoreFollow", e.target.checked ? "1" : "0"));
  // 作り直し：調号以外の設定は、いま画面の設定欄に入っている値を使う
  const rebuildWith = (keySpec) => {
    const f = new FormData($("#sheet-rebuild"));
    const bpm = f.get("bpm");
    startJob(() => post(`/api/sheets/${encodeURIComponent(m.name)}/rebuild`, {
      bpm: bpm ? parseFloat(bpm) : null, time_signature: f.get("time_signature"), grid: +f.get("grid"), split: +f.get("split"),
      sensitivity: f.get("sensitivity"), ...keySpec,
    }));
  };
  $$("[data-section]", $("#sheet-result")).forEach((sel) => sel.addEventListener("change", () => {
    const plan = keyPlanOf(m);
    const i = +sel.dataset.section;
    if (sel.value === "remove") plan.splice(i, 1);
    else plan[i].sharps = +sel.value;
    rebuildWith({ key_mode: "plan", key_plan: plan.map((p) => ({ beat: p.beat, sharps: p.sharps })) });
  }));
  $("[data-key-auto]", $("#sheet-result"))?.addEventListener("click", () => rebuildWith({ key_mode: "auto" }));
  $("#sheet-rebuild").addEventListener("submit", (e) => {
    e.preventDefault();
    const mode = new FormData(e.target).get("key_mode");
    rebuildWith(mode.startsWith("whole:") ? { key_mode: "whole", key_sharps: +mode.slice(6) } : { key_mode: mode });
  });
  drawRoll($("#sheet-roll"), m.roll, m.split, m.duration);
  if (SHARE) $$("#sheet-result select").forEach((s) => (s.disabled = true));
  scoreView.open(m, () => compare("score"));
  if (scroll) $("#sheet-result").scrollIntoView({ behavior: "smooth", block: "start" });
}

const pageImages = (urls) => urls.map((p, i) => `<div class="page"><img src="${esc(p)}" alt="楽譜 ${i + 1}ページ目" loading="lazy"></div>`).join("");

function drawRoll(canvas, roll, split, duration) {
  if (!roll?.length) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const colR = css.getPropertyValue("--accent").trim(), colL = css.getPropertyValue("--accent-2").trim(), line = css.getPropertyValue("--line").trim();
  const lo = Math.min(...roll.map((n) => n[0])) - 2, hi = Math.max(...roll.map((n) => n[0])) + 2;
  const end = Math.max(duration || 0, ...roll.map((n) => n[2]));
  canvas.dataset.end = end;
  const y = (p) => h - ((p - lo) / (hi - lo)) * h;
  ctx.strokeStyle = line;
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(0, y(split - 0.5)); ctx.lineTo(w, y(split - 0.5)); ctx.stroke();
  ctx.setLineDash([]);
  const rowH = Math.max(2, h / (hi - lo) - 1);
  const muted = css.getPropertyValue("--text-3").trim();
  for (const [p, s, e, v, used = true] of roll) {
    const x = (s / end) * w, bw = Math.max(2, ((e - s) / end) * w);
    if (!used) {
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = muted;
      ctx.setLineDash([2, 2]);
      ctx.strokeRect(x, y(p) - rowH / 2, Math.max(4, bw), rowH);
      ctx.setLineDash([]);
      continue;
    }
    ctx.globalAlpha = 0.35 + 0.65 * (v / 127);
    ctx.fillStyle = p >= split ? colR : colL;
    ctx.fillRect(x, y(p) - rowH / 2, bw, rowH);
  }
  ctx.globalAlpha = 1;
}

async function loadSheets() {
  const rows = await api("/api/sheets").catch(() => []);
  $("#sheet-history").innerHTML = rows.map((r, i) => `
    <div class="row" data-sheet="${i}" style="cursor:pointer">
      ${sheetArt(r.title)}
      <div class="row-body">
        <div class="row-title">${esc(r.title)}</div>
        <div class="row-sub">${esc(r.created.replace("T", " ").slice(0, 16))} ・ ${esc(keyJa(r.key))} ・ ${esc(r.time_signature)} ・ ${r.measures}小節${r.modulations?.length ? ` ・ 転調${r.modulations.length}回` : ""}</div>
      </div>
      <a href="${esc(r.urls.pdf)}" download="${esc(r.title)}.pdf">PDF</a>
    </div>`).join("") || `<div class="empty-state">まだありません。上の丸にピアノの音声をドロップして始めましょう。</div>`;
  $$("[data-sheet]", $("#sheet-history")).forEach((el) => el.addEventListener("click", async (e) => {
    if (e.target.closest("a")) return;
    renderSheet(await api(`/api/sheets/${encodeURIComponent(rows[el.dataset.sheet].name)}`), true);
  }));
}

// ---------- プレイヤー ----------
const player = (() => {
  const audio = new Audio();
  const canvas = $("#pl-wave");
  const ctx = canvas.getContext("2d");
  const peaksCache = new Map();
  let tracks = null, which = "a", peaks = null, raf = 0, labels = ["A 原曲", "B 音色"], pendingSeek = null, loading = false;

  const cur = () => tracks?.[which];

  async function loadPeaks(src) {
    if (peaksCache.has(src)) return peaksCache.get(src);
    const p = (async () => {
      const buf = await (await fetch(src)).arrayBuffer();
      const AC = window.AudioContext || window.webkitAudioContext;
      const ac = new AC();
      const data = (await ac.decodeAudioData(buf)).getChannelData(0);
      ac.close();
      const n = 400, step = Math.max(1, Math.floor(data.length / n)), out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let m = 0;
        for (let j = i * step; j < Math.min((i + 1) * step, data.length); j += 16) m = Math.max(m, Math.abs(data[j]));
        out[i] = m;
      }
      const max = Math.max(...out) || 1;
      return out.map((v) => v / max);
    })().catch(() => null);
    peaksCache.set(src, p);
    return p;
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const css = getComputedStyle(document.documentElement);
    const played = css.getPropertyValue("--accent").trim(), rest = css.getPropertyValue("--hover").trim();
    const prog = audio.duration ? audio.currentTime / audio.duration : 0;
    const bars = Math.max(20, Math.floor(w / 4));
    for (let i = 0; i < bars; i++) {
      const v = peaks ? peaks[Math.floor((i / bars) * peaks.length)] : 0.08;
      const bh = Math.max(2, v * h);
      ctx.fillStyle = i / bars < prog ? played : rest;
      ctx.fillRect(i * (w / bars), (h - bh) / 2, Math.max(1, w / bars - 1.5), bh);
    }
    $("#pl-time").textContent = clock(audio.currentTime);
    $("#pl-dur").textContent = clock(audio.duration);
  }
  function loop() { draw(); raf = audio.paused ? 0 : requestAnimationFrame(loop); }

  function setIcon() { $("#pl-play use").setAttribute("href", audio.paused ? "#i-play" : "#i-pause"); }
  audio.addEventListener("play", () => { setIcon(); if (!raf) loop(); });
  audio.addEventListener("pause", setIcon);
  audio.addEventListener("ended", setIcon);
  audio.addEventListener("loadedmetadata", draw);
  window.addEventListener("resize", draw);

  function showMeta() {
    const t = cur();
    $("#pl-title").textContent = t.title;
    $("#pl-sub").textContent = tracks.b ? `A/B比較中 ・ ${which === "a" ? labels[0] : `${labels[1]}: ${tracks.b.title}`}` : t.sub || "";
    $('#pl-ab [data-ab="a"]').textContent = labels[0];
    $('#pl-ab [data-ab="b"]').textContent = labels[1];
    $("#pl-art").outerHTML = t.category ? art(t.category).replace('class="art ', 'id="pl-art" class="art ') : `<div class="art empty" id="pl-art"><svg><use href="#i-wave"/></svg></div>`;
    $("#pl-ab").hidden = !tracks.b;
    $$("#pl-ab button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.ab === which));
  }

  async function load(keepTime, prev) {
    const t = cur(), wasPlaying = keepTime ? !audio.paused : true;
    let time = keepTime ? audio.currentTime : 0;
    // 原曲と楽譜どおりの音のように時間の進み方が違う音を切り替えるときは、楽譜の同じ場所にそろえる
    const q = keepTime && prev?.toQ && t.fromQ ? prev.toQ(time) : undefined;
    if (Number.isFinite(q)) time = Math.max(0, t.fromQ(q));
    loading = true;
    audio.src = t.src;
    showMeta();
    $("#pl-play").disabled = false;
    peaks = null;
    draw();
    await new Promise((res) => audio.addEventListener("loadedmetadata", res, { once: true }));
    loading = false;
    audio.currentTime = Math.min(pendingSeek ?? time, audio.duration || 0);
    pendingSeek = null;
    if (wasPlaying) audio.play().catch(() => {});
    peaks = await loadPeaks(t.src);
    if (cur() === t) draw();
  }

  $("#pl-play").addEventListener("click", () => (audio.paused ? audio.play() : audio.pause()));
  $$("#pl-ab button").forEach((b) => b.addEventListener("click", () => {
    if (!tracks?.b || which === b.dataset.ab) return;
    const prev = cur();
    which = b.dataset.ab;
    load(true, prev);
  }));
  canvas.addEventListener("click", (e) => {
    if (!audio.duration) return;
    const r = canvas.getBoundingClientRect();
    audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration;
    draw();
  });
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, select, textarea") || !tracks) return;
    if (e.code === "Space") { e.preventDefault(); audio.paused ? audio.play() : audio.pause(); }
    if (tracks.b && (e.key === "a" || e.key === "b")) $(`#pl-ab [data-ab="${e.key}"]`).click();
  });
  draw();

  return {
    audio,
    current: () => cur(),
    seek(t) {
      if (loading || !audio.duration) pendingSeek = t;
      else { audio.currentTime = Math.min(Math.max(0, t), audio.duration); draw(); }
    },
    play(t) { tracks = { a: t }; which = "a"; load(false); },
    compare(a, b, names = ["A 原曲", "B 音色"]) {
      tracks = { a, b }; which = "a"; labels = names; load(false);
      toast("A/Bボタン（またはキーボードの A / B）で切り替えて聴き比べられます");
    },
  };
})();

// ---------- 再生位置（楽譜の上のバー・鳴っている音符・鍵盤） ----------
// 位置はどれも「楽譜の先頭から4分音符いくつ目か」(q)。サーバーの sync.json（sheet/pipeline.py の _write_sync）を使う。
const NAMES_SHARP = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const NAMES_FLAT = ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"];
const BLACK = new Set([1, 3, 6, 8, 10]);
const noteName = (p, flats) => `${(flats ? NAMES_FLAT : NAMES_SHARP)[p % 12]}${Math.floor(p / 12) - 1}`;

// key(arr[i]) <= x となる最後の i（なければ -1）
function lastAtOrBefore(arr, x, key) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]) <= x) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

// 音声の秒 ↔ 楽譜の位置。原曲・演奏そのままは拍の時刻（テンポの揺れつき）、楽譜どおりの音は一定のテンポ
function makeClock(sync) {
  const b = sync.beats, n = b.length;
  const beatToSec = (x) => {
    if (x <= 0) return b[0] + x * (b[1] - b[0]);
    if (x >= n - 1) return b[n - 1] + (x - n + 1) * (b[n - 1] - b[n - 2]);
    const i = Math.floor(x);
    return b[i] + (x - i) * (b[i + 1] - b[i]);
  };
  const secToBeat = (t) => {
    if (t <= b[0]) return (t - b[0]) / (b[1] - b[0]);
    if (t >= b[n - 1]) return n - 1 + (t - b[n - 1]) / (b[n - 1] - b[n - 2]);
    const i = lastAtOrBefore(b, t, (v) => v);
    return i + (t - b[i]) / (b[i + 1] - b[i]);
  };
  const spq = 60 / sync.tempo;
  return {
    perf: { toQ: (t) => secToBeat(t) - sync.origin, fromQ: (q) => beatToSec(q + sync.origin) },
    score: { toQ: (t) => (t - sync.offset) / spq, fromQ: (q) => sync.offset + q * spq },
  };
}

function inlineSvg(text, i) {
  const svg = new DOMParser().parseFromString(text, "image/svg+xml").documentElement;
  // 幅に合わせて縮むよう、大きさを viewBox にする
  const w = parseFloat(svg.getAttribute("width")), h = parseFloat(svg.getAttribute("height"));
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `楽譜 ${i + 1}ページ目`);
  return document.importNode(svg, true);
}

const scoreView = (() => {
  const audio = player.audio;
  const keys = $("#keys"), keysCanvas = $("#keys-canvas");
  let S = null, raf = 0, view = store.get("view");
  const pct = (v) => `${(v * 100).toFixed(3)}%`;

  async function open(m, startPlayback) {
    close();
    const s = (S = { m, startPlayback, lit: new Map() });
    let sync, svgs;
    try {
      sync = await api(`/api/sheets/${encodeURIComponent(m.name)}/sync`);
      svgs = await Promise.all(sync.page_urls.map((u) => fetch(u).then((r) => r.text())));
    } catch {
      // 再生位置は出さず、画像の楽譜だけを表示する
      if (S === s && $("#sheet-pages")) $("#sheet-pages").innerHTML = pageImages(m.page_urls);
      return;
    }
    const pagesEl = $("#sheet-pages");
    if (S !== s || !pagesEl) return;
    pagesEl.innerHTML = "";
    svgs.forEach((text, i) => {
      const page = document.createElement("div");
      page.className = "page";
      page.append(inlineSvg(text, i));
      pagesEl.append(page);
    });
    pagesEl.classList.add("timed");
    pagesEl.addEventListener("click", onClick);
    s.pagesEl = pagesEl;
    s.pages = $$(".page", pagesEl);
    s.sync = sync;
    s.clock = makeClock(sync);
    s.notes = sync.notes;
    s.maxDur = Math.max(1, ...sync.notes.map((n) => n[2] - n[1]));
    s.roll = (m.roll || []).filter((n) => n[4] !== false).sort((a, b) => a[1] - b[1]);
    s.rollMax = Math.max(0.5, ...s.roll.map((n) => n[2] - n[1]));
    const ps = [...sync.notes.map((n) => n[3]), ...s.roll.map((n) => n[0])];
    s.lo = Math.min(...ps); s.lo -= s.lo % 12; // ド から
    s.hi = Math.max(...ps); s.hi += 11 - (s.hi % 12); // シ まで
    s.plan = keyPlanOf(m).sort((a, b) => a.beat - b.beat);
    s.head = Object.assign(document.createElement("div"), { className: "playhead" });
    s.hl = Object.assign(document.createElement("div"), { className: "measure-hl" });
    s.rollHead = $("#roll-head");
    update();
  }

  function close() {
    if (!S) return;
    S.head?.remove();
    S.hl?.remove();
    S = null;
    keys.hidden = true;
    document.body.classList.remove("keys-on");
  }

  // 小節・音符の位置を、ページの幅・高さに対する割合で求める（拡大縮小しても変わらない）。画面に出ているときだけ測れる
  function layout() {
    if (S.layout) return S.layout;
    const prs = S.pages.map((p) => p.getBoundingClientRect());
    if (!prs.length || !prs[0].width) return null;
    const frac = (r, pr) => ({ l: (r.left - pr.left) / pr.width, r: (r.right - pr.left) / pr.width, t: (r.top - pr.top) / pr.height, b: (r.bottom - pr.top) / pr.height });
    const byQ = new Map();
    const add = (id, q) => (byQ.has(q) ? byQ.get(q).push(id) : byQ.set(q, [id]));
    S.sync.notes.forEach((n) => add(n[0], n[1]));
    S.sync.rests.forEach(([id, q]) => add(id, q));
    const qs = [...byQ.keys()].sort((a, b) => a - b);
    // 同じ位置で鳴り始める音符・休符のうち、いちばん左の符頭の中心
    const xOf = (ids, pr) => {
      let x = Infinity;
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el || el.classList.contains("mRest")) continue;
        const r = ($(".notehead", el) || el).getBoundingClientRect();
        x = Math.min(x, ((r.left + r.right) / 2 - pr.left) / pr.width);
      }
      return Number.isFinite(x) ? x : null;
    };
    const measures = [], anchors = [];
    let prev = null, k = 0;
    for (const [id, q, end] of S.sync.measures) {
      const el = document.getElementById(id);
      if (!el) continue;
      const page = S.pages.indexOf(el.closest(".page")), pr = prs[page];
      const sys = el.closest(".system");
      const sr = frac(sys.getBoundingClientRect(), pr);
      const right = frac(($(":scope > .barLine", el) || el).getBoundingClientRect(), pr).r;
      const pts = [];
      for (; k < qs.length && qs[k] < end; k++) {
        if (qs[k] < q) continue;
        const x = xOf(byQ.get(qs[k]), pr);
        if (x !== null) pts.push({ q: qs[k], x });
      }
      const M = { id, q, end, page, sys, t: sr.t, b: sr.b, r: right };
      M.l = prev?.sys === sys ? prev.r : Math.max(0, (pts[0]?.x ?? right) - 0.02);
      if (!pts.length || pts[0].q > q) anchors.push({ q, x: M.l + 0.004, M });
      pts.forEach((p) => anchors.push({ ...p, M }));
      anchors.push({ q: end, x: right, M });
      measures.push(M);
      prev = M;
    }
    return (S.layout = { measures, anchors });
  }

  // q の位置：その段の中で、前後の音符の間を拍に合わせてなめらかに動かす
  function locate(q) {
    const L = layout();
    if (!L?.anchors.length) return null;
    const A = L.anchors, i = Math.max(0, lastAtOrBefore(A, q, (a) => a.q));
    const a = A[i], b = A[i + 1];
    const x = b && b.M.sys === a.M.sys && b.q > a.q ? a.x + (b.x - a.x) * Math.min(1, (q - a.q) / (b.q - a.q)) : a.x;
    return { x, M: a.M };
  }

  function place(q, follow) {
    const pos = locate(q);
    if (!pos) return;
    const { x, M } = pos, page = S.pages[M.page];
    if (S.head.parentNode !== page) page.append(S.hl, S.head);
    Object.assign(S.head.style, { left: pct(x), top: pct(M.t), height: pct(M.b - M.t) });
    Object.assign(S.hl.style, { left: pct(M.l), width: pct(M.r - M.l), top: pct(M.t), height: pct(M.b - M.t) });
    if (S.sys === M.sys) return;
    S.sys = M.sys;
    if (!follow) return;
    // 段が変わったら、その段が見えるところまでスクロールする
    const content = $(".content"), cr = content.getBoundingClientRect(), r = M.sys.getBoundingClientRect();
    const bottom = cr.bottom - (keys.hidden ? 0 : keys.offsetHeight);
    if (r.top < cr.top || r.bottom > bottom) content.scrollBy({ top: r.top - cr.top - (bottom - cr.top) * 0.2, behavior: "smooth" });
  }

  // 楽譜の中で今鳴っている音符に色を付け、その音符の一覧を返す
  function light(q) {
    const want = new Map(), N = S.notes;
    for (let j = lastAtOrBefore(N, q, (n) => n[1]); j >= 0 && N[j][1] > q - S.maxDur; j--) if (N[j][2] > q) want.set(N[j][0], N[j]);
    for (const [id, el] of S.lit) if (!want.has(id)) { el.classList.remove("lit-1", "lit-2"); S.lit.delete(id); }
    for (const [id, n] of want) {
      if (S.lit.has(id)) continue;
      const el = document.getElementById(id);
      if (el) { el.classList.add(`lit-${n[4]}`); S.lit.set(id, el); }
    }
    return [...want.values()];
  }

  function unlight() {
    for (const el of S.lit.values()) el.classList.remove("lit-1", "lit-2");
    S.lit.clear();
  }

  // 原曲・演奏そのままのときは、実際に弾かれた音（採譜結果）
  function playedAt(t) {
    const R = S.roll, out = [];
    for (let j = lastAtOrBefore(R, t, (n) => n[1]); j >= 0 && R[j][1] > t - S.rollMax; j--) if (R[j][2] > t) out.push(R[j]);
    return out;
  }

  function flatsAt(q) {
    let sharps = S.plan[0]?.sharps ?? 0;
    for (const p of S.plan) if (p.beat <= q + 1e-6) sharps = p.sharps;
    return sharps < 0;
  }

  function drawKeys(active, flats) {
    const dpr = window.devicePixelRatio || 1;
    const w = keysCanvas.clientWidth, h = keysCanvas.clientHeight;
    if (!w) return;
    if (keysCanvas.width !== w * dpr || keysCanvas.height !== h * dpr) { keysCanvas.width = w * dpr; keysCanvas.height = h * dpr; }
    const ctx = keysCanvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const css = getComputedStyle(document.documentElement);
    const color = { 1: css.getPropertyValue("--accent").trim(), 2: css.getPropertyValue("--accent-2").trim() };
    const whites = [];
    for (let p = S.lo; p <= S.hi; p++) if (!BLACK.has(p % 12)) whites.push(p);
    const kw = w / whites.length, bw = kw * 0.62, bh = h * 0.6;
    const xOfWhite = new Map(whites.map((p, i) => [p, i * kw]));
    const label = (text, x, y, fill) => {
      ctx.fillStyle = fill;
      ctx.fillText(text, x, y);
    };
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    const fs = Math.max(8, Math.min(11, kw * 0.36));
    ctx.font = `600 ${fs}px Inter, "Noto Sans JP", sans-serif`;
    const showNames = kw >= 16;
    for (const p of whites) {
      const x = xOfWhite.get(p), on = active.get(p);
      ctx.fillStyle = on ? color[on] : "#f7f7fa";
      ctx.strokeStyle = "#c4c6d2";
      ctx.beginPath();
      ctx.roundRect(x + 0.5, 0.5, kw - 1, h - 1, [0, 0, 4, 4]);
      ctx.fill();
      ctx.stroke();
      if (on && showNames) label(noteName(p, flats), x + kw / 2, h - 7, "#fff");
      else if (p % 12 === 0) label(`C${p / 12 - 1}`, x + kw / 2, h - 7, "#9a9db0");
    }
    for (let p = S.lo; p <= S.hi; p++) {
      if (!BLACK.has(p % 12)) continue;
      const x = xOfWhite.get(p - 1) + kw - bw / 2, on = active.get(p);
      ctx.fillStyle = on ? color[on] : "#1c1d24";
      ctx.beginPath();
      ctx.roundRect(x, 0, bw, bh, [0, 0, 3, 3]);
      ctx.fill();
      if (on && showNames) {
        ctx.save();
        ctx.font = `600 ${Math.max(7, fs - 2)}px Inter, "Noto Sans JP", sans-serif`;
        label(noteName(p, flats), x + bw / 2, bh - 6, "#fff");
        ctx.restore();
      }
    }
  }

  function hide() {
    S.head.remove();
    S.hl.remove();
    S.sys = null;
    unlight();
    if (S.rollHead) S.rollHead.hidden = true;
    keys.hidden = true;
    document.body.classList.remove("keys-on");
  }

  function update() {
    if (!S?.clock) return;
    const t = player.current();
    if (!t || t.sheet !== S.m.name || view !== "sheet") return hide();
    const time = audio.currentTime, q = S.clock[t.kind].toQ(time);
    place(q, !audio.paused && $("#score-follow")?.checked);
    const written = light(q);
    const active = new Map();
    if (t.kind === "score") written.forEach((n) => active.set(n[3], n[4]));
    else playedAt(time).forEach((n) => active.set(n[0], n[0] >= S.m.split ? 1 : 2));
    if (keys.hidden) {
      keys.hidden = false;
      document.body.classList.add("keys-on");
    }
    drawKeys(active, flatsAt(q));
    const canvas = $("#sheet-roll");
    if (S.rollHead && canvas?.dataset.end) {
      const perf = t.kind === "score" ? S.clock.perf.fromQ(q) : time;
      S.rollHead.hidden = false;
      S.rollHead.style.left = pct(Math.min(1, Math.max(0, perf / canvas.dataset.end)));
    }
  }

  function loop() {
    update();
    raf = audio.paused ? 0 : requestAnimationFrame(loop);
  }
  audio.addEventListener("play", () => { if (!raf) loop(); });
  ["pause", "seeked", "ended", "loadedmetadata"].forEach((ev) => audio.addEventListener(ev, update));
  window.addEventListener("resize", update);
  document.addEventListener("viewchange", (e) => { view = e.detail; update(); });

  // 小節をクリック → その小節の頭から再生
  function onClick(e) {
    if (!S?.clock) return;
    const page = e.target.closest(".page"), L = layout();
    if (!page || !L) return;
    const pi = S.pages.indexOf(page), pr = page.getBoundingClientRect();
    const fx = (e.clientX - pr.left) / pr.width, fy = (e.clientY - pr.top) / pr.height;
    const M = L.measures.find((M) => M.page === pi && fy >= M.t - 0.01 && fy <= M.b + 0.01 && fx >= M.l && fx <= M.r);
    if (!M) return;
    let t = player.current();
    if (!t || t.sheet !== S.m.name) { S.startPlayback(); t = player.current(); }
    player.seek(S.clock[t.kind].fromQ(M.q));
    if (audio.paused) audio.play().catch(() => {});
  }

  return {
    open,
    toQ: (name, kind, t) => (S?.clock && S.m.name === name ? S.clock[kind].toQ(t) : undefined),
    fromQ: (name, kind, q) => (S?.clock && S.m.name === name ? S.clock[kind].fromQ(q) : undefined),
  };
})();

// ---------- ジョブ ----------
async function startJob(fn) {
  try {
    const job = await fn();
    state.job = job;
    renderJob(job);
    poll();
  } catch (e) {
    toast(e.message);
    if (/録音しています/.test($("#test-result").textContent)) $("#test-result").innerHTML = "";
    $("#match-log").textContent = "";
  }
}

function poll() {
  clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(async () => {
    if (!state.job) return;
    try {
      const job = await api(`/api/jobs/${state.job.id}`);
      state.job = job;
      renderJob(job);
      if (isActive(job)) poll();
      else onJobEnd(job);
    } catch { poll(); }
  }, 800);
}

$$("[data-cancel]").forEach((b) => b.addEventListener("click", async () => {
  if (state.job) await post(`/api/jobs/${state.job.id}/cancel`);
  toast("中止しています（今の処理が終わったら止まります）");
}));

const JOB_LABEL = { build: "録音中", test: "テスト録音中", match: "音色を探しています", sheet: "楽譜を作っています" };
const JOB_VIEW = { build: "record", test: "record", match: "match", sheet: "sheet" };
$("#job-mini").addEventListener("click", () => state.job && showView(JOB_VIEW[state.job.kind]));

function renderJob(job) {
  const running = isActive(job);
  $("#job-mini").hidden = !running;
  $("#job-mini-text").textContent = job.status === "queued"
    ? `順番待ち（${job.position}番目）`
    : `${JOB_LABEL[job.kind]}${job.kind === "build" && job.total ? ` ${job.progress}/${job.total}` : ""}`;
  $("#build-btn").disabled = $("#test-btn").disabled = running;
  $("#match-btn").disabled = running || !songInput.files.length;
  orb.classList.toggle("busy", running && job.kind === "match");
  sheetOrb.classList.toggle("busy", running && job.kind === "sheet");
  $("#sheet-btn").disabled = running || !sheetInput.files.length;
  if (job.kind === "sheet") renderSheetJob(job);

  if (job.kind === "build") {
    const box = $("#build-run");
    box.hidden = false;
    box.classList.toggle("stopped", !running);
    $("#build-state").textContent = running ? "REC" : { done: "録音完了", cancelled: "中止しました", error: "エラー" }[job.status];
    $("[data-cancel]", box).hidden = !running;
    $("#build-bar").style.width = `${job.total ? (job.progress / job.total) * 100 : 0}%`;
    const c = job.data.counts || {};
    $("#build-progress").textContent = `${job.progress} / ${job.total}`;
    const now = running ? job.data.current : (job.data.recent?.[0]?.name ?? "-");
    const nowCat = running ? job.data.current_category : job.data.recent?.[0]?.category;
    $("#build-current").textContent = now || "-";
    $("#build-art").outerHTML = art(nowCat || "", "big").replace('class="art ', 'id="build-art" class="art ');
    const done = (c.done || 0) + (c.silent || 0);
    const elapsed = Date.now() / 1000 - job.started;
    const parts = [`録音 ${c.done || 0}`, `録音済みでスキップ ${c.skipped || 0}`];
    if (c.silent) parts.push(`無音 ${c.silent}`);
    if (running && done) parts.push(`残り 約${fmtTime((elapsed / done) * (job.total - job.progress))}`);
    if (job.error) parts.push(job.error);
    $("#build-eta").textContent = parts.join(" ・ ");
    const recent = job.data.recent || [];
    $("#build-recent").innerHTML = recent.map((r, i) => `
      <div class="row">
        ${art(r.category)}
        <div class="row-body"><div class="row-title">${esc(r.name)}</div><div class="row-sub">${esc(r.category)}</div></div>
        ${r.status === "silent" ? `<span class="pill warn">無音</span>` : r.audio ? `<button class="icon-btn" data-recent="${i}" aria-label="再生"><svg><use href="#i-play"/></svg></button>` : ""}
      </div>`).join("");
    $$("[data-recent]").forEach((b) => b.addEventListener("click", () => {
      const r = recent[b.dataset.recent];
      player.play({ src: r.audio, title: r.name, sub: r.category, category: r.category });
    }));
  }
  if (job.kind === "match") {
    $("#match-run").hidden = job.status === "done";
    const log = job.log.join("\n");
    $("#match-log").textContent = log + (job.error ? `\n\nエラー: ${job.error}` : "");
    const m = [...log.matchAll(/\[(\d)\/3\]/g)].pop();
    const step = job.status === "done" ? 4 : m ? +m[1] : 1;
    $$("#steps li").forEach((li) => {
      const n = +li.dataset.step;
      li.classList.toggle("done", n < step);
      li.classList.toggle("active", running && n === step);
    });
    $("#match-status").textContent = running ? job.message : { cancelled: "中止しました", error: `エラー: ${job.error}` }[job.status] || "";
    $("[data-cancel]", $("#match-run")).hidden = !running;
  }
}

function onJobEnd(job) {
  if (job.kind === "sheet") {
    if (job.status === "done") { renderSheet(job.result, true); loadSheets(); }
    else if (job.status === "error") toast(job.error);
  }
  if (job.kind === "test") {
    if (job.status !== "done") {
      $("#test-result").innerHTML = `<div class="verdict bad"><div class="verdict-body"><b>テスト録音できませんでした</b>${esc(job.error || "中止しました")}</div></div>`;
      return;
    }
    const r = job.result;
    const level = r.peak_db < -50 ? "bad" : r.peak_db > -0.5 || r.peak_db < -24 ? "warn" : "";
    $("#test-result").innerHTML = `
      <div class="verdict ${level}">
        <button class="icon-btn" id="test-play" aria-label="再生"><svg><use href="#i-play"/></svg></button>
        <div class="verdict-body">
          <b>${esc(r.preset)} ・ ピーク ${r.peak_db} dB</b>${esc(r.verdict)}
          <div class="meter bar"><span style="width:${Math.max(0, Math.min(100, ((r.peak_db + 60) / 60) * 100))}%"></span></div>
        </div>
      </div>`;
    const track = { src: r.audio, title: `テスト録音: ${r.preset}`, sub: `ピーク ${r.peak_db} dB`, category: r.category || "" };
    $("#test-play").addEventListener("click", () => player.play(track));
    player.play(track);
  }
  if (job.kind === "build") {
    refreshInfo();
    if (!$("#view-library").hidden) loadPresets();
    if (job.status === "error") toast(job.error);
    if (job.status === "done") toast("録音が終わりました");
  }
  if (job.kind === "match") {
    if (job.status === "done") { renderMatch(job.result, true); loadHistory(); }
    else if (job.status === "error") toast(job.error);
  }
}

// ---------- 起動 ----------
(async () => {
  const cfg = await api("/api/config").catch(() => ({ public: false }));
  state.public = cfg.public;
  if (SHARE) {
    document.body.classList.add("public", "share");
    document.title = SHARE.title;
    $("#sheet-title").textContent = SHARE.title;
    $("#sheet-sub").textContent = SHARE.note || "";
    showView("sheet");
  } else if (cfg.public) {
    document.body.classList.add("public");
    $("#public-note").hidden = false;
    $("#public-note").innerHTML = `アップロードしたファイルと作った楽譜は<b>あなたのブラウザからだけ</b>見られ、<b>${cfg.retention_hours}時間後に自動で削除</b>されます。
      ファイルは ${cfg.max_upload_mb}MB・${cfg.max_minutes}分まで。混んでいるときは順番待ちになります。<br>
      作った楽譜は個人の練習用にお使いください（他の人が作った曲の楽譜の配布・販売はしないでください）。`;
    showView("sheet");
  } else {
    const hash = location.hash.slice(1);
    const view = ["record", "library", "match", "sheet"].includes(hash) ? hash : store.get("view") || "record";
    await loadInstruments();
    showView(view);
  }
  // ページを開き直したとき、実行中のジョブがあれば表示を再開
  const cur = await api("/api/jobs/current").catch(() => null);
  if (isActive(cur)) { state.job = cur; renderJob(cur); poll(); }
  else if (cur && cur.kind === "match" && cur.status === "done") renderMatch(cur.result);
  else if (cur && cur.kind === "sheet" && cur.status === "done") renderSheet(cur.result);
  const params = new URLSearchParams(location.search);
  if (params.get("tone")) openTone(params.get("tone"));
  if (params.get("sheet")) {
    const sheet = await api(`/api/sheets/${encodeURIComponent(params.get("sheet"))}`).catch(() => null);
    if (sheet) renderSheet(sheet);
    else toast("指定された楽譜が見つかりません");
  } else if (SHARE) {
    // 共有ページは最初の曲を開いた状態で見せる
    const rows = await api("/api/sheets").catch(() => []);
    if (rows.length) renderSheet(await api(`/api/sheets/${encodeURIComponent(rows[0].name)}`));
  }
})();
