// ── Threads 監測：前端（hash 路由的單頁應用）────────────────────────────
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => (n == null || Number.isNaN(Number(n)) ? "—" : Number(n).toLocaleString("zh-TW"));
const short = (n) => (n == null ? "—" : Math.abs(n) >= 10000 ? `${(n / 10000).toFixed(Math.abs(n) >= 100000 ? 0 : 1)} 萬` : fmt(Math.round(n)));
const pct = (n, d = 1) => (n == null ? "—" : `${Number(n).toFixed(d)}%`);
const signed = (n) => (n == null ? "—" : `${n > 0 ? "+" : ""}${fmt(n)}`);
const twTime = (iso) => (iso ? new Date(iso).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const twFull = (iso) => (iso ? new Date(iso).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false }) : "—");
const snippet = (s, n = 40) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "…" : t || "（無文字）"; };
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const SERIES = () => [1, 2, 3, 4, 5, 6, 7, 8].map((i) => css(`--series-${i}`));
const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
const BLOCKS = ["0–3 時", "3–6 時", "6–9 時", "9–12 時", "12–15 時", "15–18 時", "18–21 時", "21–24 時"];
const SENT = { positive: ["正面", "pos"], neutral: ["中性", "neu"], negative: ["負面", "neg"] };
const RANK = { viewer: 1, editor: 2, admin: 3 };
const ROLE_NAME = { admin: "管理員", editor: "編輯", viewer: "檢視者" };

const S = { me: null, workspaces: [], ws: null, topics: [], accounts: [], days: 30, charts: [], timers: [], source: "all", sort: {} };
try { S.days = Number(localStorage.getItem("tm_days")) || 30; } catch {}

// ── API ──────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const headers = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (S.ws) headers["X-Workspace"] = String(S.ws.id);
  const res = await fetch(path, {
    method: opts.method || (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { showAuth(); throw new Error(data.error || "請先登入"); }
  if (!res.ok) throw new Error(data.error || `錯誤 ${res.status}`);
  return data;
}

function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = bad ? "bad" : "";
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3200);
}

const can = (min) => S.ws && RANK[S.ws.role] >= RANK[min];

// ── 圖表共用 ─────────────────────────────────────────────────────────
Chart.defaults.font.family = css("--font") || "system-ui, sans-serif";
Chart.defaults.font.size = 12;

function destroyCharts() { S.charts.forEach((c) => c.destroy()); S.charts = []; }
function clearTimers() { S.timers.forEach((t) => clearInterval(t)); S.timers = []; }

function chartOpts({ legend = false, stacked = false, horizontal = false, xLog = false, yTitle = "", xTitle = "", tooltip = {} } = {}) {
  const muted = css("--text-muted");
  const grid = css("--grid");
  const valueAxis = { beginAtZero: true, stacked, grid: { color: grid }, border: { display: false }, ticks: { color: muted, precision: 0 }, title: { display: !!yTitle, text: yTitle, color: muted } };
  const catAxis = { stacked, grid: { display: false }, border: { color: css("--baseline") }, ticks: { color: muted, maxRotation: 0, autoSkip: true, autoSkipPadding: 12 }, title: { display: !!xTitle, text: xTitle, color: muted } };
  if (xLog) Object.assign(catAxis, { type: "logarithmic", grid: { color: grid }, ticks: { color: muted, callback: (v) => ([1, 10, 100, 1000, 10000, 100000, 1000000].includes(v) ? short(v) : "") } });
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    indexAxis: horizontal ? "y" : "x",
    interaction: { mode: xLog ? "nearest" : "index", intersect: xLog },
    plugins: {
      legend: { display: legend, align: "start", labels: { color: css("--text-secondary"), boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 2 } },
      tooltip: { backgroundColor: css("--text"), titleColor: css("--page"), bodyColor: css("--page"), padding: 10, cornerRadius: 6, boxPadding: 4, ...tooltip },
    },
    scales: horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis },
  };
}

const barDs = (label, data, color, stacked = false) => ({
  label, data, backgroundColor: color, borderRadius: stacked ? 0 : 4, borderSkipped: "start", maxBarThickness: 22,
  ...(stacked ? { borderColor: css("--surface"), borderWidth: { top: 2 } } : {}),
});
const lineDs = (label, data, color) => ({
  label, data, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, pointHitRadius: 12, tension: 0.2, spanGaps: true,
});

function mkChart(id, config) {
  const el = document.getElementById(id);
  if (!el) return null;
  const c = new Chart(el, config);
  S.charts.push(c);
  return c;
}

const shortDate = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
// 顏色跟著實體（主題／帳號）的建立順序走，不跟排名走
const topicColor = (id) => SERIES()[Math.max(0, S.topics.findIndex((t) => t.id === id)) % 8];
const accountColor = (h) => SERIES()[Math.max(0, S.accounts.findIndex((a) => a.handle === h)) % 8];

// ── 小元件 ───────────────────────────────────────────────────────────
const tile = (label, value, hint = "", tone = "") =>
  `<div class="tile ${tone}"><div class="label">${esc(label)}</div><div class="value">${value}</div>${hint ? `<div class="hint">${hint}</div>` : ""}</div>`;
const sentBadge = (s) => { const [t, c] = SENT[s] || SENT.neutral; return `<span class="sent ${c}">${t}</span>`; };
const flags = (hits) => (hits && hits.length ? `<span class="flag">${esc(hits.join("、"))}</span>` : "");
const trendCell = (t) => {
  if (!t || t.label === "無資料") return `<span class="muted">—</span>`;
  const arrow = { 上升: "↑ ", 下降: "↓ ", 持平: "→ " }[t.label];
  if (!arrow) return `<span class="muted small">${esc(t.label)}</span>`;
  return `<span class="trend">${arrow}${t.label}${t.change != null ? `（${t.change > 0 ? "+" : ""}${t.change}%）` : t.fresh ? "（新出現）" : ""}</span>`;
};
const authorLink = (h) => `<a href="https://www.threads.com/@${esc(h)}" target="_blank" rel="noopener">@${esc(h)}</a>`;
const empty = (msg) => `<div class="empty">${msg}</div>`;

