// ── 分析查詢：全部以工作區為範圍 ─────────────────────────────────────
// 工作區看得到的貼文 = 被該工作區主題抓到的貼文 ∪ 該工作區監測帳號發的貼文
import { db } from "./db.js";

const DAY = 86400000;
const INTER = "(p.likes + p.replies + p.reposts + p.shares)";
const SCOPE = `scope AS (
  SELECT pt.post_code AS code FROM post_topics pt JOIN topics t ON t.id = pt.topic_id WHERE t.workspace_id = :ws
  UNION
  SELECT p.code FROM posts p JOIN accounts a ON a.handle = p.author WHERE a.workspace_id = :ws
)`;

const sinceISO = (days) => new Date(Date.now() - days * DAY).toISOString();
const twDate = (ms) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
const sum = (a) => a.reduce((s, x) => s + (x || 0), 0);
const avg = (a) => (a.length ? sum(a) / a.length : 0);
export function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const round = (x, d = 1) => (x == null || Number.isNaN(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

export function dateRange(days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(twDate(Date.now() - i * DAY));
  return out;
}

// 前後半段比較：±20% 以內算持平
function trendOf(recent, prev) {
  if (!prev && !recent) return { label: "無資料", change: null };
  if (!prev) return { label: "上升", change: null, fresh: true };
  const change = (recent - prev) / prev;
  return { label: change >= 0.2 ? "上升" : change <= -0.2 ? "下降" : "持平", change: round(change * 100, 0) };
}

// ── 貼文列表（全部串文成效列表、主題熱門貼文、最佳貼文共用）─────────
const SORTS = {
  newest: "p.posted_at DESC",
  inter: "inter DESC",
  likes: "p.likes DESC",
  replies: "p.replies DESC",
  views: "p.views IS NULL, p.views DESC",
  er: "(inter * 1.0 / NULLIF(pr.followers, 0)) IS NULL, (inter * 1.0 / NULLIF(pr.followers, 0)) DESC",
  negative: "c_neg DESC, p.posted_at DESC",
};

export function postsList(ws, f = {}) {
  const params = { ws };
  const where = [];
  if (f.days > 0) { where.push("p.posted_at >= :since"); params.since = sinceISO(f.days); }
  if (f.topicId) { where.push("EXISTS (SELECT 1 FROM post_topics x WHERE x.post_code = p.code AND x.topic_id = :tid)"); params.tid = Number(f.topicId); }
  if (f.handle) { where.push("p.author = :handle"); params.handle = String(f.handle).replace(/^@/, ""); }
  if (f.kind) { where.push("p.author IN (SELECT handle FROM accounts WHERE workspace_id = :ws AND kind = :kind)"); params.kind = f.kind; }
  if (f.q) { where.push("p.content LIKE :q"); params.q = `%${f.q}%`; }
  if (f.onlyViews) where.push("p.views IS NOT NULL");
  params.limit = Math.min(Number(f.limit) || 300, 2000);

  const rows = db.prepare(`WITH ${SCOPE}
    SELECT p.*, ${INTER} AS inter, pr.followers,
      (SELECT COUNT(*) FROM comments c WHERE c.post_code = p.code) AS c_total,
      (SELECT COUNT(*) FROM comments c WHERE c.post_code = p.code AND c.sentiment = 'negative') AS c_neg,
      (SELECT COUNT(*) FROM comments c WHERE c.post_code = p.code AND c.sentiment = 'positive') AS c_pos,
      (SELECT group_concat(t.term, '、') FROM post_topics x JOIN topics t ON t.id = x.topic_id
         WHERE x.post_code = p.code AND t.workspace_id = :ws) AS topics
    FROM posts p JOIN scope s ON s.code = p.code LEFT JOIN profiles pr ON pr.handle = p.author
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY ${SORTS[f.sort] || SORTS.newest} LIMIT :limit`).all(params);

  // 跟上一筆快照比，看最近一次抓取之間長了多少
  const prevStmt = db.prepare("SELECT likes, replies, reposts, shares, views FROM post_metrics WHERE post_code = ? ORDER BY captured_at DESC LIMIT 1 OFFSET 1");
  return rows.map((r) => {
    const prev = prevStmt.get(r.code);
    return {
      ...r,
      neg_hits: JSON.parse(r.neg_hits || "[]"),
      er: r.followers ? round((r.inter / r.followers) * 100, 2) : null,
      per_k_views: r.views ? round((r.inter / r.views) * 1000, 1) : null,
      delta: prev ? { inter: r.inter - (prev.likes + prev.replies + prev.reposts + prev.shares), views: r.views != null && prev.views != null ? r.views - prev.views : null } : null,
    };
  });
}

export function postDetail(ws, code) {
  const inScope = db.prepare(`WITH ${SCOPE} SELECT 1 FROM scope WHERE code = :code`).get({ ws, code });
  if (!inScope) return null;
  const post = db.prepare(`SELECT p.*, ${INTER} AS inter, pr.followers, pr.name AS author_name FROM posts p
      LEFT JOIN profiles pr ON pr.handle = p.author WHERE p.code = ?`).get(code);
  post.neg_hits = JSON.parse(post.neg_hits || "[]");
  post.er = post.followers ? round((post.inter / post.followers) * 100, 2) : null;
  const topics = db.prepare(`SELECT t.id, t.type, t.term FROM post_topics x JOIN topics t ON t.id = x.topic_id
      WHERE x.post_code = ? AND t.workspace_id = ?`).all(code, ws);
  const metrics = db.prepare("SELECT captured_at, likes, replies, reposts, shares, views FROM post_metrics WHERE post_code = ? ORDER BY captured_at").all(code);
  const comments = db.prepare("SELECT * FROM comments WHERE post_code = ? ORDER BY likes DESC, posted_at").all(code)
    .map((c) => ({ ...c, neg_hits: JSON.parse(c.neg_hits || "[]") }));
  return { post, topics, metrics, comments };
}

// ── 總覽 ─────────────────────────────────────────────────────────────
export function overview(ws, days) {
  const posts = postsList(ws, { days, limit: 2000 });
  const inter = posts.map((p) => p.inter);
  const withViews = posts.filter((p) => p.views != null);

  const params = { ws, since: sinceISO(days) };
  const comments = db.prepare(`WITH ${SCOPE}
    SELECT c.*, p.content AS post_content, p.author AS post_author FROM comments c
    JOIN scope s ON s.code = c.post_code JOIN posts p ON p.code = c.post_code
    WHERE p.posted_at >= :since`).all(params).map((c) => ({ ...c, neg_hits: JSON.parse(c.neg_hits || "[]") }));

  const negFreq = {};
  for (const x of [...posts, ...comments]) for (const k of x.neg_hits) negFreq[k] = (negFreq[k] || 0) + 1;

  const dates = dateRange(days);
  const daily = Object.fromEntries(dates.map((d) => [d, { posts: 0, inter: 0, pos: 0, neu: 0, neg: 0 }]));
  for (const p of posts) { const d = twDate(Date.parse(p.posted_at)); if (daily[d]) { daily[d].posts++; daily[d].inter += p.inter; } }
  for (const c of comments) {
    const d = twDate(Date.parse(c.posted_at));
    if (!daily[d]) continue;
    daily[d][c.sentiment === "positive" ? "pos" : c.sentiment === "negative" ? "neg" : "neu"]++;
  }

  const lastRun = db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 1").get() || null;
  if (lastRun) delete lastRun.log;

  return {
    kpi: {
      posts: posts.length,
      interactions: sum(inter),
      avg_inter: round(avg(inter)),
      median_inter: median(inter),
      views_total: sum(withViews.map((p) => p.views)),
      views_posts: withViews.length,
      comments: comments.length,
      comments_pos: comments.filter((c) => c.sentiment === "positive").length,
      comments_neu: comments.filter((c) => c.sentiment === "neutral").length,
      comments_neg: comments.filter((c) => c.sentiment === "negative").length,
      flagged_posts: posts.filter((p) => p.neg_hits.length).length,
      flagged_comments: comments.filter((c) => c.neg_hits.length).length,
    },
    daily: dates.map((d) => ({ date: d, ...daily[d] })),
    neg_keywords: Object.entries(negFreq).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ keyword: k, count: n })),
    top_posts: [...posts].sort((a, b) => b.inter - a.inter).slice(0, 5),
    flagged: comments.filter((c) => c.neg_hits.length || c.sentiment === "negative").sort((a, b) => b.likes - a.likes).slice(0, 8),
    last_run: lastRun,
  };
}

