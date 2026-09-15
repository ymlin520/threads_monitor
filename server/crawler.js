// ── 爬蟲：主題搜尋 ＋ 帳號個人頁 → 逐篇進貼文頁抓瀏覽數與留言 ─────────────
// 沿用 shihhsin-threads-watch 的做法：開可見的 Chrome、DOM 直讀、不登入。
// 若 data/auth_state.json 存在（Playwright storageState），會帶登入狀態抓，數量不受登入牆限制。
// 所有工作區的主題與帳號一起抓，同一個關鍵字／帳號只抓一次。
//
// 收錄規則（系統設定 revisit_old 關閉時，預設）：
//   1. 已經抓過的貼文不再重抓、不再點進去（只補上主題關聯）
//   2. 主題搜尋的新貼文：今天有就只收今天的；今天沒有才收近 max_days 天的
//
// 立即爬文（startCrawl 帶 hours）：只抓發起的工作區，只收近 hours 小時發布、還沒抓過的貼文，
// 不套用「今天優先」、不回頭更新舊貼文，也只點進這次新抓到的貼文。
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { db, DATA_DIR, getSettings, now } from "./db.js";
import { analyze, dictFrom } from "./analyze.js";

const BASE = "https://www.threads.com";
const AUTH_FILE = path.join(DATA_DIR, "auth_state.json");
const DAY = 86400000;
const HOUR = 3600000;
const SEARCH_SCROLLS = 12;
const POST_SCROLLS = 3;
// 訪客模式每個 session 搜尋只給 5–12 篇、而且每種搜尋網址給的不一樣；
// 換幾種 serp_type、各開一個新的訪客 session 再合併，近幾小時的貼文才抓得到（實測單一網址常常 0 篇）
const GUEST_SERPS = { keyword: ["default", "", "tags"], hashtag: ["tags"] };

// newCodes：這次新收的貼文，結束時寫進 runs.new_codes
export const state = { running: false, runId: null, trigger: null, hours: null, startedAt: null, log: [], newCodes: new Set() };

function log(msg) {
  const t = new Date().toLocaleTimeString("zh-TW", { hour12: false, timeZone: "Asia/Taipei" });
  state.log.push(`[${t}] ${msg}`);
  if (state.log.length > 500) state.log.shift();
  console.log("[crawl]", msg);
}

const jitter = (a, b) => a + Math.random() * (b - a);
const twDate = (ms) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
const postExists = (code) => !!db.prepare("SELECT 1 FROM posts WHERE code = ?").get(code);