function sortableTable(id, columns, rows, { defaultSort, onRow } = {}) {
  const st = (S.sort[id] ||= defaultSort || { key: null, dir: -1 });
  const sorted = st.key ? [...rows].sort((a, b) => ((a[st.key] ?? -Infinity) > (b[st.key] ?? -Infinity) ? 1 : -1) * st.dir) : rows;
  const head = columns.map((c) => `<th class="${c.num ? "num" : ""} ${c.sort ? "sortable" : ""}" data-key="${c.sort || ""}">${c.label}${st.key && st.key === c.sort ? (st.dir < 0 ? " ▼" : " ▲") : ""}</th>`).join("");
  const body = sorted.map((r, i) => `<tr class="${onRow ? "clickable" : ""}" data-i="${rows.indexOf(r)}">${columns.map((c) => `<td class="${c.num ? "num" : ""} ${c.cls || ""}">${c.render(r, i)}</td>`).join("")}</tr>`).join("");
  return `<div class="table-wrap"><table class="data" id="${id}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}
function bindTable(id, rows, rerender, onRow) {
  const t = document.getElementById(id);
  if (!t) return;
  $$("th.sortable", t).forEach((th) => th.addEventListener("click", () => {
    const st = S.sort[id];
    st.dir = st.key === th.dataset.key ? -st.dir : -1;
    st.key = th.dataset.key;
    rerender();
  }));
  if (onRow) $$("tbody tr", t).forEach((tr) => tr.addEventListener("click", (e) => {
    if (e.target.closest("a, button, input, select")) return;
    onRow(rows[Number(tr.dataset.i)]);
  }));
}

// 來源篩選（貼文、瀏覽、時段、成功模式共用）
function sourceSelect() {
  const opt = (v, t) => `<option value="${esc(v)}" ${S.source === v ? "selected" : ""}>${esc(t)}</option>`;
  return `<label class="check small">來源
    <select id="sourceSel">
      ${opt("all", "工作區全部貼文")}${opt("kind:own", "自己的帳號")}${opt("kind:competitor", "競品帳號")}
      ${S.topics.length ? `<optgroup label="主題">${S.topics.map((t) => opt(`topic:${t.id}`, (t.type === "hashtag" ? "#" : "") + t.term)).join("")}</optgroup>` : ""}
      ${S.accounts.length ? `<optgroup label="帳號">${S.accounts.map((a) => opt(`handle:${a.handle}`, "@" + a.handle + (a.label ? `（${a.label}）` : ""))).join("")}</optgroup>` : ""}
    </select></label>`;
}
function sourceQuery() {
  const [k, v] = S.source.split(":");
  return k === "kind" ? `&kind=${v}` : k === "topic" ? `&topic=${v}` : k === "handle" ? `&handle=${encodeURIComponent(v)}` : "";
}
function bindSource(rerender) {
  $("#sourceSel")?.addEventListener("change", (e) => { S.source = e.target.value; rerender(); });
}

function modal(html) {
  const bg = document.createElement("div");
  bg.className = "modal-bg";
  bg.innerHTML = `<div class="modal">${html}<div style="text-align:right;margin-top:12px"><button class="btn" data-close>關閉</button></div></div>`;
  bg.addEventListener("click", (e) => { if (e.target === bg || e.target.dataset.close != null) bg.remove(); });
  document.body.appendChild(bg);
  return bg;
}

const guestNote = `<div class="note">目前以訪客身分抓取 Threads：每個主題約可見 7–12 篇、每個帳號約 10 篇、每篇約 25 則留言，數字是「可見範圍內」的統計，不是完整母體。每天持續抓取，資料會逐日累積。</div>`;

// ── 路由 ─────────────────────────────────────────────────────────────
const ROUTES = {
  overview: { title: "總覽", group: "分析", render: viewOverview },
  negative: { title: "負面留言板", group: "分析", render: viewNegative },
  topics: { title: "主題監測", group: "分析", render: viewTopics },
  compare: { title: "主題交叉比較", group: "分析", render: viewCompare },
  posts: { title: "貼文成效", group: "分析", render: viewPosts },
  views: { title: "瀏覽分析", group: "分析", render: viewViews },
  accounts: { title: "帳號比較", group: "分析", render: viewAccounts },
  times: { title: "最佳發文時段", group: "分析", render: viewTimes },
  patterns: { title: "內容成功模式", group: "分析", render: viewPatterns },
  manage: { title: "監測設定", group: "管理", render: viewManage },
  quick: { title: "立即爬文", group: "管理", render: viewQuick },
  crawl: { title: "抓取與排程", group: "管理", render: viewCrawl },
  members: { title: "成員", group: "管理", render: viewMembers, min: "admin" },
  roles: { title: "角色權限", group: "管理", render: viewRoles, owner: true },
  system: { title: "系統設定", group: "管理", render: viewSystem, owner: true },
  post: { title: "貼文詳情", hidden: true, render: viewPost },
  me: { title: "我的帳號", hidden: true, render: viewMe },
};

// 角色權限：選單看允許清單、區塊看隱藏清單；系統擁有者看得到全部
const canMenu = (key) => !!S.ws && (S.ws.owner || (S.ws.menus || []).includes(key));
const blockHidden = (key) => !!S.ws && !S.ws.owner && (S.ws.hidden_blocks || []).includes(key);
const routeAllowed = (key, r) => !r.hidden && !(r.min && !can(r.min)) && (r.owner ? !!S.me?.user.is_owner : canMenu(key));

function renderNav(active) {
  let html = "";
  let group = "";
  for (const [key, r] of Object.entries(ROUTES)) {
    if (!routeAllowed(key, r)) continue;
    if (r.group !== group) { group = r.group; html += `<div class="nav-group">${group === "分析" ? "前台・分析" : "後台・管理"}</div>`; }
    html += `<a href="#/${key}" class="${key === active ? "active" : ""}">${r.title}</a>`;
  }
  $("#nav").innerHTML = html;
}

// 被角色隱藏的區塊直接移除。各頁排序、切換時會自己重畫，所以用 MutationObserver 每次都再套一次
function applyBlocks(root) {
  if (!S.ws || S.ws.owner) return;
  for (const el of root.querySelectorAll("[data-block]")) if (blockHidden(el.dataset.block)) el.remove();
  for (const g of root.querySelectorAll(".grid2")) if (!g.children.length) g.remove();
}
new MutationObserver(() => applyBlocks($("#view"))).observe($("#view"), { childList: true, subtree: true });

async function route() {
  if (!S.me) return;
  const [, asked = "overview", param] = location.hash.match(/^#\/?([^/?]*)\/?([^?]*)/) || [];
  let name = ROUTES[asked] ? asked : "overview";
  // 沒有權限的頁面改開第一個看得到的選單（貼文詳情、我的帳號不受選單限制）
  if (!ROUTES[name].hidden && !routeAllowed(name, ROUTES[name])) {
    const first = Object.entries(ROUTES).find(([k, x]) => routeAllowed(k, x));
    if (!first) {
      renderNav("");
      $("#pageTitle").textContent = "沒有可用的頁面";
      $("#view").innerHTML = empty("你的角色目前沒有任何可看的頁面，請聯絡管理員調整角色權限。");
      return;
    }
    name = first[0];
  }
  const r = ROUTES[name];
  destroyCharts();
  clearTimers();
  renderNav(name);
  $("#pageTitle").textContent = r.title;
  $("#exportBtn").href = `/api/ws/export.xlsx?ws=${S.ws.id}&days=${S.days}`;
  $("#exportBtn").hidden = blockHidden("global.export");
  const view = $("#view");
  view.style.opacity = "0.55";
  try {
    await r.render(view, decodeURIComponent(param || ""));
  } catch (e) {
    view.innerHTML = empty(`載入失敗：${esc(e.message)}`);
  }
  view.style.opacity = "";
}

async function loadWorkspaceLists() {
  [S.topics, S.accounts] = await Promise.all([api("/api/ws/topics"), api("/api/ws/accounts")]);
}

// ── 前台：總覽 ───────────────────────────────────────────────────────
async function viewOverview(el) {
  const d = await api(`/api/ws/overview?days=${S.days}`);
  const k = d.kpi;
  const flagged = k.flagged_posts + k.flagged_comments;
  el.innerHTML = `
    ${!k.posts ? `<div class="note">這個期間還沒有資料。先到「<a href="#/manage">監測設定</a>」新增主題或帳號，再到「<a href="#/crawl">抓取與排程</a>」按「立即抓取」。</div>` : ""}
    <div class="tiles" data-block="overview.kpi">
      ${tile("貼文數", fmt(k.posts), `近 ${S.days} 天`)}
      ${tile("總互動", short(k.interactions), "讚＋留言＋轉發＋分享")}
      ${tile("平均互動／篇", fmt(k.avg_inter), `中位數 ${fmt(k.median_inter)}`)}
      ${tile("總瀏覽", short(k.views_total), `${fmt(k.views_posts)} 篇有瀏覽資料`)}
      ${tile("已抓留言", fmt(k.comments), `正 ${k.comments_pos}・中 ${k.comments_neu}・負 ${k.comments_neg}`)}
      ${tile("負面標記", `${flagged ? "⚠ " : ""}${fmt(flagged)}`, `貼文 ${k.flagged_posts}・留言 ${k.flagged_comments}`, flagged ? "warn" : "")}
    </div>
    <div class="grid2">
      <section class="card" data-block="overview.charts"><h2>每日新貼文</h2><p class="sub">依發布日（台灣時間）統計</p><div class="chart h240"><canvas id="c-posts"></canvas></div></section>
      <section class="card" data-block="overview.charts"><h2>每日留言情緒</h2><p class="sub">字典式判斷，可在「系統設定」調整字典</p><div class="chart h240"><canvas id="c-sent"></canvas></div></section>
    </div>
    <div class="grid2">
      <section class="card" data-block="overview.top_posts"><h2>互動最高的貼文</h2>
        ${d.top_posts.length ? `<ul class="list">${d.top_posts.map((p) => `<li><a href="#/post/${p.code}">${esc(snippet(p.content, 60))}</a>
          <div class="meta"><span>@${esc(p.author)}</span><span>${twTime(p.posted_at)}</span><span>互動 ${fmt(p.inter)}</span>${p.views != null ? `<span>瀏覽 ${short(p.views)}</span>` : ""}${flags(p.neg_hits)}</div></li>`).join("")}</ul>` : empty("尚無資料")}
      </section>
      <section class="card" data-block="overview.flagged"><h2>需要注意的留言</h2><p class="sub">含負面關鍵字或判斷為負面，依按讚數排序・<a href="#/negative">看全部可能負面的留言 →</a></p>
        ${d.flagged.length ? `<ul class="list">${d.flagged.map((c) => `<li>${esc(snippet(c.content, 80))}
          <div class="meta"><span>@${esc(c.author)}</span><span>讚 ${fmt(c.likes)}</span>${sentBadge(c.sentiment)}${flags(c.neg_hits)}<a href="https://www.threads.com/@${esc(c.post_author)}/post/${esc(c.post_code)}" target="_blank" rel="noopener">看原文 ↗</a></div></li>`).join("")}</ul>` : empty("沒有需要注意的留言")}
      </section>
    </div>
    <div class="grid2">
      <section class="card" data-block="overview.neg_keywords"><h2>負面關鍵字出現次數</h2><p class="sub">貼文＋留言</p>
        ${d.neg_keywords.length ? `<div class="barlist">${d.neg_keywords.slice(0, 12).map((x) => `<div class="row"><span>${esc(x.keyword)}</span><div class="bar" style="width:${(x.count / d.neg_keywords[0].count) * 100}%"></div><span class="num">${x.count}</span></div>`).join("")}</div>` : empty("期間內沒有出現負面關鍵字")}
      </section>
      <section class="card" data-block="overview.last_run"><h2>最近一次抓取</h2>${runSummary(d.last_run)}</section>
    </div>`;

  const labels = d.daily.map((x) => shortDate(x.date));
  mkChart("c-posts", { type: "bar", data: { labels, datasets: [barDs("新貼文", d.daily.map((x) => x.posts), css("--series-1"))] }, options: chartOpts() });
  mkChart("c-sent", {
    type: "bar",
    data: { labels, datasets: [
      barDs("正面", d.daily.map((x) => x.pos), css("--sent-pos"), true),
      barDs("中性", d.daily.map((x) => x.neu), css("--sent-neu"), true),
      barDs("負面", d.daily.map((x) => x.neg), css("--sent-neg"), true),
    ] },
    options: chartOpts({ legend: true, stacked: true }),
  });
}

const RUN_ST = { success: "完成", failed: "失敗", running: "進行中", interrupted: "中斷" };
const triggerName = (r) => (r.trigger === "schedule" ? "排程"
  : `${r.started_by || "手動"}${r.trigger === "quick" ? `・立即爬文${r.window_hours ? ` ${r.window_hours} 小時` : ""}` : ""}`);

function runSummary(r) {
  if (!r) return empty(`還沒抓過。${can("editor") ? `<a href="#/crawl">去抓第一次</a>` : ""}`);
  const st = RUN_ST[r.status] || r.status;
  return `<p>${twFull(r.started_at)}（${esc(triggerName(r))}）— <strong>${st}</strong></p>
    <p class="muted small">主題收錄 ${fmt(r.posts_found)} 篇・新貼文 ${fmt(r.posts_new)} 篇・已抓過略過 ${fmt(r.posts_skipped)} 篇・帳號 ${fmt(r.profiles_seen)} 個・點進 ${fmt(r.posts_visited)} 篇・留言 ${fmt(r.comments_found)} 則${r.logged_out ? "・遇到登入牆" : ""}</p>
    ${r.error ? `<p class="flag">${esc(r.error)}</p>` : ""}<a href="#/crawl">看抓取紀錄</a>`;
}

// ── 前台：負面留言板 ─────────────────────────────────────────────────
const LEVEL = { high: ["高度", "⚠"], mid: ["中度", "▲"], low: ["低度", "●"] };
const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);

// 命中的詞用 <mark> 標出來；先轉義再比對，長詞優先
function highlight(text, terms) {
  let html = esc(text || "（無文字）");
  for (const t of [...new Set(terms)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    html = html.split(esc(t)).join(` ${esc(t)}`);
  }
  return html.replace(/ /g, "<mark>").replace(//g, "</mark>");
}

function negItem(i) {
  const [name, icon] = LEVEL[i.level];
  return `<li class="item">
    <div><span class="sev ${i.level}">${icon} ${name}</span></div>
    <div>
      <div class="text">${highlight(i.content, i.hits.map((h) => h.term))}</div>
      <div class="reply-to">${i.post ? `回覆 @${esc(i.post.author)}：${esc(snippet(i.post.content, 50))}` : "貼文本身"}</div>
      <div class="meta"><span>${authorLink(i.author)}</span><span>${twTime(i.posted_at)}</span><span>讚 ${fmt(i.likes)}</span>${i.author_liked ? "<span>原作者說讚</span>" : ""}
        <a href="${esc(i.url)}" target="_blank" rel="noopener">${i.type === "comment" ? "這則留言" : "原貼文"} ↗</a>
        ${i.post ? `<a href="${esc(i.post.url)}" target="_blank" rel="noopener">看原文 ↗</a>` : ""}
        <a href="#/post/${esc(i.post ? i.post.code : i.code)}">系統內詳情</a></div>
      <div class="hits">${i.hits.map((h) => `<span class="hit">${esc(h.cat)}：<b>${esc(clip(h.term, 16))}</b></span>`).join("")}${i.hits.length ? "" : `<span class="hit">字典判定負面</span>`}</div>
    </div></li>`;
}

async function viewNegative(el) {
  const st = (S.neg ||= { level: "", type: "comment", sort: "severity", q: "" });
  const qs = `days=${S.days}${sourceQuery()}&type=${st.type}&sort=${st.sort}${st.level ? `&level=${st.level}` : ""}${st.q ? `&q=${encodeURIComponent(st.q)}` : ""}`;
  const d = await api(`/api/ws/negative?${qs}`);
  const c = d.counts;
  const seg = (key, opts) => `<div class="seg" data-seg="${key}">${opts.map(([v, t]) => `<button class="${st[key] === v ? "on" : ""}" data-v="${v}">${t}</button>`).join("")}</div>`;
  const noun = { comment: "留言", post: "貼文", all: "留言與貼文" }[st.type];
  el.innerHTML = `
    <div class="filters">${sourceSelect()}
      ${seg("type", [["comment", "留言"], ["post", "貼文"], ["all", "全部"]])}
      <select id="negSort" aria-label="排序"><option value="severity">嚴重度優先</option><option value="likes">按讚最多</option><option value="newest">最新</option></select>
      <input type="search" id="negQ" placeholder="搜尋內容或訊號" value="${esc(st.q)}">
      <a class="btn sm" data-block="negative.csv" href="/api/ws/negative.csv?ws=${S.ws.id}&${qs}">下載 CSV</a>
    </div>
    <div class="note">把可能是負面的內容盡量找出來，寧可多抓：輿情關鍵字、強烈負評與粗話、抱怨詞、質問句、勸退、反諷語氣與負面表情都算訊號，依強弱分三級。
      <strong>高度</strong>＝含輿情關鍵字或多個強烈訊號；<strong>中度</strong>＝明確負評；<strong>低度</strong>＝可能負面，建議人工確認。系統設定的「負面輿情關鍵字」「負面詞」也會一併比對。</div>
    <div class="tiles" data-block="negative.kpi">
      ${tile(`可能負面${noun}`, fmt(c.total) + " 則", `涉及 ${fmt(c.posts)} 篇貼文`)}
      ${tile("⚠ 高度", fmt(c.high), "輿情關鍵字或強烈負評", c.high ? "warn" : "")}
      ${tile("▲ 中度", fmt(c.mid), "明確負評")}
      ${tile("● 低度", fmt(c.low), "可能負面，需人工確認")}
    </div>
    <section class="card" data-block="negative.signals"><h2>最常出現的負面訊號</h2><p class="sub">點一下只看含這個訊號的內容</p>
      ${d.topSignals.length ? `<div class="hits">${d.topSignals.map((s) => `<button class="hit" data-q="${esc(s.term)}"><b>${esc(clip(s.term, 14))}</b> ${esc(s.cat)}・${s.count}</button>`).join("")}</div>` : empty("期間內沒有偵測到負面訊號")}
    </section>
    <section class="card" data-block="negative.list"><h2>負面${noun}（${fmt(d.matched)} 則${d.matched > d.shown ? `，顯示前 ${fmt(d.shown)} 則，完整內容請下載 CSV` : ""}）</h2>
      <div class="filters">${seg("level", [["", `全部 ${c.total}`], ["high", `⚠ 高度 ${c.high}`], ["mid", `▲ 中度 ${c.mid}`], ["low", `● 低度 ${c.low}`]])}
        ${st.q ? `<span class="small">只看含「${esc(clip(st.q, 16))}」 <button class="link" id="negClear">清除</button></span>` : ""}</div>
      ${d.items.length ? `<ul class="board">${d.items.map(negItem).join("")}</ul>` : empty("沒有符合條件的內容")}
    </section>`;
  $("#negSort").value = st.sort;
  bindSource(() => route());
  $$("[data-seg]", el).forEach((g) => $$("button", g).forEach((b) => b.addEventListener("click", () => { st[g.dataset.seg] = b.dataset.v; route(); })));
  $("#negSort").addEventListener("change", (e) => { st.sort = e.target.value; route(); });
  $("#negQ").addEventListener("change", (e) => { st.q = e.target.value.trim(); route(); });
  $$("[data-q]", el).forEach((b) => b.addEventListener("click", () => { st.q = b.dataset.q; route(); }));
  $("#negClear")?.addEventListener("click", () => { st.q = ""; route(); });
}

// ── 前台：主題監測（提及數、互動、平均、趨勢、排名、熱門貼文）─────────────
async function viewTopics(el, param) {
  const [sum, daily] = await Promise.all([api(`/api/ws/topics/summary?days=${S.days}`), api(`/api/ws/topics/daily?days=${S.days}`)]);
  if (!sum.length) { el.innerHTML = empty(`還沒有監測主題。<a href="#/manage">新增關鍵字或主題標籤</a>`); return; }
  const selId = Number(param) || sum[0].id;
  const sel = sum.find((t) => t.id === selId) || sum[0];

  const draw = async () => {
    const cols = [
      { label: "#", render: (r, i) => i + 1, num: true },
      { label: "主題", render: (r) => `<a href="#/topics/${r.id}">${r.type === "hashtag" ? "#" : ""}${esc(r.term)}</a> <span class="badge">${r.type === "hashtag" ? "標籤" : "關鍵字"}</span>${r.enabled ? "" : ' <span class="badge">已停用</span>'}` },
      { label: "提及數", sort: "mentions", num: true, render: (r) => fmt(r.mentions) },
      { label: "總互動", sort: "interactions", num: true, render: (r) => short(r.interactions) },
      { label: "平均互動", sort: "avg_inter", num: true, render: (r) => fmt(r.avg_inter) },
      { label: "互動中位數", sort: "median_inter", num: true, render: (r) => fmt(r.median_inter) },
      { label: "平均瀏覽", sort: "views_avg", num: true, render: (r) => short(r.views_avg) },
      { label: "提及趨勢", render: (r) => trendCell(r.mention_trend) },
      { label: "互動趨勢", render: (r) => trendCell(r.inter_trend) },
      { label: "負面", sort: "flagged", num: true, render: (r) => (r.flagged ? `<span class="flag">${r.flagged}</span>` : "0") },
    ];
    const s = daily.series.find((x) => x.id === sel.id);
    const color = topicColor(sel.id);
    el.innerHTML = `${guestNote}
      <section class="card" data-block="topics.ranking"><h2>主題熱度排名</h2><p class="sub">點欄位標題可切換排名依據。「平均」與「中位數」一起看，避免被少數爆文誤導；趨勢比較期間前半與後半。</p>
        ${sortableTable("t-topics", cols, sum, { defaultSort: { key: "interactions", dir: -1 }, onRow: true })}</section>
      <section class="card" data-block="topics.trend"><h2>${sel.type === "hashtag" ? "#" : ""}${esc(sel.term)}：熱度趨勢</h2><p class="sub">提及數與互動數分開畫，各自一個刻度</p>
        <div class="grid2">
          <div><h3>每日提及數</h3><div class="chart h200"><canvas id="c-m"></canvas></div></div>
          <div><h3>每日互動數</h3><div class="chart h200"><canvas id="c-i"></canvas></div></div>
        </div></section>
      <section class="card" data-block="topics.hot"><h2>${sel.type === "hashtag" ? "#" : ""}${esc(sel.term)}：熱門貼文</h2><p class="sub">依總互動排序，適合研究爆文結構</p><div id="hot">載入中…</div></section>`;
    bindTable("t-topics", sum, draw, (r) => (location.hash = `#/topics/${r.id}`));
    const labels = daily.dates.map(shortDate);
    mkChart("c-m", { type: "bar", data: { labels, datasets: [barDs("提及數", s?.mentions || [], color)] }, options: chartOpts() });
    mkChart("c-i", { type: "bar", data: { labels, datasets: [barDs("互動數", s?.interactions || [], color)] }, options: chartOpts() });
    const hot = await api(`/api/ws/posts?days=${S.days}&topic=${sel.id}&sort=inter&limit=10`);
    $("#hot").innerHTML = hot.length ? postTable("t-hot", hot, { compact: true }) : empty("期間內沒有貼文");
    bindPostTable("t-hot", hot);
  };
  await draw();
}