// ── 主題：提及數、互動、平均、趨勢、排名、交叉比較 ────────────────────
export function topicSummary(ws, days) {
  const topics = db.prepare("SELECT * FROM topics WHERE workspace_id = ? ORDER BY id").all(ws);
  const stmt = db.prepare(`SELECT p.code, p.content, p.author, p.posted_at, p.views, p.neg_hits, ${INTER} AS inter
      FROM post_topics x JOIN posts p ON p.code = x.post_code WHERE x.topic_id = :tid AND p.posted_at >= :since`);
  const buckets = [[0, 9], [10, 99], [100, 999], [1000, Infinity]];

  return topics.map((t) => {
    const rows = stmt.all({ tid: t.id, since: sinceISO(days) });
    const inter = rows.map((r) => r.inter);
    // 趨勢只比較「開始監測以來」的前後半：主題只收近 max_days 天的貼文，更早的前半段本來就不會有資料
    const span = Math.min(days, (Date.now() - Date.parse(t.created_at)) / DAY + t.max_days);
    const warming = span < 4;
    const mid = sinceISO(span / 2);
    const spanRows = rows.filter((r) => r.posted_at >= sinceISO(span));
    const recent = spanRows.filter((r) => r.posted_at >= mid);
    const prev = spanRows.filter((r) => r.posted_at < mid);
    const views = rows.filter((r) => r.views != null).map((r) => r.views);
    const top = [...rows].sort((a, b) => b.inter - a.inter)[0] || null;
    return {
      id: t.id, type: t.type, term: t.term, enabled: t.enabled, max_days: t.max_days,
      mentions: rows.length,
      interactions: sum(inter),
      avg_inter: round(avg(inter)),
      median_inter: median(inter),
      views_avg: views.length ? Math.round(avg(views)) : null,
      views_n: views.length,
      flagged: rows.filter((r) => r.neg_hits && r.neg_hits !== "[]").length,
      mention_trend: warming ? { label: "資料累積中", change: null } : trendOf(recent.length, prev.length),
      inter_trend: warming ? { label: "資料累積中", change: null } : trendOf(sum(recent.map((r) => r.inter)), sum(prev.map((r) => r.inter))),
      distribution: buckets.map(([lo, hi]) => inter.filter((v) => v >= lo && v <= hi).length),
      top: top && { code: top.code, author: top.author, content: (top.content || "").slice(0, 60), inter: top.inter },
    };
  });
}