// 在瀏覽器裡執行：以「只含一個時間戳的最大祖先」當貼文容器，順便讀互動數與媒體類型
function scrapeBoxes() {
  const parseNum = (s) => {
    const m = String(s || "").trim().replace(/,/g, "").match(/^([\d.]+)\s*(萬|万|千|K|k|M)?/);
    if (!m) return 0;
    const mult = { 萬: 1e4, 万: 1e4, 千: 1e3, K: 1e3, k: 1e3, M: 1e6 }[m[2]] || 1;
    return Math.round(parseFloat(m[1]) * mult);
  };
  const labelKey = { 讚: "likes", 留言: "replies", 轉發: "reposts", 分享: "shares", Like: "likes", Reply: "replies", Repost: "reposts", Share: "shares" };

  // 貼文頁在留言之後會接「相關串文」，那一段不是這篇的留言
  let marker = null;
  for (const el of document.querySelectorAll("span, div, h1, h2, h3")) {
    if (el.childElementCount === 0 && (el.textContent || "").trim() === "相關串文") { marker = el; break; }
  }

  const out = [];
  const seen = new Set();
  for (const link of document.querySelectorAll('a[href*="/post/"]')) {
    const m = (link.getAttribute("href") || "").match(/\/@([^/?#]+)\/post\/([A-Za-z0-9_-]+)/);
    if (!m || seen.has(m[2])) continue;

    let box = null;
    let timeEl = null;
    let node = link;
    for (let i = 0; i < 40 && node; i++) {
      const times = node.querySelectorAll ? node.querySelectorAll("time[datetime]") : [];
      if (times.length === 1) { box = node; timeEl = times[0]; }
      else if (times.length > 1) break;
      node = node.parentElement;
    }
    if (!box) continue;
    seen.add(m[2]);

    const counts = { likes: 0, replies: 0, reposts: 0, shares: 0 };
    for (const svg of box.querySelectorAll("svg[aria-label]")) {
      const key = labelKey[svg.getAttribute("aria-label")];
      if (!key) continue;
      const btn = svg.closest('[role="button"]');
      counts[key] = parseNum(btn ? btn.innerText : "");
    }

    // 大頭貼的 alt 是「xxx的大頭貼照」，其他圖片視為貼文附圖
    const hasVideo = !!box.querySelector("video");
    const hasImage = [...box.querySelectorAll("img")].some((img) => !/大頭貼照|profile picture/i.test(img.getAttribute("alt") || ""));

    out.push({
      code: m[2],
      handle: m[1],
      posted_at: timeEl.getAttribute("datetime") || "",
      raw: box.innerText || "",
      url: "https://www.threads.com/@" + m[1] + "/post/" + m[2],
      counts,
      media: hasVideo ? "video" : hasImage ? "image" : "text",
      authorLiked: !!box.querySelector('svg[aria-label="原作者說讚"]'),
      afterRelated: marker ? !!(marker.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING) : false,
    });
  }
  return out;
}

const REL_TIME = /^\d+\s*(秒|分鐘|小時|天|週|個月|年)$/;
const ABS_DATE = /^\d{4}-\d{1,2}-\d{1,2}$/;
const NUM_LINE = /^[\d,.]+\s*(萬|万|千|K|M)?$/;
const UI_LINE = /^(翻譯|查看翻譯|Translate|讚|留言|轉發|分享|更多|作者|已驗證|置頂)$/;
const isTime = (l) => REL_TIME.test(l) || ABS_DATE.test(l);

// innerText → { topic, content }。主題標籤只在「帳號 / 主題 / 時間」這個排列時才成立
function splitRaw(raw, handle) {
  const lines = String(raw || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const i = lines.indexOf(handle);
  let topic = "";
  if (i >= 0 && lines[i + 1] && !isTime(lines[i + 1]) && lines[i + 2] && isTime(lines[i + 2])) topic = lines[i + 1];

  const keep = [];
  let topicSkipped = false;
  for (const l of lines) {
    if (l === handle) continue;
    if (topic && !topicSkipped && l === topic) { topicSkipped = true; continue; }
    if (isTime(l) || UI_LINE.test(l) || NUM_LINE.test(l) || /次瀏覽$/.test(l)) continue;
    keep.push(l);
  }
  return { topic, content: keep.join("\n").trim() };
}

function parseCount(s) {
  const m = String(s || "").replace(/,/g, "").match(/([\d.]+)\s*(萬|万|千|K|M)?/);
  if (!m) return null;
  return Math.round(parseFloat(m[1]) * ({ 萬: 1e4, 万: 1e4, 千: 1e3, K: 1e3, M: 1e6 }[m[2]] || 1));
}

function parseViews(text) {
  const m = String(text || "").match(/([\d.,]+\s*(?:萬|万)?)\s*次瀏覽/);
  return m ? parseCount(m[1]) : null;
}

// og:description 例：「573.6 萬位粉絲 • 159 則串文 • 簡介…。查看 @zuck 參與的最新對話。」
function parseProfileMeta(og, title) {
  const fm = og.match(/([\d.,]+\s*(?:萬|万|千|K|M)?)\s*位粉絲/) || og.match(/([\d.,]+\s*[KM]?)\s*Followers/i);
  const parts = og.split("•").map((s) => s.trim());
  const bio = (parts[2] || "").replace(/。?\s*查看 @.*$/, "").replace(/\s*See the latest.*$/i, "").trim();
  const nm = String(title || "").match(/^(.*?)\s*[（(]@/);
  return { followers: fm ? parseCount(fm[1]) : null, bio: bio || null, name: nm ? nm[1].trim() : null };
}

// ── DB 寫入 ───────────────────────────────────────────────────────────
function upsertPost(p, dict) {
  const ts = now();
  const exists = postExists(p.code);
  if (exists) {
    db.prepare(`UPDATE posts SET author = ?, topic_tag = COALESCE(NULLIF(?, ''), topic_tag),
        content = CASE WHEN length(?) > length(COALESCE(content, '')) THEN ? ELSE content END,
        media_type = CASE WHEN ? != 'text' THEN ? ELSE COALESCE(media_type, 'text') END,
        url = ?, last_seen = ?, likes = ?, replies = ?, reposts = ?, shares = ? WHERE code = ?`)
      .run(p.author, p.topic, p.content, p.content, p.media, p.media, p.url, ts,
        p.counts.likes, p.counts.replies, p.counts.reposts, p.counts.shares, p.code);
  } else {
    db.prepare(`INSERT INTO posts (code, author, topic_tag, content, media_type, posted_at, url, first_seen, last_seen,
        likes, replies, reposts, shares) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(p.code, p.author, p.topic, p.content, p.media, p.posted_at, p.url, ts, ts,
        p.counts.likes, p.counts.replies, p.counts.reposts, p.counts.shares);
  }
  const cur = db.prepare("SELECT content FROM posts WHERE code = ?").get(p.code);
  const a = analyze(cur.content, dict);
  db.prepare("UPDATE posts SET sentiment = ?, sentiment_score = ?, neg_hits = ? WHERE code = ?")
    .run(a.sentiment, a.score, JSON.stringify(a.negHits), p.code);
  return !exists;
}

const boxToPost = (b) => {
  const { topic, content } = splitRaw(b.raw, b.handle);
  return { code: b.code, author: b.handle, topic, content, media: b.media, posted_at: b.posted_at, url: b.url, counts: b.counts };
};

// 只把貼文掛到「發布時間落在該主題天數內」的主題上
function linkTopics(group, code, postedMs) {
  for (const tp of group.topics) {
    if (postedMs >= Date.now() - tp.max_days * DAY) db.prepare("INSERT OR IGNORE INTO post_topics (post_code, topic_id) VALUES (?, ?)").run(code, tp.id);
  }
}

function upsertComment(postCode, b, dict) {
  const { content } = splitRaw(b.raw, b.handle);
  const a = analyze(content, dict);
  const ts = now();
  const exists = db.prepare("SELECT 1 FROM comments WHERE code = ?").get(b.code);
  if (exists) {
    db.prepare(`UPDATE comments SET content = ?, likes = ?, replies = ?, author_liked = ?, sentiment = ?,
        sentiment_score = ?, neg_hits = ?, last_seen = ? WHERE code = ?`)
      .run(content, b.counts.likes, b.counts.replies, b.authorLiked ? 1 : 0, a.sentiment, a.score, JSON.stringify(a.negHits), ts, b.code);
  } else {
    db.prepare(`INSERT INTO comments (code, post_code, author, content, posted_at, likes, replies, author_liked,
        sentiment, sentiment_score, neg_hits, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(b.code, postCode, b.handle, content, b.posted_at, b.counts.likes, b.counts.replies, b.authorLiked ? 1 : 0,
        a.sentiment, a.score, JSON.stringify(a.negHits), ts, ts);
  }
  return !exists;
}

function insertSnapshot(code, runId, c, views = null) {
  db.prepare(`INSERT INTO post_metrics (post_code, run_id, captured_at, likes, replies, reposts, shares, views)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(code, runId, now(), c.likes, c.replies, c.reposts, c.shares, views);
}

function finishRun(runId, status, stats = {}, error = null) {
  db.prepare(`UPDATE runs SET finished_at = ?, status = ?, logged_out = ?, posts_found = ?, posts_new = ?, posts_skipped = ?,
      posts_visited = ?, profiles_seen = ?, comments_found = ?, comments_new = ?, error = ?, log = ?, new_codes = ? WHERE id = ?`)
    .run(now(), status, stats.logged_out || 0, stats.posts_found || 0, stats.posts_new || 0, stats.posts_skipped || 0,
      stats.posts_visited || 0, stats.profiles_seen || 0, stats.comments_found || 0, stats.comments_new || 0, error, state.log.join("\n"),
      JSON.stringify([...state.newCodes]), runId);
}

// ── 抓取步驟 ─────────────────────────────────────────────────────────
async function scrollCollect(page, scrolls, stopAtWall) {
  const boxes = new Map();
  let loggedOut = false;
  for (let s = 0; s <= scrolls; s++) {
    for (const b of await page.evaluate(scrapeBoxes).catch(() => [])) boxes.set(b.code, b);
    if (s === scrolls) break;
    loggedOut = await page.evaluate(() => /登入以取得更多|登入即可查看更多/.test(document.body.innerText || "")).catch(() => false);
    if (stopAtWall && loggedOut && s >= 2) break;
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2)).catch(() => {});
    await page.waitForTimeout(jitter(2000, 3500));
  }
  return { boxes, loggedOut };
}

async function searchOnce(page, term, serp) {
  await page.goto(`${BASE}/search?q=${encodeURIComponent(term)}${serp ? `&serp_type=${serp}` : ""}`, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(7000);

  // 登入後才有「最新」分頁；訪客模式沒有就跳過
  try {
    for (const n of ["最新", "Recent", "最近"]) {
      const tab = page.getByRole("tab", { name: n });
      if (await tab.count()) { await tab.first().click({ timeout: 2500 }); await page.waitForTimeout(3500); break; }
    }
  } catch {}

  const r = await scrollCollect(page, SEARCH_SCROLLS, true);
  const u = page.url();
  if (!r.boxes.size && /login|challenge|checkpoint/.test(u)) log(`  被導向 ${u}，疑似被擋`);
  return r;
}

// group = { type, term, max_days, topics: [{ id, max_days }] }
// hours：立即爬文的時間窗；有值時只收近 hours 小時的新貼文，不套用「今天優先」
// browse = { page, authed, guestPage }：有登入就用主頁面切「最新」；訪客模式每種搜尋各開一個新 session
async function searchTopic(browse, group, dict, stats, revisit, hours) {
  const label = group.type === "hashtag" ? `#${group.term}` : `「${group.term}」`;
  log(hours ? `搜尋 ${label}（近 ${hours} 小時）` : `搜尋 ${label}（今天優先，沒有才收近 ${group.max_days} 天）`);

  const boxes = new Map();
  let loggedOut = false;
  const serps = browse.authed ? [group.type === "hashtag" ? "tags" : "default"] : GUEST_SERPS[group.type];
  for (const serp of serps) {
    const g = browse.authed ? { page: browse.page, close: async () => {} } : await browse.guestPage();
    try {
      const r = await searchOnce(g.page, group.term, serp);
      for (const [code, b] of r.boxes) boxes.set(code, b);
      loggedOut ||= r.loggedOut;
    } finally { await g.close(); }
  }
  if (loggedOut) stats.logged_out = 1;
  if (!boxes.size) log("  一篇都沒掃到");

  // 先挑出符合關鍵字、且在天數（立即爬文：小時）內的貼文
  const term = group.term.toLowerCase();
  const since = Date.now() - (hours ? hours * HOUR : group.max_days * DAY);
  const inWindow = [];
  for (const b of boxes.values()) {
    const p = boxToPost(b);
    // 關鍵字：內文或主題要含這個字；標籤：直接採用 Threads 標籤搜尋的結果
    if (group.type === "keyword" && !p.content.toLowerCase().includes(term) && !p.topic.toLowerCase().includes(term)) continue;
    const t = Date.parse(p.posted_at);
    if (Number.isNaN(t) || t < since) continue;
    inWindow.push({ p, t });
  }

  // 抓過的不再重抓（只補主題關聯）；新貼文今天有就只收今天的
  const matched = new Map();
  const fresh = [];
  let dupes = 0;
  for (const x of inWindow) {
    if (!postExists(x.p.code)) { fresh.push(x); continue; }
    dupes++;
    linkTopics(group, x.p.code, x.t);
    if (revisit) { upsertPost(x.p, dict); matched.set(x.p.code, x.p.counts); }
  }
  const today = twDate(Date.now());
  const todays = hours ? [] : fresh.filter((x) => twDate(x.t) === today);
  const picked = todays.length ? todays : fresh;
  for (const x of picked) {
    upsertPost(x.p, dict);
    linkTopics(group, x.p.code, x.t);
    matched.set(x.p.code, x.p.counts);
    state.newCodes.add(x.p.code);
  }

  stats.posts_found += picked.length;
  stats.posts_new += picked.length;
  stats.posts_skipped += dupes;
  const rule = !fresh.length ? "沒有新貼文"
    : hours ? `收 ${picked.length} 篇`
    : todays.length ? `今天有 ${todays.length} 篇，只收今天的${fresh.length > todays.length ? `（前幾天的 ${fresh.length - todays.length} 篇不收）` : ""}`
    : `今天沒有，改收近 ${group.max_days} 天的 ${picked.length} 篇`;
  log(`  掃到 ${boxes.size} 篇${serps.length > 1 ? `（${serps.length} 種搜尋合併）` : ""}，${hours ? `近 ${hours} 小時內` : "符合"} ${inWindow.length} 篇，已抓過略過 ${dupes} 篇 → ${rule}${loggedOut ? "（遇到登入牆）" : ""}`);
  return matched;
}

async function visitProfile(page, handle, runId, dict, stats, scrolls, revisit, hours) {
  log(`帳號 @${handle}`);
  await page.goto(`${BASE}/@${handle}`, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(jitter(6000, 8000));
  if (/\/login|challenge|checkpoint/.test(page.url())) throw new Error("被導向登入／驗證頁");

  const meta = await page.evaluate(() => ({
    og: document.querySelector('meta[property="og:description"]')?.content || "",
    title: document.title,
  })).catch(() => ({ og: "", title: "" }));
  const prof = parseProfileMeta(meta.og, meta.title);
  if (prof.followers == null) log("  讀不到粉絲數（帳號不存在、私人帳號或被擋）");

  // 粉絲數不是貼文，每次都記一筆，才看得到成長速度
  db.prepare(`INSERT INTO profiles (handle, name, bio, followers, last_seen) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(handle) DO UPDATE SET name = COALESCE(excluded.name, name), bio = COALESCE(excluded.bio, bio),
      followers = COALESCE(excluded.followers, followers), last_seen = excluded.last_seen`)
    .run(handle, prof.name, prof.bio, prof.followers, now());
  if (prof.followers != null) {
    db.prepare("INSERT INTO profile_snapshots (handle, run_id, captured_at, followers) VALUES (?, ?, ?, ?)").run(handle, runId, now(), prof.followers);
  }

  const { boxes } = await scrollCollect(page, scrolls, false);
  const since = hours ? Date.now() - hours * HOUR : 0;
  const matched = new Map();
  let seen = 0;
  let fresh = 0;
  let skipped = 0;
  let older = 0;
  for (const b of boxes.values()) {
    if (b.handle !== handle) continue; // 轉發別人的貼文不算
    seen++;
    const p = boxToPost(b);
    if (since && !(Date.parse(p.posted_at) >= since)) { older++; continue; } // 立即爬文只收時間窗內的
    if (postExists(p.code) && !revisit) { skipped++; continue; }
    if (upsertPost(p, dict)) { fresh++; state.newCodes.add(p.code); }
    matched.set(p.code, p.counts);
  }
  stats.posts_new += fresh;
  stats.posts_skipped += skipped;
  stats.profiles_seen++;
  log(`  粉絲 ${prof.followers ?? "—"}｜可見貼文 ${seen} 篇：新 ${fresh}、已抓過略過 ${skipped}${hours ? `、超過 ${hours} 小時 ${older}` : ""}`);
  return matched;
}

async function visitPost(page, target, runId, dict, stats) {
  await page.goto(target.url, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(jitter(5000, 7000));
  if (/\/login|challenge|checkpoint/.test(page.url())) throw new Error("被導向登入／驗證頁");

  const { boxes } = await scrollCollect(page, POST_SCROLLS, false);
  const main = boxes.get(target.code);
  if (!main) { log(`  ${target.code} 找不到主文，略過`); return false; }

  const views = parseViews(await page.evaluate(() => (document.body.innerText || "").slice(0, 300)).catch(() => ""));
  upsertPost({ ...boxToPost(main), url: target.url }, dict);
  if (views != null) db.prepare("UPDATE posts SET views = ? WHERE code = ?").run(views, target.code);
  db.prepare("UPDATE posts SET visited_at = ? WHERE code = ?").run(now(), target.code);
  insertSnapshot(target.code, runId, main.counts, views);

  const replies = [...boxes.values()].filter((b) => b.code !== target.code && !b.afterRelated);
  let fresh = 0;
  for (const r of replies) if (upsertComment(target.code, r, dict)) fresh++;

  stats.posts_visited++;
  stats.comments_found += replies.length;
  stats.comments_new += fresh;
  log(`  @${main.handle}｜讚 ${main.counts.likes}・留言 ${main.counts.replies}${views != null ? `・瀏覽 ${views}` : ""}｜取得留言 ${replies.length} 則（新 ${fresh}）`);
  return true;
}

// opts.hours 有值＝立即爬文：只抓 opts.wsId 這個工作區；opts.visit 決定要不要點進新抓到的貼文
async function crawl(runId, { hours = 0, wsId = null, visit = true } = {}) {
  const s = getSettings();
  const dict = dictFrom(s);
  const revisit = hours ? false : s.revisit_old;
  const inWs = wsId ? " AND workspace_id = ?" : "";
  const wsArgs = wsId ? [wsId] : [];

  const groups = new Map();
  for (const t of db.prepare(`SELECT id, type, term, max_days FROM topics WHERE enabled = 1${inWs} ORDER BY id`).all(...wsArgs)) {
    const key = `${t.type}|${t.term.toLowerCase()}`;
    const g = groups.get(key) || { type: t.type, term: t.term, max_days: 0, topics: [] };
    g.max_days = Math.max(g.max_days, t.max_days);
    g.topics.push({ id: t.id, max_days: t.max_days });
    groups.set(key, g);
  }
  const handles = db.prepare(`SELECT DISTINCT handle FROM accounts WHERE enabled = 1${inWs} ORDER BY handle`).all(...wsArgs).map((r) => r.handle);
  if (!groups.size && !handles.length) throw new Error(`${wsId ? "這個工作區" : ""}沒有啟用中的主題或帳號，請先到「監測設定」新增`);

  const stats = { logged_out: 0, posts_found: 0, posts_new: 0, posts_skipped: 0, posts_visited: 0, profiles_seen: 0, comments_found: 0, comments_new: 0 };
  const hasAuth = fs.existsSync(AUTH_FILE);
  log(hasAuth ? "使用 data/auth_state.json 的登入狀態" : "訪客模式（未登入）：每個主題約可見 7–12 篇、每個帳號約 10 篇、每篇約 25 則留言");
  log(hours
    ? `立即爬文：只收近 ${hours} 小時發布、還沒抓過的貼文｜主題 ${groups.size} 個、帳號 ${handles.length} 個`
    : `本次：主題 ${groups.size} 個、帳號 ${handles.length} 個｜${revisit ? "會回頭更新已抓過的貼文" : "已抓過的貼文不重抓"}`);

  const browser = await chromium.launch({ headless: s.headless, channel: s.browser_channel || undefined });
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: "zh-TW",
      ...(hasAuth ? { storageState: AUTH_FILE } : {}),
    });
    const page = await context.newPage();
    log("開首頁暖身…");
    await page.goto(BASE, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(5000);

    // 訪客模式搜尋每次開一個乾淨的 context（等於新的訪客 session），用完就關
    const browse = {
      page,
      authed: hasAuth,
      guestPage: async () => {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-TW" });
        return { page: await ctx.newPage(), close: () => ctx.close().catch(() => {}) };
      },
    };

    const listCounts = new Map();
    for (const g of groups.values()) {
      try {
        for (const [code, c] of await searchTopic(browse, g, dict, stats, revisit, hours)) listCounts.set(code, c);
      } catch (e) { log(`  搜尋失敗：${e.message}`); }
    }
    for (const h of handles) {
      try {
        const scrolls = hours ? Math.min(s.profile_scrolls, 2) : s.profile_scrolls; // 個人頁新的在上面，立即爬文不用捲太深
        for (const [code, c] of await visitProfile(page, h, runId, dict, stats, scrolls, revisit, hours)) listCounts.set(code, c);
      } catch (e) { log(`  @${h} 失敗：${e.message}`); }
      await page.waitForTimeout(jitter(2000, 4000));
    }

    // 逐篇點進去取瀏覽數與留言：
    //   立即爬文只進這次新抓到的貼文；
    //   一般抓取預設只進還沒點過的，開啟 revisit_old 才會回頭更新近 track_days 天的舊貼文
    let targets;
    if (hours) {
      targets = visit
        ? db.prepare("SELECT code, url FROM posts WHERE code IN (SELECT value FROM json_each(?)) ORDER BY posted_at DESC LIMIT ?")
          .all(JSON.stringify([...state.newCodes]), s.max_post_visits)
        : [];
      log(visit ? `逐篇進貼文頁：這次新抓到的 ${targets.length} 篇（上限 ${s.max_post_visits} 篇）` : "不點進貼文頁（只存列表上的內文與互動數）");
    } else {
      targets = db.prepare(`SELECT p.code, p.url FROM posts p WHERE p.posted_at >= :since
          ${revisit ? "" : "AND p.visited_at IS NULL"} AND (
          EXISTS (SELECT 1 FROM post_topics x JOIN topics t ON t.id = x.topic_id WHERE x.post_code = p.code AND t.enabled = 1)
          OR p.author IN (SELECT handle FROM accounts WHERE enabled = 1))
        ORDER BY p.posted_at DESC LIMIT :lim`).all({ since: new Date(Date.now() - s.track_days * DAY).toISOString(), lim: s.max_post_visits });
      log(`逐篇進貼文頁：${targets.length} 篇（${revisit ? "含已抓過的" : "只進還沒抓過的"}，近 ${s.track_days} 天，上限 ${s.max_post_visits} 篇）`);
    }

    const snapped = new Set();
    for (const t of targets) {
      try {
        if (await visitPost(page, t, runId, dict, stats)) snapped.add(t.code);
      } catch (e) {
        log(`  ${t.code} 失敗：${e.message}`);
      }
      await page.waitForTimeout(jitter(2500, 5000));
    }
    // 沒點進去的貼文，用列表上的數字記一筆快照
    for (const [code, c] of listCounts) if (!snapped.has(code)) insertSnapshot(code, runId, c);
  } finally {
    await browser.close().catch(() => {});
  }

  log(`完成：主題收錄 ${stats.posts_found} 篇、新貼文共 ${stats.posts_new} 篇、已抓過略過 ${stats.posts_skipped} 篇、帳號 ${stats.profiles_seen} 個、點進 ${stats.posts_visited} 篇、留言 ${stats.comments_found} 則（新 ${stats.comments_new}）`);
  finishRun(runId, "success", stats);
  return stats;
}

// 背景啟動，立刻回傳 runId；進度看 state.log。opts 見 crawl()
export function startCrawl(trigger = "manual", startedBy = null, opts = {}) {
  if (state.running) return { ok: false, error: "已有抓取正在進行", runId: state.runId };
  const r = db.prepare("INSERT INTO runs (trigger, started_by, started_at, status, window_hours, workspace_id) VALUES (?, ?, ?, 'running', ?, ?)")
    .run(trigger, startedBy, now(), opts.hours || null, opts.wsId || null);
  const runId = Number(r.lastInsertRowid);
  Object.assign(state, { running: true, runId, trigger, hours: opts.hours || null, startedAt: now(), log: [], newCodes: new Set() });
  const done = crawl(runId, opts).catch((e) => {
    log("失敗：" + e.message);
    finishRun(runId, "failed", {}, e.message);
  }).finally(() => { state.running = false; });
  return { ok: true, runId, done };
}

// 伺服器重開時，把上次沒跑完的紀錄標成中斷
db.prepare("UPDATE runs SET status = 'interrupted', finished_at = ? WHERE status = 'running'").run(now());