// ── 前台：多主題交叉比較 ─────────────────────────────────────────────
async function viewCompare(el) {
  const [sum, daily] = await Promise.all([api(`/api/ws/topics/summary?days=${S.days}`), api(`/api/ws/topics/daily?days=${S.days}`)]);
  if (sum.length < 2) { el.innerHTML = empty(`至少要有兩個主題才能比較。<a href="#/manage">新增主題</a>`); return; }
  S.compareSel ||= new Set(sum.slice(0, 8).map((t) => t.id));
  const draw = () => {
    destroyCharts();
    const picked = sum.filter((t) => S.compareSel.has(t.id));
    const series = daily.series.filter((s) => S.compareSel.has(s.id));
    const totalMentions = picked.reduce((a, t) => a + t.mentions, 0) || 1;
    el.innerHTML = `
      <div class="chips">${sum.map((t) => `<span class="chip ${S.compareSel.has(t.id) ? "" : "off"}" data-id="${t.id}" role="button" tabindex="0"><span class="dot" style="background:${topicColor(t.id)}"></span>${t.type === "hashtag" ? "#" : ""}${esc(t.term)}</span>`).join("")}</div>
      <p class="sub">最多同時比較 8 個主題。點選主題可加入或移除。</p>
      <div class="grid2">
        <section class="card" data-block="compare.daily"><h2>每日提及數</h2><div class="chart h280"><canvas id="c-cm"></canvas></div></section>
        <section class="card" data-block="compare.daily"><h2>每日互動數</h2><div class="chart h280"><canvas id="c-ci"></canvas></div></section>
      </div>
      <section class="card" data-block="compare.dist"><h2>互動分布</h2><p class="sub">各主題的貼文落在哪個互動級距；爆文集中還是普遍都有人互動，一眼看出</p><div class="chart h280"><canvas id="c-dist"></canvas></div></section>
      <section class="card" data-block="compare.table"><h2>數字對照</h2>
        ${sortableTable("t-cmp", [
          { label: "主題", render: (r) => `<span class="sent" style="--sent-neu:${topicColor(r.id)}"></span>${r.type === "hashtag" ? "#" : ""}${esc(r.term)}` },
          { label: "提及數", sort: "mentions", num: true, render: (r) => fmt(r.mentions) },
          { label: "討論佔比", sort: "mentions", num: true, render: (r) => pct((r.mentions / totalMentions) * 100) },
          { label: "總互動", sort: "interactions", num: true, render: (r) => short(r.interactions) },
          { label: "平均互動", sort: "avg_inter", num: true, render: (r) => fmt(r.avg_inter) },
          { label: "中位數", sort: "median_inter", num: true, render: (r) => fmt(r.median_inter) },
          { label: "平均瀏覽", sort: "views_avg", num: true, render: (r) => short(r.views_avg) },
          { label: "提及趨勢", render: (r) => trendCell(r.mention_trend) },
        ], picked, { defaultSort: { key: "mentions", dir: -1 } })}
      </section>`;
    $$(".chip", el).forEach((c) => c.addEventListener("click", () => {
      const id = Number(c.dataset.id);
      if (S.compareSel.has(id)) S.compareSel.delete(id);
      else if (S.compareSel.size < 8) S.compareSel.add(id);
      else return toast("最多同時比較 8 個主題", true);
      draw();
    }));
    bindTable("t-cmp", picked, draw);
    const labels = daily.dates.map(shortDate);
    const name = (s) => (s.type === "hashtag" ? "#" : "") + s.term;
    mkChart("c-cm", { type: "line", data: { labels, datasets: series.map((s) => lineDs(name(s), s.mentions, topicColor(s.id))) }, options: chartOpts({ legend: true }) });
    mkChart("c-ci", { type: "line", data: { labels, datasets: series.map((s) => lineDs(name(s), s.interactions, topicColor(s.id))) }, options: chartOpts({ legend: true }) });
    const ramp = ["--ramp-250", "--ramp-350", "--ramp-550", "--ramp-700"].map(css);
    const bucketNames = ["互動 0–9", "10–99", "100–999", "1,000 以上"];
    mkChart("c-dist", {
      type: "bar",
      data: { labels: picked.map((t) => (t.type === "hashtag" ? "#" : "") + t.term), datasets: bucketNames.map((b, i) => barDs(b, picked.map((t) => t.distribution[i]), ramp[i], true)) },
      options: chartOpts({ legend: true, stacked: true, horizontal: true }),
    });
  };
  draw();
}

// ── 前台：貼文成效（全部串文列表 + 貼文互動比較）─────────────────────────
function postTable(id, posts, { compact = false, select = false } = {}) {
  const cols = [
    ...(select ? [{ label: "比較", render: (p) => `<input type="checkbox" class="cmp" value="${p.code}" ${S.postSel?.has(p.code) ? "checked" : ""} aria-label="加入比較">` }] : []),
    { label: "發布時間", sort: "posted_at", render: (p) => `<span class="nowrap">${twTime(p.posted_at)}</span>` },
    { label: "作者", render: (p) => `@${esc(p.author)}` },
    { label: "內文", cls: "content-cell", render: (p) => `<a href="#/post/${p.code}">${esc(snippet(p.content, compact ? 36 : 60))}</a>${p.media_type && p.media_type !== "text" ? ` <span class="badge">${p.media_type === "video" ? "影片" : "圖片"}</span>` : ""} ${flags(p.neg_hits)}` },
    { label: "讚", sort: "likes", num: true, render: (p) => fmt(p.likes) },
    { label: "留言", sort: "replies", num: true, render: (p) => fmt(p.replies) },
    ...(compact ? [] : [{ label: "轉發", sort: "reposts", num: true, render: (p) => fmt(p.reposts) }, { label: "分享", sort: "shares", num: true, render: (p) => fmt(p.shares) }]),
    { label: "總互動", sort: "inter", num: true, render: (p) => `<strong>${fmt(p.inter)}</strong>` },
    ...(compact ? [] : [{ label: "較上次", num: true, render: (p) => (p.delta ? signed(p.delta.inter) : "—") }]),
    { label: "瀏覽", sort: "views", num: true, render: (p) => short(p.views) },
    ...(compact ? [] : [{ label: "互動率", sort: "er", num: true, render: (p) => (p.er != null ? pct(p.er, 2) : "—") }]),
    { label: "留言情緒", render: (p) => (p.c_total ? `<span class="small nowrap">正 ${p.c_pos}・負 ${p.c_neg}／${p.c_total}</span>` : `<span class="muted small">未抓</span>`) },
  ];
  return sortableTable(id, cols, posts, { onRow: true });
}
function bindPostTable(id, posts, rerender) {
  bindTable(id, posts, rerender || (() => {}), (p) => (location.hash = `#/post/${p.code}`));
}

async function viewPosts(el) {
  S.postSel ||= new Set();
  const q = S.postQ || "";
  const posts = await api(`/api/ws/posts?days=${S.days}${sourceQuery()}&sort=newest&limit=500${q ? `&q=${encodeURIComponent(q)}` : ""}`);
  const draw = () => {
    destroyCharts();
    const picked = posts.filter((p) => S.postSel.has(p.code));
    el.innerHTML = `
      <div class="filters">${sourceSelect()}
        <input type="search" id="postQ" placeholder="搜尋內文" value="${esc(q)}">
        <a class="btn sm" data-block="posts.csv" href="/api/ws/export/posts.csv?ws=${S.ws.id}&days=${S.days}${sourceQuery()}">下載 CSV</a>
      </div>
      ${picked.length >= 2 ? `<section class="card" data-block="posts.compare"><h2>貼文互動比較（${picked.length} 篇）</h2><p class="sub">同一個刻度比較讚、留言、轉發、分享</p>
        <div class="chart h280"><canvas id="c-pc"></canvas></div>
        <p style="margin-top:8px"><button class="btn sm" id="clearSel">清除選取</button></p></section>` : `<div class="note" data-block="posts.compare">勾選 2–5 篇貼文的「比較」，會在這裡並排比較互動表現。</div>`}
      <section class="card" data-block="posts.list"><h2>全部串文成效</h2><p class="sub">共 ${fmt(posts.length)} 篇。點欄位標題排序，點列開啟詳情。「較上次」是跟前一次抓取相比的互動增加量；互動率＝互動÷作者粉絲數（僅監測帳號有）。</p>
        ${posts.length ? postTable("t-posts", posts, { select: true }) : empty("沒有符合條件的貼文")}</section>`;
    bindSource(() => route());
    $("#postQ").addEventListener("change", (e) => { S.postQ = e.target.value.trim(); route(); });
    bindPostTable("t-posts", posts, draw);
    $$(".cmp", el).forEach((cb) => cb.addEventListener("change", () => {
      if (cb.checked && S.postSel.size >= 5) { cb.checked = false; return toast("最多比較 5 篇", true); }
      cb.checked ? S.postSel.add(cb.value) : S.postSel.delete(cb.value);
      draw();
    }));
    $("#clearSel")?.addEventListener("click", () => { S.postSel.clear(); draw(); });
    if (picked.length >= 2) {
      const c = SERIES();
      mkChart("c-pc", {
        type: "bar",
        data: { labels: ["讚", "留言", "轉發", "分享"], datasets: picked.map((p, i) => barDs(`${i + 1}. @${p.author}：${snippet(p.content, 14)}`, [p.likes, p.replies, p.reposts, p.shares], c[i])) },
        options: chartOpts({ legend: true }),
      });
    }
  };
  draw();
}