export function topicDaily(ws, days) {
  const dates = dateRange(days);
  const topics = db.prepare("SELECT id, type, term FROM topics WHERE workspace_id = ? ORDER BY id").all(ws);
  const rows = db.prepare(`SELECT x.topic_id, date(p.posted_at, '+8 hours') AS d, COUNT(*) AS n, SUM(${INTER}) AS inter
      FROM post_topics x JOIN posts p ON p.code = x.post_code JOIN topics t ON t.id = x.topic_id
      WHERE t.workspace_id = :ws AND p.posted_at >= :since GROUP BY x.topic_id, d`).all({ ws, since: sinceISO(days) });
  return {
    dates,
    series: topics.map((t) => {
      const m = new Map(rows.filter((r) => r.topic_id === t.id).map((r) => [r.d, r]));
      return { id: t.id, type: t.type, term: t.term, mentions: dates.map((d) => m.get(d)?.n || 0), interactions: dates.map((d) => m.get(d)?.inter || 0) };
    }),
  };
}

// ── 瀏覽次數分析：有沒有得到曝光、曝光轉互動的效率 ─────────────────────
export function viewsAnalysis(ws, f) {
  const posts = postsList(ws, { ...f, onlyViews: true, limit: 1000 });
  const views = posts.map((p) => p.views);
  const rates = posts.filter((p) => p.per_k_views != null).map((p) => p.per_k_views);
  const mv = median(views);
  const mr = median(rates);
  for (const p of posts) {
    if (p.views < mv * 0.5) p.exposure = "曝光偏低";
    else if (p.per_k_views != null && p.per_k_views < mr * 0.5) p.exposure = "高曝光低互動";
    else if (p.views >= mv && p.per_k_views >= mr) p.exposure = "曝光與互動俱佳";
    else p.exposure = "一般";
  }
  return { median_views: mv, median_per_k: mr, posts };
}