// ── 貼文詳情 ─────────────────────────────────────────────────────────
async function viewPost(el, code) {
  const d = await api(`/api/ws/posts/${encodeURIComponent(code)}`);
  const p = d.post;
  let filter = "all";
  const draw = () => {
    destroyCharts();
    const list = d.comments.filter((c) => filter === "all" || (filter === "flag" ? c.neg_hits.length : c.sentiment === filter));
    const cnt = (s) => d.comments.filter((c) => c.sentiment === s).length;
    el.innerHTML = `
      <p><a href="javascript:history.back()">← 返回</a></p>
      <section class="card">
        <div class="meta muted small" style="display:flex;flex-wrap:wrap;gap:4px 12px">
          <span>${authorLink(p.author)}${p.author_name ? `（${esc(p.author_name)}）` : ""}</span><span>${twFull(p.posted_at)}</span>
          ${d.topics.map((t) => `<span class="badge">${t.type === "hashtag" ? "#" : ""}${esc(t.term)}</span>`).join("")}
          ${p.topic_tag ? `<span class="badge">主題：${esc(p.topic_tag)}</span>` : ""}${sentBadge(p.sentiment)}${flags(p.neg_hits)}
        </div>
        <p class="pre" style="font-size:15px;margin:12px 0">${esc(p.content || "（無文字）")}</p>
        <a href="${esc(p.url)}" target="_blank" rel="noopener">在 Threads 開啟 ↗</a>
      </section>
      <div class="tiles">
        ${tile("讚", fmt(p.likes))}${tile("留言", fmt(p.replies))}${tile("轉發", fmt(p.reposts))}${tile("分享", fmt(p.shares))}
        ${tile("瀏覽", short(p.views), p.views ? `每千次瀏覽 ${fmt(Math.round((p.inter / p.views) * 10000) / 10)} 次互動` : "尚未取得")}
        ${tile("互動率", p.er != null ? pct(p.er, 2) : "—", p.followers ? `粉絲 ${short(p.followers)}` : "作者不在監測清單")}
      </div>
      <div class="grid2">
        <section class="card"><h2>互動成長</h2><p class="sub">每次抓取記一筆</p>${d.metrics.length >= 2 ? `<div class="chart h240"><canvas id="c-grow"></canvas></div>` : empty("至少要抓兩次才畫得出成長曲線")}</section>
        <section class="card"><h2>瀏覽成長</h2><p class="sub">只有逐篇點進貼文頁時才取得</p>${d.metrics.filter((m) => m.views != null).length >= 2 ? `<div class="chart h240"><canvas id="c-view"></canvas></div>` : empty("瀏覽紀錄不足兩筆")}</section>
      </div>
      <section class="card"><h2>留言（已抓 ${d.comments.length} 則）</h2>
        <div class="filters"><div class="seg" id="cf">
          ${[["all", "全部"], ["flag", `⚠ 負面關鍵字 ${d.comments.filter((c) => c.neg_hits.length).length}`], ["negative", `負面 ${cnt("negative")}`], ["positive", `正面 ${cnt("positive")}`], ["neutral", `中性 ${cnt("neutral")}`]]
            .map(([k, t]) => `<button class="${filter === k ? "on" : ""}" data-k="${k}">${t}</button>`).join("")}
        </div></div>
        ${list.length ? `<ul class="list">${list.map((c) => `<li><span class="pre">${esc(c.content || "（無文字）")}</span>
          <div class="meta"><span>${authorLink(c.author)}</span><span>${twTime(c.posted_at)}</span><span>讚 ${fmt(c.likes)}</span>${c.author_liked ? `<span>原作者說讚</span>` : ""}${sentBadge(c.sentiment)}${flags(c.neg_hits)}</div></li>`).join("")}</ul>` : empty("沒有符合的留言")}
      </section>`;
    $$("#cf button", el).forEach((b) => b.addEventListener("click", () => { filter = b.dataset.k; draw(); }));
    const labels = d.metrics.map((m) => twTime(m.captured_at));
    const c = SERIES();
    mkChart("c-grow", { type: "line", data: { labels, datasets: [lineDs("讚", d.metrics.map((m) => m.likes), c[0]), lineDs("留言", d.metrics.map((m) => m.replies), c[1]), lineDs("轉發", d.metrics.map((m) => m.reposts), c[2]), lineDs("分享", d.metrics.map((m) => m.shares), c[3])] }, options: chartOpts({ legend: true }) });
    mkChart("c-view", { type: "line", data: { labels, datasets: [lineDs("瀏覽", d.metrics.map((m) => m.views), c[0])] }, options: chartOpts() });
  };
  draw();
}

// ── 前台：瀏覽分析 ───────────────────────────────────────────────────
async function viewViews(el) {
  const d = await api(`/api/ws/views?days=${S.days}${sourceQuery()}`);
  const classes = ["曝光與互動俱佳", "高曝光低互動", "曝光偏低", "一般"];
  const count = (c) => d.posts.filter((p) => p.exposure === c).length;
  const draw = () => {
    destroyCharts();
    el.innerHTML = `
      <div class="filters">${sourceSelect()}</div>
      <div class="note">瀏覽數是 Threads 貼文頁公開顯示的數字，系統逐篇點進貼文時才取得（每次抓取有上限，可在系統設定調整）。判斷基準：以期間內的中位數為準——瀏覽不到中位數一半算「曝光偏低」；瀏覽夠但每千次瀏覽的互動不到中位數一半算「高曝光低互動」。</div>
      <div class="tiles" data-block="views.kpi">
        ${tile("有瀏覽資料", fmt(d.posts.length) + " 篇")}
        ${tile("瀏覽中位數", short(d.median_views))}
        ${tile("互動／千次瀏覽（中位）", fmt(d.median_per_k))}
        ${classes.map((c) => tile(c, fmt(count(c)) + " 篇")).join("")}
      </div>
      <section class="card" data-block="views.scatter"><h2>瀏覽 × 互動</h2><p class="sub">橫軸瀏覽（對數刻度），縱軸總互動；右下角＝看的人多但不太互動</p>
        ${d.posts.length ? `<div class="chart h320"><canvas id="c-sc"></canvas></div>` : empty("還沒有瀏覽資料")}</section>
      <section class="card" data-block="views.table"><h2>各貼文曝光判斷</h2>
        ${sortableTable("t-views", [
          { label: "發布時間", sort: "posted_at", render: (p) => `<span class="nowrap">${twTime(p.posted_at)}</span>` },
          { label: "作者", render: (p) => `@${esc(p.author)}` },
          { label: "內文", cls: "content-cell", render: (p) => `<a href="#/post/${p.code}">${esc(snippet(p.content, 50))}</a>` },
          { label: "瀏覽", sort: "views", num: true, render: (p) => fmt(p.views) },
          { label: "總互動", sort: "inter", num: true, render: (p) => fmt(p.inter) },
          { label: "互動／千次瀏覽", sort: "per_k_views", num: true, render: (p) => fmt(p.per_k_views) },
          { label: "判斷", sort: "exposure", render: (p) => esc(p.exposure) },
        ], d.posts, { defaultSort: { key: "views", dir: -1 }, onRow: true })}</section>`;
    bindSource(() => route());
    bindTable("t-views", d.posts, draw, (p) => (location.hash = `#/post/${p.code}`));
    if (d.posts.length) {
      mkChart("c-sc", {
        type: "scatter",
        data: { datasets: [{ label: "貼文", data: d.posts.map((p) => ({ x: Math.max(p.views, 1), y: p.inter, p })), backgroundColor: css("--series-1"), borderColor: css("--surface"), borderWidth: 2, pointRadius: 5, pointHoverRadius: 7, pointHitRadius: 10 }] },
        options: chartOpts({ xLog: true, xTitle: "瀏覽", yTitle: "總互動", tooltip: { callbacks: { label: (c) => `@${c.raw.p.author}：${snippet(c.raw.p.content, 24)}｜瀏覽 ${short(c.raw.p.views)}・互動 ${fmt(c.raw.p.inter)}` } } }),
      });
    }
  };
  draw();
}

// ── 前台：帳號比較（競品監測、一對一、粉絲成長、互動率）──────────────────
async function viewAccounts(el) {
  const [sum, fol] = await Promise.all([api(`/api/ws/accounts/summary?days=${S.days}`), api(`/api/ws/accounts/followers?days=${S.days}`)]);
  if (!sum.length) { el.innerHTML = empty(`還沒有監測帳號。<a href="#/manage">新增自己的帳號或競品帳號</a>`); return; }
  const own = sum.find((a) => a.kind === "own");
  const comp = sum.find((a) => a.kind === "competitor");
  S.cmpA ||= (own || sum[0]).handle;
  S.cmpB ||= (comp && comp.handle !== S.cmpA ? comp : sum.find((a) => a.handle !== S.cmpA) || sum[0]).handle;

  const draw = async () => {
    destroyCharts();
    const opts = (v) => sum.map((a) => `<option value="${esc(a.handle)}" ${a.handle === v ? "selected" : ""}>@${esc(a.handle)}${a.kind === "own" ? "（自己）" : ""}</option>`).join("");
    el.innerHTML = `${guestNote}
      <section class="card" data-block="accounts.summary"><h2>帳號總覽</h2><p class="sub">互動率＝平均互動 ÷ 粉絲數。粉絲成長從系統開始記錄的那天算起。</p>
        ${sortableTable("t-acc", [
          { label: "帳號", render: (a) => `<span class="sent" style="--sent-neu:${accountColor(a.handle)}"></span>${authorLink(a.handle)} ${a.kind === "own" ? '<span class="badge own">自己</span>' : '<span class="badge">競品</span>'}<div class="muted small">${esc(a.label || a.name || "")}</div>` },
          { label: "粉絲", sort: "followers", num: true, render: (a) => short(a.followers) },
          { label: "期間成長", sort: "growth", num: true, render: (a) => signed(a.growth) },
          { label: "成長率", sort: "growth_pct", num: true, render: (a) => (a.growth_pct != null ? pct(a.growth_pct, 2) : "—") },
          { label: "每日成長", sort: "growth_per_day", num: true, render: (a) => signed(a.growth_per_day) },
          { label: "貼文", sort: "posts", num: true, render: (a) => fmt(a.posts) },
          { label: "每週發文", sort: "posts_per_week", num: true, render: (a) => fmt(a.posts_per_week) },
          { label: "平均互動", sort: "avg_inter", num: true, render: (a) => fmt(a.avg_inter) },
          { label: "中位數", sort: "median_inter", num: true, render: (a) => fmt(a.median_inter) },
          { label: "互動率", sort: "er", num: true, render: (a) => (a.er != null ? pct(a.er, 2) : "—") },
          { label: "平均瀏覽", sort: "views_avg", num: true, render: (a) => short(a.views_avg) },
          { label: "最佳貼文", cls: "content-cell", render: (a) => (a.best ? `<a href="#/post/${a.best.code}">${esc(snippet(a.best.content, 26))}</a> <span class="muted small">互動 ${fmt(a.best.inter)}</span>` : "—") },
        ], sum, { defaultSort: { key: "followers", dir: -1 } })}</section>
      <section class="card" data-block="accounts.growth"><h2>粉絲成長速度</h2><p class="sub">各帳號粉絲數量級不同，改畫「相對第一筆紀錄的成長 %」，同一個刻度才能比較動能</p>
        <div class="chart h280"><canvas id="c-fol"></canvas></div></section>
      <section class="card" data-block="accounts.compare"><h2>一對一比較</h2>
        <div class="filters"><select id="cmpA">${opts(S.cmpA)}</select><span class="muted">vs</span><select id="cmpB">${opts(S.cmpB)}</select></div>
        <div id="cmpBody">載入中…</div></section>`;
    bindTable("t-acc", sum, draw);
    mkChart("c-fol", { type: "line", data: { labels: fol.dates.map(shortDate), datasets: fol.series.map((s) => lineDs("@" + s.handle, s.index, accountColor(s.handle))) },
      options: chartOpts({ legend: true, yTitle: "成長 %", tooltip: { callbacks: { label: (c) => `${c.dataset.label}：${c.raw > 0 ? "+" : ""}${c.raw}%（粉絲 ${fmt(fol.series[c.datasetIndex].followers[c.dataIndex])}）` } } }) });
    $("#cmpA").addEventListener("change", (e) => { S.cmpA = e.target.value; drawCompare(); });
    $("#cmpB").addEventListener("change", (e) => { S.cmpB = e.target.value; drawCompare(); });
    await drawCompare();
  };

  const drawCompare = async () => {
    for (const id of ["c-w1", "c-w2"]) { const i = S.charts.findIndex((c) => c.canvas.id === id); if (i >= 0) { S.charts[i].destroy(); S.charts.splice(i, 1); } }
    if (S.cmpA === S.cmpB) { $("#cmpBody").innerHTML = empty("請選兩個不同的帳號"); return; }
    const d = await api(`/api/ws/accounts/compare?days=${S.days}&a=${encodeURIComponent(S.cmpA)}&b=${encodeURIComponent(S.cmpB)}`);
    const { a, b } = d;
    const rows = [
      ["粉絲數", "followers", short], ["期間粉絲成長", "growth", signed], ["成長率", "growth_pct", (v) => (v == null ? "—" : pct(v, 2))],
      ["每日成長", "growth_per_day", signed], ["貼文數", "posts", fmt], ["每週發文", "posts_per_week", fmt],
      ["平均互動", "avg_inter", fmt], ["互動中位數", "median_inter", fmt], ["互動率", "er", (v) => (v == null ? "—" : pct(v, 2))], ["平均瀏覽", "views_avg", short],
    ];
    const lead = (x, y) => (x == null || y == null || x === y ? "—" : x > y ? `@${a.handle} 較高` : `@${b.handle} 較高`);
    $("#cmpBody").innerHTML = `
      <div class="table-wrap"><table class="data"><thead><tr><th>指標</th><th class="num">@${esc(a.handle)}</th><th class="num">@${esc(b.handle)}</th><th>差距</th></tr></thead>
        <tbody>${rows.map(([label, key, f]) => `<tr><td>${label}</td><td class="num">${f(a[key])}</td><td class="num">${f(b[key])}</td><td class="small">${lead(a[key], b[key])}</td></tr>`).join("")}</tbody></table></div>
      <div class="grid2" style="margin-top:14px">
        <div><h3>每週平均互動</h3><div class="chart h240"><canvas id="c-w1"></canvas></div></div>
        <div><h3>每週發文數</h3><div class="chart h240"><canvas id="c-w2"></canvas></div></div>
      </div>`;
    const labels = d.weekly.labels.map((x) => shortDate(x) + " 起");
    mkChart("c-w1", { type: "line", data: { labels, datasets: d.weekly.series.map((s) => lineDs("@" + s.handle, s.avg_inter, accountColor(s.handle))) }, options: chartOpts({ legend: true }) });
    mkChart("c-w2", { type: "bar", data: { labels, datasets: d.weekly.series.map((s) => barDs("@" + s.handle, s.posts, accountColor(s.handle))) }, options: chartOpts({ legend: true }) });
  };
  await draw();
}

// ── 前台：最佳發文時段 ───────────────────────────────────────────────
async function viewTimes(el) {
  if (S.source === "all" && !S.timesInit && S.accounts.some((a) => a.kind === "own")) S.source = "kind:own";
  S.timesInit = true;
  const d = await api(`/api/ws/best-times?days=${Math.max(S.days, 30)}${sourceQuery()}`);
  const filled = d.cells.filter((c) => c.n > 0).map((c) => c.avg).sort((x, y) => x - y);
  const steps = ["--ramp-150", "--ramp-250", "--ramp-350", "--ramp-450", "--ramp-550", "--ramp-650"];
  const shade = (v) => {
    if (v == null || !filled.length) return "";
    const rank = filled.findIndex((x) => x >= v) / Math.max(filled.length - 1, 1);
    const i = Math.min(steps.length - 1, Math.floor(rank * steps.length));
    return `background:${css(steps[i])};color:${i >= 3 ? "#fff" : "#0b0b0b"}`;
  };
  const order = [1, 2, 3, 4, 5, 6, 0];
  el.innerHTML = `
    <div class="filters">${sourceSelect()}<span class="muted small">期間至少取近 30 天，樣本才夠</span></div>
    <section class="card" data-block="times.heatmap"><h2>星期 × 時段的平均互動</h2><p class="sub">共 ${fmt(d.posts)} 篇貼文，依發布時間（台灣）分格；格內上方為平均互動、下方為篇數。顏色越深表示平均互動越高。</p>
      ${d.posts ? `<div class="table-wrap"><table class="heat"><thead><tr><th></th>${BLOCKS.map((b) => `<th>${b}</th>`).join("")}</tr></thead><tbody>
        ${order.map((day) => `<tr><th>週${WEEK[day]}</th>${BLOCKS.map((_, bi) => { const c = d.cells.find((x) => x.day === day && x.block === bi); return `<td style="${shade(c.avg)}" title="週${WEEK[day]} ${BLOCKS[bi]}：${c.n ? `平均互動 ${fmt(c.avg)}，${c.n} 篇` : "沒有貼文"}">${c.n ? `${short(c.avg)}<small>${c.n} 篇</small>` : ""}</td>`; }).join("")}</tr>`).join("")}
      </tbody></table></div>
      <div class="heat-legend">低 ${steps.map((s) => `<i style="background:${css(s)}"></i>`).join("")} 高</div>` : empty("這個來源還沒有貼文")}
    </section>
    <section class="card" data-block="times.recommend"><h2>建議發文時段</h2><p class="sub">只列出至少有 2 篇貼文的時段，依互動中位數排序（避免單篇爆文把整格拉高）</p>
      ${d.recommend.length ? `<ol>${d.recommend.map((c) => `<li><strong>週${WEEK[c.day]} ${BLOCKS[c.block]}</strong>：互動中位數 ${fmt(c.median)}、平均 ${fmt(c.avg)}（${c.n} 篇）</li>`).join("")}</ol>` : empty("樣本還不夠。每天持續抓取、或加入自己的帳號後會越來越準。")}
    </section>`;
  bindSource(() => route());
}

// ── 前台：內容成功模式 ───────────────────────────────────────────────
async function viewPatterns(el) {
  const d = await api(`/api/ws/patterns?days=${Math.max(S.days, 30)}${sourceQuery()}`);
  el.innerHTML = `<div class="filters">${sourceSelect()}<span class="muted small">期間至少取近 30 天</span></div>` + (!d.enough
    ? empty(`這個來源目前只有 ${d.posts} 篇有內文的貼文，至少需要 ${d.min} 篇才能分析。持續抓取幾天後再來看。`)
    : `
    <section class="card" data-block="patterns.insights"><h2>高成效貼文的共同點</h2><p class="sub">把 ${d.posts} 篇貼文依總互動排序，前 25%（${d.top_n} 篇、互動 ${fmt(d.threshold)} 以上）當「高成效」，跟其他貼文比較內容特徵</p>
      ${d.insights.length ? `<ul>${d.insights.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p class="muted">高成效與其他貼文在各項特徵上差距不大（都在 15 個百分點內）。</p>`}
    </section>
    <div class="grid2">
      <section class="card" data-block="patterns.features"><h2>特徵比較</h2>
        <div class="table-wrap"><table class="data"><thead><tr><th>特徵</th><th class="num">高成效</th><th class="num">其他</th><th class="num">差距</th></tr></thead>
        <tbody>${d.rows.map((r) => `<tr><td>${esc(r.label)}</td><td class="num">${r.top}%</td><td class="num">${r.rest}%</td><td class="num">${r.diff > 0 ? "+" : ""}${r.diff}</td></tr>`).join("")}
        <tr><td>平均字數</td><td class="num">${d.avg_len.top}</td><td class="num">${d.avg_len.rest}</td><td class="num">${d.avg_len.top - d.avg_len.rest > 0 ? "+" : ""}${d.avg_len.top - d.avg_len.rest}</td></tr></tbody></table></div>
      </section>
      <section class="card" data-block="patterns.features"><h2>高成效貼文常見詞</h2><p class="sub">在高成效貼文出現比例明顯高於其他貼文的雙字詞，可當題材靈感</p>
        ${d.terms.length ? d.terms.map((t) => `<span class="term" title="高成效 ${t.top_share}%／其他 ${t.rest_share}%">${esc(t.term)} <span class="muted small">${t.top_share}% vs ${t.rest_share}%</span></span>`).join("") : empty("沒有明顯的共同詞")}
      </section>
    </div>
    <section class="card" data-block="patterns.examples"><h2>高成效範例</h2>
      <ul class="list">${d.examples.map((p) => `<li><a href="#/post/${p.code}">${esc(p.content)}</a><div class="meta"><span>@${esc(p.author)}</span><span>互動 ${fmt(p.inter)}</span></div></li>`).join("")}</ul>
    </section>`);
  bindSource(() => route());
}

// ── 後台：監測設定（主題、帳號）────────────────────────────────────────
async function viewManage(el) {
  await loadWorkspaceLists();
  const ed = can("editor");
  const dis = ed ? "" : "disabled";
  el.innerHTML = `
    ${ed ? "" : `<div class="note">你是「檢視者」，只能查看設定。</div>`}
    <section class="card" data-block="manage.topics"><h2>主題監測</h2><p class="sub">關鍵字：內文或主題含這個字的貼文；主題標籤：Threads 標籤搜尋的結果。「天數」是只收近幾天發布的貼文。</p>
      <form class="form-row" id="topicForm">
        <label class="field">類型<select name="type" ${dis}><option value="keyword">關鍵字</option><option value="hashtag">主題標籤</option></select></label>
        <label class="field">關鍵字／標籤<input name="term" type="text" placeholder="例：世新、#世新大學" required ${dis}></label>
        <label class="field">天數<input name="max_days" type="number" min="1" max="30" value="3" style="width:80px" ${dis}></label>
        <button class="btn primary" ${dis}>新增主題</button>
      </form>
      ${S.topics.length ? `<div class="table-wrap" style="margin-top:12px"><table class="data"><thead><tr><th>類型</th><th>主題</th><th>天數</th><th>啟用</th><th></th></tr></thead><tbody>
        ${S.topics.map((t) => `<tr><td>${t.type === "hashtag" ? "主題標籤" : "關鍵字"}</td><td><span class="sent" style="--sent-neu:${topicColor(t.id)}"></span>${t.type === "hashtag" ? "#" : ""}${esc(t.term)}</td>
          <td><input type="number" min="1" max="30" value="${t.max_days}" data-topic-days="${t.id}" style="width:70px" ${dis}></td>
          <td><input type="checkbox" data-topic-on="${t.id}" ${t.enabled ? "checked" : ""} ${dis} aria-label="啟用"></td>
          <td><button class="btn sm danger" data-topic-del="${t.id}" ${dis}>刪除</button></td></tr>`).join("")}
      </tbody></table></div>` : empty("還沒有主題")}
    </section>
    <section class="card" data-block="manage.accounts"><h2>帳號監測</h2><p class="sub">加入自己的帳號與競品帳號，系統每天記錄粉絲數與貼文表現。可以輸入 @帳號 或貼上個人頁網址。</p>
      <form class="form-row" id="accForm">
        <label class="field">帳號<input name="handle" type="text" placeholder="@example" required ${dis}></label>
        <label class="field">顯示名稱（選填）<input name="label" type="text" ${dis}></label>
        <label class="field">類型<select name="kind" ${dis}><option value="competitor">競品</option><option value="own">自己的帳號</option></select></label>
        <button class="btn primary" ${dis}>新增帳號</button>
      </form>
      ${S.accounts.length ? `<div class="table-wrap" style="margin-top:12px"><table class="data"><thead><tr><th>帳號</th><th>名稱</th><th>類型</th><th class="num">粉絲</th><th>最後更新</th><th>啟用</th><th></th></tr></thead><tbody>
        ${S.accounts.map((a) => `<tr><td>${authorLink(a.handle)}</td><td>${esc(a.label || a.name || "")}</td>
          <td><select data-acc-kind="${a.id}" ${dis}><option value="competitor" ${a.kind === "competitor" ? "selected" : ""}>競品</option><option value="own" ${a.kind === "own" ? "selected" : ""}>自己</option></select></td>
          <td class="num">${short(a.followers)}</td><td class="small">${a.last_seen ? twTime(a.last_seen) : "尚未抓取"}</td>
          <td><input type="checkbox" data-acc-on="${a.id}" ${a.enabled ? "checked" : ""} ${dis} aria-label="啟用"></td>
          <td><button class="btn sm danger" data-acc-del="${a.id}" ${dis}>刪除</button></td></tr>`).join("")}
      </tbody></table></div>` : empty("還沒有監測帳號")}
    </section>
    <div class="note">新增後要等下一次抓取（排程或「抓取與排程」頁的立即抓取）才會有資料。刪除主題或帳號不會刪掉已抓到的貼文。</div>`;

  const act = async (fn) => { try { await fn(); await viewManage(el); } catch (e) { toast(e.message, true); } };
  $("#topicForm").addEventListener("submit", (e) => { e.preventDefault(); const f = new FormData(e.target); act(async () => { await api("/api/ws/topics", { body: Object.fromEntries(f) }); toast("已新增主題"); }); });
  $("#accForm").addEventListener("submit", (e) => { e.preventDefault(); const f = new FormData(e.target); act(async () => { await api("/api/ws/accounts", { body: Object.fromEntries(f) }); toast("已新增帳號"); }); });
  $$("[data-topic-days]").forEach((i) => i.addEventListener("change", () => act(() => api(`/api/ws/topics/${i.dataset.topicDays}`, { method: "PATCH", body: { max_days: Number(i.value) } }))));
  $$("[data-topic-on]").forEach((i) => i.addEventListener("change", () => act(() => api(`/api/ws/topics/${i.dataset.topicOn}`, { method: "PATCH", body: { enabled: i.checked } }))));
  $$("[data-topic-del]").forEach((b) => b.addEventListener("click", () => confirm("確定刪除這個主題？") && act(() => api(`/api/ws/topics/${b.dataset.topicDel}`, { method: "DELETE" }))));
  $$("[data-acc-kind]").forEach((i) => i.addEventListener("change", () => act(() => api(`/api/ws/accounts/${i.dataset.accKind}`, { method: "PATCH", body: { kind: i.value } }))));
  $$("[data-acc-on]").forEach((i) => i.addEventListener("change", () => act(() => api(`/api/ws/accounts/${i.dataset.accOn}`, { method: "PATCH", body: { enabled: i.checked } }))));
  $$("[data-acc-del]").forEach((b) => b.addEventListener("click", () => confirm("確定移除這個帳號？") && act(() => api(`/api/ws/accounts/${b.dataset.accDel}`, { method: "DELETE" }))));
}

// ── 後台：立即爬文（只抓近幾小時、抓過的不重複）─────────────────────────
const QUICK_HOURS = [3, 6, 12, 24];
const ago = (iso) => { const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000)); return m < 60 ? `${m} 分鐘前` : `${Math.floor(m / 60)} 小時前`; };