// ── 帳號：粉絲、成長速度、互動率、一對一比較 ──────────────────────────
export function accountsSummary(ws, days) {
  const accounts = db.prepare(`SELECT a.*, pr.name, pr.bio, pr.followers, pr.last_seen FROM accounts a
      LEFT JOIN profiles pr ON pr.handle = a.handle WHERE a.workspace_id = ? ORDER BY a.kind DESC, a.id`).all(ws);
  const since = sinceISO(days);
  const postStmt = db.prepare(`SELECT code, content, posted_at, views, media_type, ${INTER} AS inter FROM posts p WHERE author = ? AND posted_at >= ?`);
  const snapStmt = db.prepare("SELECT captured_at, followers FROM profile_snapshots WHERE handle = ? AND captured_at >= ? AND followers IS NOT NULL ORDER BY captured_at");

  return accounts.map((a) => {
    const posts = postStmt.all(a.handle, since);
    const inter = posts.map((p) => p.inter);
    const snaps = snapStmt.all(a.handle, since);
    const first = snaps[0];
    const last = snaps[snaps.length - 1];
    // 至少兩筆快照才談得上成長，只有一筆時顯示「—」而不是 0
    const spanDays = snaps.length >= 2 ? (Date.parse(last.captured_at) - Date.parse(first.captured_at)) / DAY : 0;
    const growth = snaps.length >= 2 ? last.followers - first.followers : null;
    const views = posts.filter((p) => p.views != null).map((p) => p.views);
    const best = [...posts].sort((x, y) => y.inter - x.inter)[0];
    return {
      ...a,
      posts: posts.length,
      posts_per_week: round(posts.length / (days / 7)),
      avg_inter: round(avg(inter)),
      median_inter: median(inter),
      er: a.followers && posts.length ? round((avg(inter) / a.followers) * 100, 2) : null,
      views_avg: views.length ? Math.round(avg(views)) : null,
      growth,
      growth_pct: growth != null && first.followers ? round((growth / first.followers) * 100, 2) : null,
      growth_per_day: growth != null && spanDays >= 0.5 ? round(growth / spanDays) : null,
      snapshots: snaps.length,
      best: best && { code: best.code, content: (best.content || "").slice(0, 60), inter: best.inter },
    };
  });
}

// 粉絲數量級不同，改畫「相對起點成長 %」，所有帳號共用一個軸
export function followerSeries(ws, days) {
  const dates = dateRange(days);
  const accounts = db.prepare("SELECT handle, label, kind FROM accounts WHERE workspace_id = ? ORDER BY kind DESC, id").all(ws);
  const stmt = db.prepare(`SELECT date(captured_at, '+8 hours') AS d, MAX(captured_at) AS t, followers FROM profile_snapshots
      WHERE handle = ? AND captured_at >= ? AND followers IS NOT NULL GROUP BY d ORDER BY d`);
  return {
    dates,
    series: accounts.map((a) => {
      const rows = stmt.all(a.handle, sinceISO(days));
      const m = new Map(rows.map((r) => [r.d, r.followers]));
      const base = rows[0]?.followers || null;
      return {
        handle: a.handle, label: a.label, kind: a.kind,
        followers: dates.map((d) => m.get(d) ?? null),
        index: dates.map((d) => (m.has(d) && base ? round(((m.get(d) - base) / base) * 100, 2) : null)),
      };
    }),
  };
}

export function weeklyInteractions(handles, days) {
  const weeks = Math.max(1, Math.ceil(days / 7));
  const labels = [];
  for (let i = weeks - 1; i >= 0; i--) labels.push(twDate(Date.now() - (i * 7 + 6) * DAY));
  const stmt = db.prepare(`SELECT posted_at, ${INTER} AS inter FROM posts p WHERE author = ? AND posted_at >= ?`);
  return {
    labels,
    series: handles.map((h) => {
      const rows = stmt.all(h, sinceISO(weeks * 7));
      const buckets = Array.from({ length: weeks }, () => []);
      for (const r of rows) {
        const age = Math.floor((Date.now() - Date.parse(r.posted_at)) / (7 * DAY));
        const i = weeks - 1 - age;
        if (i >= 0 && i < weeks) buckets[i].push(r.inter);
      }
      return { handle: h, posts: buckets.map((b) => b.length), avg_inter: buckets.map((b) => (b.length ? round(avg(b)) : null)) };
    }),
  };
}

// ── 最佳發文時間：星期 × 3 小時時段的平均互動 ─────────────────────────
export function bestTimes(ws, f) {
  const posts = postsList(ws, { ...f, limit: 2000 });
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 8 }, () => []));
  for (const p of posts) {
    const tw = new Date(Date.parse(p.posted_at) + 8 * 3600000);
    grid[tw.getUTCDay()][Math.floor(tw.getUTCHours() / 3)].push(p.inter);
  }
  const cells = [];
  grid.forEach((row, day) => row.forEach((vals, block) => cells.push({ day, block, n: vals.length, avg: vals.length ? round(avg(vals)) : null, median: vals.length ? median(vals) : null })));
  const recommend = cells.filter((c) => c.n >= 2).sort((a, b) => b.median - a.median).slice(0, 3);
  return { posts: posts.length, cells, recommend };
}