// 立即爬文與抓取與排程共用：這個工作區已抓到、發布時間最新的 10 篇貼文；isNew 決定哪些標「新」
const fetchLatest = () => api("/api/ws/posts?days=365&sort=newest&limit=10");
function latestPostsCard(id, posts, isNew, note = "") {
  const cols = [
    { label: "發布時間", sort: "posted_at", render: (p) => `<span class="nowrap">${twTime(p.posted_at)}</span><div class="muted small nowrap">${ago(p.posted_at)}</div>` },
    { label: "作者", render: (p) => authorLink(p.author) },
    { label: "內文", cls: "content-cell", render: (p) => `${isNew(p) ? '<span class="badge new">新</span> ' : ""}<a href="#/post/${p.code}">${esc(snippet(p.content, 70))}</a>${p.media_type && p.media_type !== "text" ? ` <span class="badge">${p.media_type === "video" ? "影片" : "圖片"}</span>` : ""} ${flags(p.neg_hits)}` },
    { label: "來源", render: (p) => `<span class="small">${esc(p.topics || "監測帳號")}</span>` },
    { label: "讚", sort: "likes", num: true, render: (p) => fmt(p.likes) },
    { label: "留言", sort: "replies", num: true, render: (p) => fmt(p.replies) },
    { label: "瀏覽", sort: "views", num: true, render: (p) => short(p.views) },
    { label: "", render: (p) => `<a href="${esc(p.url)}" target="_blank" rel="noopener" class="small nowrap">Threads ↗</a>` },
  ];
  return `<section class="card" data-block="${id === "t-latest" ? "crawl.latest" : "quick.latest"}"><h2>最新 10 篇貼文</h2>
    <p class="sub">這個工作區已抓到的貼文，依發布時間由新到舊${note}。點列開啟詳情，點欄位標題排序。</p>
    ${posts.length ? sortableTable(id, cols, posts, { onRow: true }) : empty("還沒有抓到任何貼文")}</section>`;
}

async function viewQuick(el) {
  clearTimers();
  S.quickHours ||= 6;
  S.quickVisit ??= true;
  const h = S.quickHours;
  const [st, d, latest] = await Promise.all([api("/api/crawl/status"), api(`/api/ws/recent?hours=${h}`), fetchLatest(), loadWorkspaceLists()]);
  const topics = S.topics.filter((t) => t.enabled);
  const accounts = S.accounts.filter((a) => a.enabled);
  const nothing = !topics.length && !accounts.length;
  const last = d.last_run;
  const fresh = new Set(last?.new_codes || []);
  const quickRunning = st.running && st.trigger === "quick";
  const status = !st.running ? "目前閒置"
    : quickRunning ? `立即爬文中（run #${st.runId}，近 ${st.hours} 小時，${twTime(st.startedAt)} 開始）`
    : `有一般抓取正在進行（run #${st.runId}），結束後才能立即爬文`;
  const lastLine = last ? `上次立即爬文：${twFull(last.started_at)}（近 ${last.window_hours} 小時・${esc(last.started_by || "")}）— ${RUN_ST[last.status] || esc(last.status)}，新收 ${fmt(last.posts_new)} 篇、已抓過略過 ${fmt(last.posts_skipped)} 篇${last.posts_visited ? `、點進 ${fmt(last.posts_visited)} 篇` : ""}${last.logged_out ? "・遇到登入牆" : ""}` : "";
  const draw = () => {
    el.innerHTML = `
      <section class="card" data-block="quick.run"><h2>立即爬文</h2>
        <p class="sub">馬上抓一次這個工作區的主題與帳號，<strong>只收近 ${h} 小時內發布、資料庫裡還沒有的貼文</strong>。抓過的一律略過：不重複收錄、不重新點進去。通常 1–5 分鐘。</p>
        ${nothing ? `<div class="note">這個工作區還沒有啟用中的主題或帳號，先到「<a href="#/manage">監測設定</a>」新增。</div>`
          : `<p class="small muted">範圍：主題 ${topics.map((t) => esc((t.type === "hashtag" ? "#" : "") + t.term)).join("、") || "無"}・帳號 ${accounts.map((a) => "@" + esc(a.handle)).join("、") || "無"}</p>`}
        <div class="form-row">
          <label class="field">時間範圍<select id="qHours">${QUICK_HOURS.map((x) => `<option value="${x}" ${x === h ? "selected" : ""}>近 ${x} 小時</option>`).join("")}</select></label>
          <label class="check" style="min-height:34px"><input type="checkbox" id="qVisit" ${S.quickVisit ? "checked" : ""}> 點進新貼文抓留言與瀏覽數（每篇多約 10 秒）</label>
          <button class="btn primary" id="qGo" ${st.running || nothing || !can("editor") ? "disabled" : ""}>立即爬文</button>
          ${can("editor") ? "" : `<span class="muted small">需要「編輯」以上權限</span>`}
        </div>
        <p style="margin:12px 0 0"><span class="status-dot ${st.running ? "run" : ""}"></span>${status}</p>
        ${quickRunning ? `<pre class="log" id="qLog" style="margin-top:10px">${esc(st.log.join("\n") || "（啟動中…）")}</pre>`
          : last ? `<p class="muted small" style="margin:6px 0 0">${lastLine} <button class="link small" id="qLastLog" type="button">看紀錄</button></p>` : ""}
      </section>
      ${latestPostsCard("t-recent", latest, (p) => fresh.has(p.code), `${fresh.size ? "；標「新」的是上次立即爬文新收的" : ""}；近 ${h} 小時內發布的有 ${fmt(d.posts.length)} 篇`)}`;
    bindTable("t-recent", latest, draw, (p) => (location.hash = `#/post/${p.code}`));
    $("#qHours").addEventListener("change", (e) => { S.quickHours = Number(e.target.value); viewQuick(el); });
    $("#qVisit").addEventListener("change", (e) => { S.quickVisit = e.target.checked; });
    $("#qGo").addEventListener("click", async () => {
      try { await api("/api/ws/quick-crawl", { body: { hours: S.quickHours, visit: S.quickVisit } }); toast("已開始立即爬文"); viewQuick(el); } catch (e) { toast(e.message, true); }
    });
    $("#qLastLog")?.addEventListener("click", async () => {
      const r = await api(`/api/ws/runs/${last.id}/log`);
      modal(`<h2>run #${last.id} 紀錄</h2><pre class="log" style="max-height:60vh">${esc(r.log || "（無紀錄）")}</pre>`);
    });
  };
  draw();

  // 有抓取在跑就每 2 秒更新紀錄；跑完自動重新整理列表（離開這頁就停）
  if (st.running) {
    S.timers.push(setInterval(async () => {
      const s = await api("/api/crawl/status").catch(() => null);
      if (!s) return;
      const log = $("#qLog");
      if (log) { log.textContent = s.log.join("\n"); log.scrollTop = log.scrollHeight; }
      if (!s.running && location.hash.startsWith("#/quick")) viewQuick(el);
    }, 2000));
  }
}

// ── 後台：抓取與排程 ─────────────────────────────────────────────────
async function viewCrawl(el) {
  const [st, runs, latest] = await Promise.all([api("/api/crawl/status"), api("/api/ws/runs"), fetchLatest()]);
  // 最近一次抓取開始後才第一次看到的貼文，就是這次新收的
  const lastStart = runs[0]?.started_at;
  const dur = (r) => (r.finished_at ? `${Math.max(1, Math.round((Date.parse(r.finished_at) - Date.parse(r.started_at)) / 60000))} 分` : "—");
  el.innerHTML = `
    <section class="card" data-block="crawl.run"><h2>立即抓取</h2>
      <p class="sub">會開一個 Chrome 視窗自動搜尋與捲動，所有工作區的主題與帳號一起抓。依主題與帳號數量，通常 3–15 分鐘。只想補最新幾小時的貼文，用「<a href="#/quick">立即爬文</a>」比較快。</p>
      <p><span class="status-dot ${st.running ? "run" : ""}"></span>${st.running ? `抓取中（run #${st.runId}，${twTime(st.startedAt)} 開始）` : "目前閒置"}
        ${st.next ? `<span class="muted small">・下一次排程：${twFull(st.next)}</span>` : `<span class="muted small">・排程未啟用</span>`}</p>
      <button class="btn primary" id="crawlNow" ${st.running || !can("editor") ? "disabled" : ""}>立即抓取</button>
      ${can("editor") ? "" : `<span class="muted small">需要「編輯」以上權限</span>`}
      <h3>即時紀錄</h3><pre class="log" id="liveLog">${esc(st.log.join("\n") || "（尚無）")}</pre>
    </section>
    ${latestPostsCard("t-latest", latest, (p) => !!lastStart && p.first_seen >= lastStart, lastStart ? "；標「新」的是最近一次抓取新收的" : "")}
    <section class="card" data-block="crawl.runs"><h2>抓取紀錄</h2>
      ${runs.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>#</th><th>開始</th><th>觸發</th><th>耗時</th><th>狀態</th><th class="num">主題收錄</th><th class="num">新貼文</th><th class="num">略過重複</th><th class="num">帳號</th><th class="num">點進</th><th class="num">留言</th><th></th></tr></thead><tbody>
        ${runs.map((r) => `<tr><td class="num">${r.id}</td><td class="nowrap">${twTime(r.started_at)}</td><td>${esc(triggerName(r))}</td><td>${dur(r)}</td>
          <td>${RUN_ST[r.status] || r.status}${r.logged_out ? ' <span class="badge">登入牆</span>' : ""}${r.error ? `<div class="flag">${esc(r.error)}</div>` : ""}</td>
          <td class="num">${fmt(r.posts_found)}</td><td class="num">${fmt(r.posts_new)}</td><td class="num">${fmt(r.posts_skipped)}</td><td class="num">${fmt(r.profiles_seen)}</td><td class="num">${fmt(r.posts_visited)}</td><td class="num">${fmt(r.comments_found)}</td>
          <td><button class="btn sm" data-log="${r.id}">紀錄</button></td></tr>`).join("")}
      </tbody></table></div>` : empty("還沒有抓取紀錄")}
    </section>
    <div class="note">排程時間在「系統設定」調整（僅系統擁有者）。排程只在伺服器開著時執行，電腦關機或伺服器沒開那一次就會略過。</div>`;

  bindTable("t-latest", latest, () => viewCrawl(el), (p) => (location.hash = `#/post/${p.code}`));
  $("#crawlNow")?.addEventListener("click", async () => {
    try { await api("/api/ws/crawl", { body: {} }); toast("已開始抓取"); viewCrawl(el); } catch (e) { toast(e.message, true); }
  });
  $$("[data-log]").forEach((b) => b.addEventListener("click", async () => {
    const r = await api(`/api/ws/runs/${b.dataset.log}/log`);
    modal(`<h2>run #${b.dataset.log} 紀錄</h2><pre class="log" style="max-height:60vh">${esc(r.log || "（無紀錄）")}</pre>`);
  }));
  if (st.running) {
    S.timers.push(setInterval(async () => {
      const s = await api("/api/crawl/status").catch(() => null);
      if (!s) return;
      const log = $("#liveLog");
      if (log) { log.textContent = s.log.join("\n"); log.scrollTop = log.scrollHeight; }
      if (!s.running) { clearTimers(); viewCrawl(el); }
    }, 2000));
  }
}

// ── 後台：成員 ───────────────────────────────────────────────────────
async function viewMembers(el) {
  const [members, roles] = await Promise.all([api("/api/ws/members"), api("/api/ws/roles")]);
  const defaultRole = roles.find((r) => r.builtin === "viewer")?.id;
  const roleOptions = (selected) => roles.map((r) => `<option value="${r.id}" ${r.id === selected ? "selected" : ""}>${esc(r.name)}（${LEVEL_LABEL[r.level]}）</option>`).join("");
  el.innerHTML = `
    <section class="card"><h2>工作區名稱</h2>
      <form class="form-row" id="wsForm"><input name="name" type="text" value="${esc(S.ws.name)}" required><button class="btn">儲存</button></form></section>
    <section class="card"><h2>成員（${members.length}）</h2>
      <p class="sub">每位成員套用一個角色：角色決定看得到哪些選單與區塊，以及操作層級（檢視／編輯／管理）。${S.me.user.is_owner ? `角色內容到「<a href="#/roles">角色權限</a>」調整。` : "角色內容由系統擁有者設定。"}</p>
      <div class="table-wrap"><table class="data"><thead><tr><th>帳號</th><th>名稱</th><th>角色</th><th></th></tr></thead><tbody>
        ${members.map((m) => `<tr><td>${esc(m.username)}${m.is_owner ? ' <span class="badge own">系統擁有者</span>' : ""}</td><td>${esc(m.display_name)}</td>
          <td>${m.is_owner ? `<span class="muted small">不受角色限制，看得到全部</span>` : `<select data-role="${m.id}" ${m.id === S.me.user.id ? "disabled" : ""}>${roleOptions(m.role_id)}</select>`}</td>
          <td>${m.id === S.me.user.id ? "" : `<button class="btn sm danger" data-rm="${m.id}">移出</button>`}</td></tr>`).join("")}
      </tbody></table></div>
      <h3>新增成員（開帳號）</h3><p class="sub">輸入已存在的帳號會直接加入並套用角色；新帳號要設定初始密碼（至少 8 字元），請成員登入後到「我的帳號」修改。</p>
      <form class="form-row" id="memForm">
        <label class="field">登入帳號<input name="username" type="text" required></label>
        <label class="field">顯示名稱<input name="display_name" type="text"></label>
        <label class="field">初始密碼<input name="password" type="password" autocomplete="new-password"></label>
        <label class="field">角色<select name="role_id">${roleOptions(defaultRole)}</select></label>
        <button class="btn primary">加入</button>
      </form></section>`;
  const act = async (fn, msg) => { try { await fn(); if (msg) toast(msg); await boot(true); } catch (e) { toast(e.message, true); } };
  $("#wsForm").addEventListener("submit", (e) => { e.preventDefault(); act(() => api("/api/ws/", { method: "PATCH", body: { name: e.target.name.value } }), "已更新名稱"); });
  $("#memForm").addEventListener("submit", (e) => { e.preventDefault(); act(() => api("/api/ws/members", { body: Object.fromEntries(new FormData(e.target)) }), "已加入成員"); });
  $$("[data-role]").forEach((s) => s.addEventListener("change", () => act(() => api(`/api/ws/members/${s.dataset.role}`, { method: "PATCH", body: { role_id: Number(s.value) } }), "已更新角色")));
  $$("[data-rm]").forEach((b) => b.addEventListener("click", () => confirm("確定把這位成員移出工作區？") && act(() => api(`/api/ws/members/${b.dataset.rm}`, { method: "DELETE" }), "已移出")));
}

// ── 後台：角色權限（擁有者）──────────────────────────────────────────
const LEVEL_LABEL = { admin: "管理", editor: "編輯", viewer: "檢視" };
const LEVEL_DESC = {
  viewer: "只能看，不能改設定、不能抓取",
  editor: "可以管理主題與帳號、立即抓取、立即爬文",
  admin: "編輯的權限，再加上管理成員與工作區名稱",
};

async function viewRoles(el, param) {
  const { roles, registry: reg } = await api("/api/system/roles");
  const menuLabel = Object.fromEntries(reg.menus.map((m) => [m.key, m.label]));
  const editing = param === "new"
    ? { id: null, name: "", level: "viewer", builtin: null, menus: reg.menus.filter((m) => m.group === "前台").map((m) => m.key), hidden_blocks: [] }
    : roles.find((r) => String(r.id) === param) || null;

  const permsHtml = (r) => ["前台", "後台"].map((g) => `
    <div class="perm-group" data-group="${g}">
      <div class="perm-head"><strong>${g === "前台" ? "前台・分析" : "後台・管理"}</strong>
        <button type="button" class="link small" data-all="${g}">全選</button><button type="button" class="link small" data-none="${g}">全不選</button></div>
      ${reg.menus.filter((m) => m.group === g).map((m) => {
        const on = r.menus.includes(m.key);
        return `<div class="perm-menu">
          <label class="check"><input type="checkbox" name="menu" value="${m.key}" ${on ? "checked" : ""}> <strong>${esc(m.label)}</strong>${m.note ? ` <span class="muted small">（${esc(m.note)}）</span>` : ""}</label>
          ${m.blocks.length ? `<div class="perm-blocks ${on ? "" : "off"}" data-for="${m.key}">${m.blocks.map(([k, label]) =>
            `<label class="check small"><input type="checkbox" name="block" value="${k}" ${r.hidden_blocks.includes(k) ? "" : "checked"}> ${esc(label)}</label>`).join("")}</div>` : ""}
        </div>`;
      }).join("")}
    </div>`).join("");

  el.innerHTML = `
    <section class="card"><h2>角色列表</h2>
      <p class="sub">角色決定：看得到哪些選單、選單裡哪些區塊，以及操作層級。到「<a href="#/members">成員</a>」開帳號並指派角色。系統擁有者不受角色限制。</p>
      <div class="table-wrap"><table class="data"><thead><tr><th>角色</th><th>操作層級</th><th>看得到的選單</th><th class="num">隱藏區塊</th><th class="num">成員</th><th></th></tr></thead><tbody>
        ${roles.map((r) => `<tr><td class="nowrap"><strong>${esc(r.name)}</strong>${r.builtin ? ' <span class="badge">預設</span>' : ""}</td>
          <td class="nowrap">${LEVEL_LABEL[r.level]}</td>
          <td><div class="perm-summary">${r.menus.map((k) => esc(menuLabel[k] || k)).join("、") || "—"}</div></td>
          <td class="num">${r.hidden_blocks.length}</td><td class="num">${r.members}</td>
          <td class="nowrap"><a class="btn sm" href="#/roles/${r.id}">編輯</a> ${r.builtin ? "" : `<button class="btn sm danger" data-del="${r.id}">刪除</button>`}</td></tr>`).join("")}
      </tbody></table></div>
      <p style="margin-top:12px"><a class="btn primary" href="#/roles/new">新增角色</a></p>
    </section>
    ${editing ? `<section class="card" id="roleEditor"><h2>${editing.id ? `編輯角色：${esc(editing.name)}` : "新增角色"}</h2>
      <form id="roleForm">
        <div class="form-row">
          <label class="field">角色名稱<input name="name" type="text" maxlength="30" value="${esc(editing.name)}" required></label>
          <label class="field">操作層級<select name="level" ${editing.builtin === "admin" ? "disabled" : ""}>${["viewer", "editor", "admin"].map((l) => `<option value="${l}" ${editing.level === l ? "selected" : ""}>${LEVEL_LABEL[l]}</option>`).join("")}</select></label>
        </div>
        <p class="sub" id="levelDesc" style="margin-top:8px">${LEVEL_DESC[editing.level]}${editing.builtin === "admin" ? "（預設的管理員角色固定為管理層級）" : ""}</p>
        <h3>看得到的選單與區塊</h3>
        <p class="sub">勾選的選單才會出現在這個角色的側邊欄；選單底下的區塊取消勾選就會隱藏。「下載 CSV」「匯出 Excel」隱藏後，伺服器也會拒絕下載。</p>
        ${permsHtml(editing)}
        <div class="perm-group"><div class="perm-head"><strong>其他</strong></div>
          <div class="perm-blocks" style="margin-left:0">${reg.global.map(([k, label]) =>
            `<label class="check small"><input type="checkbox" name="block" value="${k}" ${editing.hidden_blocks.includes(k) ? "" : "checked"}> ${esc(label)}</label>`).join("")}</div></div>
        <p><button class="btn primary">儲存</button> <a class="btn" href="#/roles">取消</a></p>
      </form></section>` : ""}`;

  $$("[data-del]", el).forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("確定刪除這個角色？")) return;
    try { await api(`/api/system/roles/${b.dataset.del}`, { method: "DELETE" }); toast("已刪除角色"); viewRoles(el, ""); } catch (e) { toast(e.message, true); }
  }));

  const form = $("#roleForm");
  if (!form) return;
  $("#roleEditor").scrollIntoView({ block: "start" });
  form.elements.level.addEventListener("change", (e) => { $("#levelDesc").textContent = LEVEL_DESC[e.target.value]; });
  const syncBlocks = () => $$('input[name="menu"]', form).forEach((cb) => $(`.perm-blocks[data-for="${cb.value}"]`, form)?.classList.toggle("off", !cb.checked));
  $$('input[name="menu"]', form).forEach((cb) => cb.addEventListener("change", syncBlocks));
  $$("[data-all], [data-none]", form).forEach((b) => b.addEventListener("click", () => {
    const g = b.dataset.all || b.dataset.none;
    $$(`.perm-group[data-group="${g}"] input[type=checkbox]`, form).forEach((cb) => (cb.checked = !!b.dataset.all));
    syncBlocks();
  }));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = {
      name: form.elements.namedItem("name").value.trim(),
      level: editing.builtin === "admin" ? "admin" : form.elements.level.value,
      menus: $$('input[name="menu"]:checked', form).map((cb) => cb.value),
      hidden_blocks: $$('input[name="block"]', form).filter((cb) => !cb.checked).map((cb) => cb.value),
    };
    try {
      await api(editing.id ? `/api/system/roles/${editing.id}` : "/api/system/roles", { method: editing.id ? "PUT" : "POST", body });
      toast("角色已儲存");
      location.hash = "#/roles";
    } catch (err) { toast(err.message, true); }
  });
}