// ── 內容成功模式：高成效（前 25%）vs 其他，比較內容特徵 ───────────────
const EMOJI = /\p{Extended_Pictographic}/u;
function features(p) {
  const c = p.content || "";
  const first = c.split("\n")[0] || "";
  return {
    media: !!p.media_type && p.media_type !== "text",
    video: p.media_type === "video",
    question: /[?？]/.test(c),
    emoji: EMOJI.test(c),
    tag: !!p.topic_tag || /#\S/.test(c),
    mention: /@[\w.]+/.test(c),
    link: /https?:\/\//.test(c),
    short_opening: [...first].length <= 15,
    number_opening: /^[\d０-９]|^[一二三四五六七八九十]+[個件招點種]/.test(first),
    exclaim: /[!！]/.test(c),
    long_post: [...c].length >= 120,
  };
}
const FEATURE_LABELS = {
  media: "附圖片或影片", video: "附影片", question: "含問句", emoji: "使用表情符號", tag: "有主題標籤",
  mention: "標記其他帳號", link: "附連結", short_opening: "開頭第一行 15 字內", number_opening: "開頭用數字",
  exclaim: "含驚嘆號", long_post: "長文（120 字以上）",
};

export function successPatterns(ws, f) {
  const posts = postsList(ws, { ...f, limit: 2000 }).filter((p) => p.content);
  if (posts.length < 8) return { enough: false, posts: posts.length, min: 8 };
  const sorted = [...posts].sort((a, b) => b.inter - a.inter);
  const cut = Math.max(2, Math.round(sorted.length * 0.25));
  const top = sorted.slice(0, cut);
  const rest = sorted.slice(cut);
  const pct = (group, key) => (group.filter((p) => features(p)[key]).length / group.length) * 100;
  const len = (g) => Math.round(avg(g.map((p) => [...(p.content || "")].length)));

  const rows = Object.keys(FEATURE_LABELS).map((key) => {
    const a = pct(top, key);
    const b = pct(rest, key);
    return { key, label: FEATURE_LABELS[key], top: round(a, 0), rest: round(b, 0), diff: round(a - b, 0) };
  }).sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));

  const insights = rows.filter((r) => Math.abs(r.diff) >= 15).slice(0, 5).map((r) =>
    r.diff > 0
      ? `高成效貼文有 ${r.top}%「${r.label}」，其他貼文只有 ${r.rest}%`
      : `高成效貼文較少「${r.label}」（${r.top}% vs 其他 ${r.rest}%）`);
  const lt = len(top), lr = len(rest);
  if (Math.abs(lt - lr) >= Math.max(20, lr * 0.3)) insights.push(`高成效貼文平均 ${lt} 字，其他貼文平均 ${lr} 字`);

  // 高成效貼文裡特別常出現的雙字詞（跟其他貼文比的倍數），給題材靈感
  const grams = (g) => {
    const m = new Map();
    for (const p of g) {
      const seen = new Set();
      const t = (p.content || "").replace(/[^\p{Script=Han}]/gu, " ");
      for (const seg of t.split(/\s+/)) for (let i = 0; i + 1 < seg.length; i++) seen.add(seg.slice(i, i + 2));
      for (const x of seen) m.set(x, (m.get(x) || 0) + 1);
    }
    return m;
  };
  const gt = grams(top);
  const gr = grams(rest);
  const terms = [...gt.entries()].filter(([, n]) => n >= 2)
    .map(([w, n]) => ({ term: w, top_share: round((n / top.length) * 100, 0), rest_share: round(((gr.get(w) || 0) / Math.max(rest.length, 1)) * 100, 0) }))
    .filter((x) => x.top_share > x.rest_share)
    .sort((a, b) => b.top_share - b.rest_share - (a.top_share - a.rest_share))
    .slice(0, 12);

  return {
    enough: true,
    posts: posts.length,
    top_n: top.length,
    threshold: top[top.length - 1].inter,
    avg_len: { top: lt, rest: lr },
    rows,
    insights,
    terms,
    examples: top.slice(0, 5).map((p) => ({ code: p.code, author: p.author, content: (p.content || "").slice(0, 80), inter: p.inter, url: p.url })),
  };
}