// ── 後台：系統設定（擁有者）──────────────────────────────────────────
async function viewSystem(el) {
  const [s, wss, users, pub] = await Promise.all([api("/api/system/settings"), api("/api/system/workspaces"), api("/api/system/users"), api("/api/public-url").catch(() => ({ url: null, updated: null }))]);
  el.innerHTML = `
    <section class="card"><h2>目前的公開網址</h2>
      <p class="sub">Cloudflare 臨時網址，通道重開（例如電腦重開機）就會換一組，看門狗會自動更新這裡。注意：學校 DNS 不解析這個網域，校內開不起來，請用校外網路或手機行動網路；在這台電腦請用 http://127.0.0.1:3900。</p>
      ${pub.url ? `<p><a href="${esc(pub.url)}" target="_blank" rel="noopener">${esc(pub.url)}</a> <button class="btn sm" id="copyUrl" type="button">複製</button></p>
        <p class="muted small">更新時間：${esc(pub.updated || "—")}</p>` : empty("還沒有公開網址：看門狗沒在跑，或通道還沒建立")}
    </section>
    <section class="card"><h2>抓取與排程</h2>
      <form id="setForm">
        <div class="form-row">
          <label class="check"><input type="checkbox" name="schedule_enabled" ${s.schedule_enabled === "1" ? "checked" : ""}> 啟用每日排程</label>
          <label class="field">排程時間（多個用逗號）<input name="schedule_times" type="text" value="${esc(s.schedule_times)}" placeholder="10:30, 18:00"></label>
          <label class="field">追蹤近幾天的貼文<input name="track_days" type="number" min="1" max="100" value="${esc(s.track_days)}" style="width:90px"></label>
          <label class="field">每次最多點進幾篇<input name="max_post_visits" type="number" min="1" max="100" value="${esc(s.max_post_visits)}" style="width:90px"></label>
          <label class="field">個人頁捲動次數<input name="profile_scrolls" type="number" min="1" max="100" value="${esc(s.profile_scrolls)}" style="width:90px"></label>
          <label class="field">瀏覽器<select name="browser_channel"><option value="chrome" ${s.browser_channel === "chrome" ? "selected" : ""}>Chrome</option><option value="msedge" ${s.browser_channel === "msedge" ? "selected" : ""}>Edge</option></select></label>
          <label class="check"><input type="checkbox" name="headless" ${s.headless === "1" ? "checked" : ""}> 背景執行（不開視窗，較容易被擋）</label>
        </div>
        <p class="sub" style="margin-top:12px">收錄規則：已抓過的貼文不重抓；主題搜尋的新貼文，今天有就只收今天的，今天沒有才收近 N 天（N＝各主題的「天數」）。</p>
        <label class="check"><input type="checkbox" name="revisit_old" ${s.revisit_old === "1" ? "checked" : ""}> 重新追蹤已抓過的貼文（每次回頭更新讚數與留言，才畫得出「互動成長」與「較上次」；會多花抓取時間）</label>
        <h3>分析字典</h3><p class="sub">用逗號或換行分隔。改完按「儲存」，再按「重新分析全部」套用到舊資料。</p>
        <div class="grid2">
          <label class="field">負面輿情關鍵字（出現就標 ⚠）<textarea name="neg_keywords">${esc(s.neg_keywords)}</textarea></label>
          <label class="field">正面詞（前面接「不／沒」會反過來算負面）<textarea name="pos_words">${esc(s.pos_words)}</textarea></label>
        </div>
        <label class="field" style="margin-top:12px">負面詞<textarea name="neg_words">${esc(s.neg_words)}</textarea></label>
        <p style="margin-top:12px"><button class="btn primary">儲存</button> <button class="btn" type="button" id="reanalyze">重新分析全部</button></p>
      </form></section>
    <section class="card"><h2>工作區</h2>
      <div class="table-wrap"><table class="data"><thead><tr><th>#</th><th>名稱</th><th class="num">成員</th><th class="num">主題</th><th class="num">帳號</th><th></th></tr></thead><tbody>
        ${wss.map((w) => `<tr><td class="num">${w.id}</td><td>${esc(w.name)}</td><td class="num">${w.members}</td><td class="num">${w.topics}</td><td class="num">${w.accounts}</td><td><button class="btn sm danger" data-wsdel="${w.id}">刪除</button></td></tr>`).join("")}
      </tbody></table></div>
      <form class="form-row" id="wsNew" style="margin-top:12px"><input name="name" type="text" placeholder="新工作區名稱" required><button class="btn">建立工作區</button></form></section>
    <section class="card"><h2>所有使用者</h2>
      <div class="table-wrap"><table class="data"><thead><tr><th>帳號</th><th>名稱</th><th>所屬工作區</th><th></th></tr></thead><tbody>
        ${users.map((u) => `<tr><td>${esc(u.username)}${u.is_owner ? ' <span class="badge own">擁有者</span>' : ""}</td><td>${esc(u.display_name)}</td><td class="small">${esc(u.workspaces || "—")}</td>
          <td class="nowrap">${u.id === S.me.user.id ? "" : `<button class="btn sm" data-pw="${u.id}">重設密碼</button> <button class="btn sm danger" data-udel="${u.id}">刪除</button>`}</td></tr>`).join("")}
      </tbody></table></div></section>`;

  $("#setForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = Object.fromEntries(new FormData(f));
    body.schedule_enabled = f.schedule_enabled.checked ? "1" : "0";
    body.headless = f.headless.checked ? "1" : "0";
    body.revisit_old = f.revisit_old.checked ? "1" : "0";
    try { await api("/api/system/settings", { method: "PUT", body }); toast("已儲存"); } catch (err) { toast(err.message, true); }
  });
  $("#copyUrl")?.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(pub.url); toast("已複製公開網址"); } catch { toast("複製失敗，請手動選取", true); }
  });
  $("#reanalyze").addEventListener("click", async () => {
    try { const r = await api("/api/system/reanalyze", { body: {} }); toast(`已重新分析 ${r.posts} 篇貼文、${r.comments} 則留言`); } catch (err) { toast(err.message, true); }
  });
  const act = async (fn, msg) => { try { await fn(); toast(msg); await boot(true); } catch (err) { toast(err.message, true); } };
  $("#wsNew").addEventListener("submit", (e) => { e.preventDefault(); act(() => api("/api/system/workspaces", { body: { name: e.target.name.value } }), "已建立工作區"); });
  $$("[data-wsdel]").forEach((b) => b.addEventListener("click", () => confirm("刪除工作區會一併刪除它的主題、帳號與成員關係（貼文資料保留）。確定？") && act(() => api(`/api/system/workspaces/${b.dataset.wsdel}`, { method: "DELETE" }), "已刪除")));
  $$("[data-pw]").forEach((b) => b.addEventListener("click", () => {
    const m = modal(`<h2>重設密碼</h2><form id="pwForm" class="form-row"><input name="password" type="password" placeholder="新密碼（至少 8 字元）" autocomplete="new-password" required><button class="btn primary">設定</button></form>`);
    $("#pwForm", m).addEventListener("submit", (e) => { e.preventDefault(); act(() => api(`/api/system/users/${b.dataset.pw}/password`, { body: { password: e.target.password.value } }), "已重設密碼").then(() => m.remove()); });
  }));
  $$("[data-udel]").forEach((b) => b.addEventListener("click", () => confirm("確定刪除這個使用者？") && act(() => api(`/api/system/users/${b.dataset.udel}`, { method: "DELETE" }), "已刪除")));
}

// ── 我的帳號 ─────────────────────────────────────────────────────────
async function viewMe(el) {
  el.innerHTML = `<section class="card"><h2>${esc(S.me.user.display_name)}（${esc(S.me.user.username)}）</h2>
    <p class="sub">${S.workspaces.map((w) => `${esc(w.name)}：${ROLE_NAME[w.role]}`).join("、")}</p>
    <h3>修改密碼</h3>
    <form class="form-row" id="meForm">
      <label class="field">目前密碼<input name="current" type="password" autocomplete="current-password" required></label>
      <label class="field">新密碼<input name="next" type="password" autocomplete="new-password" required></label>
      <button class="btn primary">更新密碼</button>
    </form></section>`;
  $("#meForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try { await api("/api/me/password", { body: Object.fromEntries(new FormData(e.target)) }); e.target.reset(); toast("密碼已更新"); } catch (err) { toast(err.message, true); }
  });
}

// ── 登入／首次設定 ───────────────────────────────────────────────────
// 登入成功後把帳密交給瀏覽器的密碼管理器（Chrome／Edge 會跳出「儲存密碼」）；
// 下次開頁面先用已儲存的帳密靜默登入。帳密只存在瀏覽器裡，不寫進 localStorage。
const canUseCredentials = () => "PasswordCredential" in window && !!navigator.credentials;

async function trySilentLogin() {
  if (S.silentTried || !canUseCredentials()) return false;
  S.silentTried = true; // 每次載入只試一次，避免登入失敗時來回重試
  try {
    const cred = await navigator.credentials.get({ password: true, mediation: "silent" });
    if (!cred?.password) return false;
    const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: cred.id, password: cred.password, remember: true }) });
    return res.ok;
  } catch {
    return false;
  }
}

async function showAuth({ silent = true } = {}) {
  S.me = null;
  destroyCharts();
  clearTimers();
  const { needsSetup } = await fetch("/api/setup-status").then((r) => r.json()).catch(() => ({ needsSetup: false }));
  if (!needsSetup && silent && (await trySilentLogin())) return boot();
  $("#app").hidden = true;
  const box = $("#auth");
  box.hidden = false;
  box.innerHTML = `<div class="auth-wrap"><form class="auth-card" id="authForm">
    <h1>${needsSetup ? "建立管理員帳號" : "登入"}</h1>
    <p class="sub">${needsSetup ? "第一次使用，先建立系統擁有者帳號與第一個工作區。" : "Threads 監測系統"}</p>
    <label class="field">帳號<input name="username" type="text" autocomplete="username" required></label>
    ${needsSetup ? `<label class="field">顯示名稱<input name="display_name" type="text"></label>` : ""}
    <label class="field">密碼${needsSetup ? "（至少 8 字元）" : ""}<input name="password" type="password" autocomplete="${needsSetup ? "new-password" : "current-password"}" required></label>
    ${needsSetup ? `<label class="field">第一個工作區名稱<input name="workspace_name" type="text" value="世新大學輿情"></label>` : ""}
    ${needsSetup ? "" : `<label class="check small" style="margin-top:12px"><input type="checkbox" name="remember" checked> 記住我（30 天內免重新登入）</label>`}
    <button class="btn primary">${needsSetup ? "建立並登入" : "登入"}</button>
    <div class="error" id="authErr"></div>
  </form></div>`;
  $("#authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = Object.fromEntries(new FormData(f));
    body.remember = needsSetup ? true : f.remember.checked;
    const res = await fetch(needsSetup ? "/api/setup" : "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { $("#authErr").textContent = data.error || "失敗"; return; }
    if (canUseCredentials()) {
      try { await navigator.credentials.store(new PasswordCredential({ id: body.username, password: body.password, name: body.display_name || body.username })); } catch {}
    }
    box.hidden = true;
    boot();
  });
}

async function boot(keepRoute = false) {
  const res = await fetch("/api/me");
  if (res.status === 401) return showAuth();
  const me = await res.json();
  S.me = me;
  S.workspaces = me.workspaces;
  if (!S.workspaces.length) {
    $("#app").hidden = true;
    $("#auth").hidden = false;
    $("#auth").innerHTML = `<div class="auth-wrap"><div class="auth-card"><h1>尚未加入工作區</h1><p class="sub">請工作區管理員把你加入後再登入。</p><button class="btn" id="lo">登出</button></div></div>`;
    $("#lo").onclick = logout;
    return;
  }
  let wsId = S.ws?.id;
  if (!wsId) { try { wsId = Number(localStorage.getItem("tm_ws")); } catch {} }
  S.ws = S.workspaces.find((w) => w.id === wsId) || S.workspaces[0];
  $("#auth").hidden = true;
  $("#app").hidden = false;
  $("#meName").textContent = `${me.user.display_name}・${S.ws.role_name || ROLE_NAME[S.ws.role]}`;
  $("#wsSelect").innerHTML = S.workspaces.map((w) => `<option value="${w.id}" ${w.id === S.ws.id ? "selected" : ""}>${esc(w.name)}</option>`).join("");
  $("#daysSelect").value = String(S.days);
  await loadWorkspaceLists();
  if (!keepRoute || !location.hash) route(); else route();
}

async function logout() {
  await fetch("/api/logout", { method: "POST" });
  // 登出後瀏覽器不要馬上用儲存的密碼自動登入回來；下次手動登入後會恢復
  if (navigator.credentials?.preventSilentAccess) await navigator.credentials.preventSilentAccess().catch(() => {});
  S.ws = null;
  showAuth({ silent: false });
}

async function crawlBadge() {
  if (!S.me) return;
  const s = await fetch("/api/crawl/status").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  $("#crawlBadge").innerHTML = s?.running ? `<span class="status-dot run"></span>抓取中…` : "";
}

$("#wsSelect").addEventListener("change", async (e) => {
  S.ws = S.workspaces.find((w) => w.id === Number(e.target.value));
  try { localStorage.setItem("tm_ws", String(S.ws.id)); } catch {}
  S.source = "all";
  S.compareSel = null;
  S.postSel = null;
  S.cmpA = S.cmpB = null;
  $("#meName").textContent = `${S.me.user.display_name}・${S.ws.role_name || ROLE_NAME[S.ws.role]}`;
  await loadWorkspaceLists();
  route();
});
$("#daysSelect").addEventListener("change", (e) => {
  S.days = Number(e.target.value);
  try { localStorage.setItem("tm_days", String(S.days)); } catch {}
  route();
});
$("#logoutBtn").addEventListener("click", logout);
window.addEventListener("hashchange", route);
setInterval(crawlBadge, 10000);
boot();
