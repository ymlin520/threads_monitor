// ── Threads 監測系統：API ＋ 靜態網頁 ─────────────────────────────────
// 預設只聽 127.0.0.1（只有這台電腦能開）；要讓同網路的人連，啟動前設 HOST=0.0.0.0
import express from "express";
import path from "path";
import { db, ROOT, now, getRawSettings, setSettings, createWorkspace, tx } from "./db.js";
import {
  COOKIE, needsSetup, validateCredentials, createUser, checkLogin, createSession, renewSession, destroySession, sessionToken,
  setPassword, verifyPassword, userWorkspaces, requireUser, requireOwner, withWorkspace,
} from "./auth.js";
import * as A from "./analytics.js";
import { reanalyzeAll } from "./analyze.js";
import { startCrawl, state as crawlState } from "./crawler.js";
import { startScheduler, nextRunAt } from "./scheduler.js";
import { buildWorkbook, postsCsv } from "./report.js";
import { negativeBoard, negativeCsv } from "./negative.js";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3900);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(ROOT, "public")));
app.use("/vendor", express.static(path.join(ROOT, "node_modules", "chart.js", "dist")));

const days = (req, def = 30) => Math.min(Math.max(Number(req.query.days) || def, 1), 365);
const filters = (req) => ({
  days: days(req),
  topicId: req.query.topic ? Number(req.query.topic) : undefined,
  handle: req.query.handle || undefined,
  kind: ["own", "competitor"].includes(req.query.kind) ? req.query.kind : undefined,
  sort: req.query.sort,
  q: req.query.q || undefined,
  limit: req.query.limit,
});
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
// maxAge 為 null：瀏覽器關閉即失效；經 Cloudflare 等 HTTPS 代理連進來時加上 Secure
const setCookie = (req, res, token, maxAge) => {
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  const age = maxAge == null ? "" : `; Max-Age=${maxAge}`;
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/${age}${secure}`);
};
const cleanHandle = (h) => String(h || "").trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?threads\.(net|com)\/@?/, "").replace(/[/?#].*$/, "");

// ── 首次設定、登入 ─────────────────────────────────────────────────────
app.get("/api/setup-status", (req, res) => res.json({ needsSetup: needsSetup() }));

app.post("/api/setup", (req, res) => {
  if (!needsSetup()) return bad(res, "系統已完成初始設定", 409);
  const { username, display_name, password, workspace_name } = req.body || {};
  const err = validateCredentials(username, password);
  if (err) return bad(res, err);
  const userId = tx(() => {
    const id = createUser({ username, display_name, password, is_owner: 1 });
    const wsId = createWorkspace(String(workspace_name || "").trim() || "我的工作區", id);
    db.prepare("INSERT INTO topics (workspace_id, type, term, max_days, enabled, created_at) VALUES (?, 'keyword', '世新', 3, 1, ?)").run(wsId, now());
    return id;
  });
  const s = createSession(userId, true);
  setCookie(req, res, s.token, s.maxAge);
  res.json({ ok: true });
});

// remember 預設為 true（記住我 30 天）；前端沒勾時送 false
app.post("/api/login", (req, res) => {
  const { username, password, remember } = req.body || {};
  const r = checkLogin(String(username || ""), String(password || ""));
  if (r.error) return bad(res, r.error, 401);
  const s = createSession(r.user.id, remember !== false);
  setCookie(req, res, s.token, s.maxAge);
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  destroySession(sessionToken(req));
  setCookie(req, res, "", 0);
  res.json({ ok: true });
});

// 每次開頁面都會打這支：記住我的 session 快到期時順便延長，天天用就不會被登出
app.get("/api/me", requireUser, (req, res) => {
  const renewed = renewSession(sessionToken(req));
  if (renewed) setCookie(req, res, sessionToken(req), renewed.maxAge);
  res.json({ user: req.user, workspaces: userWorkspaces(req.user) });
});

app.post("/api/me/password", requireUser, (req, res) => {
  const { current, next } = req.body || {};
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!verifyPassword(String(current || ""), u.pass_salt, u.pass_hash)) return bad(res, "目前密碼不正確");
  if (String(next || "").length < 8) return bad(res, "新密碼至少 8 個字元");
  setPassword(u.id, next);
  const s = createSession(u.id, true);
  setCookie(req, res, s.token, s.maxAge);
  res.json({ ok: true });
});

// ── 前台：分析（viewer 以上）──────────────────────────────────────────
const ws = express.Router();
ws.use(requireUser);
const view = withWorkspace("viewer");
const edit = withWorkspace("editor");
const admin = withWorkspace("admin");

ws.get("/overview", view, (req, res) => res.json(A.overview(req.ws.id, days(req))));
ws.get("/posts", view, (req, res) => res.json(A.postsList(req.ws.id, filters(req))));
ws.get("/posts/:code", view, (req, res) => {
  const d = A.postDetail(req.ws.id, req.params.code);
  if (!d) return bad(res, "找不到這篇貼文", 404);
  res.json(d);
});
ws.get("/topics/summary", view, (req, res) => res.json(A.topicSummary(req.ws.id, days(req))));
ws.get("/topics/daily", view, (req, res) => res.json(A.topicDaily(req.ws.id, days(req))));
ws.get("/views", view, (req, res) => res.json(A.viewsAnalysis(req.ws.id, filters(req))));
ws.get("/accounts/summary", view, (req, res) => res.json(A.accountsSummary(req.ws.id, days(req))));
ws.get("/accounts/followers", view, (req, res) => res.json(A.followerSeries(req.ws.id, days(req))));
ws.get("/accounts/compare", view, (req, res) => {
  const a = cleanHandle(req.query.a);
  const b = cleanHandle(req.query.b);
  if (!a || !b) return bad(res, "請選兩個帳號");
  const all = A.accountsSummary(req.ws.id, days(req));
  res.json({
    a: all.find((x) => x.handle === a) || null,
    b: all.find((x) => x.handle === b) || null,
    weekly: A.weeklyInteractions([a, b], days(req)),
    followers: A.followerSeries(req.ws.id, days(req)).series.filter((s) => s.handle === a || s.handle === b),
  });
});
ws.get("/best-times", view, (req, res) => res.json(A.bestTimes(req.ws.id, filters(req))));
ws.get("/patterns", view, (req, res) => res.json(A.successPatterns(req.ws.id, filters(req))));

// 負面留言板：level（high／mid／low）、type（comment／post／all）另外帶
const negFilters = (req) => ({ ...filters(req), level: req.query.level, type: req.query.type });
ws.get("/negative", view, (req, res) => res.json(negativeBoard(req.ws.id, negFilters(req))));
ws.get("/negative.csv", view, (req, res) => {
  const d = negativeBoard(req.ws.id, { ...negFilters(req), all: true });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=negative.csv");
  res.send(negativeCsv(d.items));
});

ws.get("/export.xlsx", view, async (req, res) => {
  const wb = buildWorkbook(req.ws, days(req));
  const stamp = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10).replace(/-/g, "");
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`Threads報表_${req.ws.name}_${stamp}.xlsx`)}`);
  await wb.xlsx.write(res);
  res.end();
});
ws.get("/export/posts.csv", view, (req, res) => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=posts.csv");
  res.send(postsCsv(A.postsList(req.ws.id, { ...filters(req), limit: 2000 })));
});

// ── 後台：監測項目（editor 以上）──────────────────────────────────────
ws.get("/topics", view, (req, res) =>
  res.json(db.prepare("SELECT * FROM topics WHERE workspace_id = ? ORDER BY id").all(req.ws.id)));

ws.post("/topics", edit, (req, res) => {
  const type = req.body?.type === "hashtag" ? "hashtag" : "keyword";
  const term = String(req.body?.term || "").trim().replace(/^#/, "");
  const maxDays = Math.min(Math.max(Number(req.body?.max_days) || 3, 1), 30);
  if (!term || term.length > 40) return bad(res, "請輸入 1–40 字的關鍵字或標籤");
  try {
    db.prepare("INSERT INTO topics (workspace_id, type, term, max_days, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)").run(req.ws.id, type, term, maxDays, now());
  } catch { return bad(res, "這個主題已經存在"); }
  res.json({ ok: true });
});

ws.patch("/topics/:id", edit, (req, res) => {
  const t = db.prepare("SELECT * FROM topics WHERE id = ? AND workspace_id = ?").get(Number(req.params.id), req.ws.id);
  if (!t) return bad(res, "找不到主題", 404);
  const enabled = req.body?.enabled != null ? (req.body.enabled ? 1 : 0) : t.enabled;
  const maxDays = req.body?.max_days != null ? Math.min(Math.max(Number(req.body.max_days) || 3, 1), 30) : t.max_days;
  db.prepare("UPDATE topics SET enabled = ?, max_days = ? WHERE id = ?").run(enabled, maxDays, t.id);
  res.json({ ok: true });
});

ws.delete("/topics/:id", edit, (req, res) => {
  db.prepare("DELETE FROM topics WHERE id = ? AND workspace_id = ?").run(Number(req.params.id), req.ws.id);
  res.json({ ok: true });
});

ws.get("/accounts", view, (req, res) =>
  res.json(db.prepare(`SELECT a.*, pr.name, pr.followers, pr.last_seen FROM accounts a LEFT JOIN profiles pr ON pr.handle = a.handle
      WHERE a.workspace_id = ? ORDER BY a.kind DESC, a.id`).all(req.ws.id)));

ws.post("/accounts", edit, (req, res) => {
  const handle = cleanHandle(req.body?.handle);
  const kind = req.body?.kind === "own" ? "own" : "competitor";
  if (!/^[A-Za-z0-9_.]{1,40}$/.test(handle)) return bad(res, "帳號格式不正確（例如 @shu.edu 或貼上個人頁網址）");
  try {
    db.prepare("INSERT INTO accounts (workspace_id, handle, label, kind, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)")
      .run(req.ws.id, handle, String(req.body?.label || "").trim() || null, kind, now());
  } catch { return bad(res, "這個帳號已經在監測清單裡"); }
  res.json({ ok: true });
});

ws.patch("/accounts/:id", edit, (req, res) => {
  const a = db.prepare("SELECT * FROM accounts WHERE id = ? AND workspace_id = ?").get(Number(req.params.id), req.ws.id);
  if (!a) return bad(res, "找不到帳號", 404);
  const kind = ["own", "competitor"].includes(req.body?.kind) ? req.body.kind : a.kind;
  const enabled = req.body?.enabled != null ? (req.body.enabled ? 1 : 0) : a.enabled;
  const label = req.body?.label != null ? String(req.body.label).trim() || null : a.label;
  db.prepare("UPDATE accounts SET kind = ?, enabled = ?, label = ? WHERE id = ?").run(kind, enabled, label, a.id);
  res.json({ ok: true });
});

ws.delete("/accounts/:id", edit, (req, res) => {
  db.prepare("DELETE FROM accounts WHERE id = ? AND workspace_id = ?").run(Number(req.params.id), req.ws.id);
  res.json({ ok: true });
});

ws.post("/crawl", edit, (req, res) => {
  const r = startCrawl("manual", req.user.display_name || req.user.username);
  if (!r.ok) return bad(res, r.error, 409);
  res.json({ ok: true, runId: r.runId });
});

// 立即爬文：只抓這個工作區、近 N 小時發布、還沒抓過的貼文
const hoursOf = (v) => Math.min(Math.max(Math.round(Number(v)) || 6, 1), 48);
ws.post("/quick-crawl", edit, (req, res) => {
  const r = startCrawl("quick", req.user.display_name || req.user.username,
    { hours: hoursOf(req.body?.hours), wsId: req.ws.id, visit: req.body?.visit !== false });
  if (!r.ok) return bad(res, r.error, 409);
  res.json({ ok: true, runId: r.runId });
});

// 立即爬文頁：近 N 小時的貼文 ＋ 這個工作區最近一次立即爬文新收了哪些
ws.get("/recent", view, (req, res) => {
  const hours = hoursOf(req.query.hours);
  const last = db.prepare(`SELECT id, started_by, started_at, finished_at, status, window_hours, logged_out, posts_new, posts_skipped,
      posts_visited, comments_found, error, new_codes FROM runs WHERE trigger = 'quick' AND workspace_id = ? ORDER BY id DESC LIMIT 1`).get(req.ws.id);
  if (last) last.new_codes = JSON.parse(last.new_codes || "[]");
  res.json({ hours, posts: A.postsList(req.ws.id, { hours, sort: "newest", limit: 500 }), last_run: last || null });
});

ws.get("/runs", view, (req, res) =>
  res.json(db.prepare("SELECT id, trigger, started_by, started_at, finished_at, status, window_hours, logged_out, posts_found, posts_new, posts_skipped, posts_visited, profiles_seen, comments_found, comments_new, error FROM runs ORDER BY id DESC LIMIT 30").all()));

ws.get("/runs/:id/log", view, (req, res) => {
  const r = db.prepare("SELECT log FROM runs WHERE id = ?").get(Number(req.params.id));
  res.json({ log: r?.log || "" });
});

// ── 後台：成員（admin）────────────────────────────────────────────────
ws.get("/members", admin, (req, res) =>
  res.json(db.prepare(`SELECT u.id, u.username, u.display_name, u.is_owner, m.role FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ? ORDER BY u.id`).all(req.ws.id)));

// 帳號不存在就建一個（由管理員設定初始密碼，成員登入後可自行修改）
ws.post("/members", admin, (req, res) => {
  const { username, display_name, password } = req.body || {};
  const role = ["admin", "editor", "viewer"].includes(req.body?.role) ? req.body.role : "viewer";
  let u = db.prepare("SELECT * FROM users WHERE username = ?").get(String(username || ""));
  if (!u) {
    const err = validateCredentials(username, password);
    if (err) return bad(res, err);
    u = { id: createUser({ username, display_name, password }) };
  }
  db.prepare("INSERT INTO memberships (user_id, workspace_id, role) VALUES (?, ?, ?) ON CONFLICT(user_id, workspace_id) DO UPDATE SET role = excluded.role")
    .run(u.id, req.ws.id, role);
  res.json({ ok: true });
});

ws.patch("/members/:uid", admin, (req, res) => {
  const role = req.body?.role;
  if (!["admin", "editor", "viewer"].includes(role)) return bad(res, "角色不正確");
  db.prepare("UPDATE memberships SET role = ? WHERE user_id = ? AND workspace_id = ?").run(role, Number(req.params.uid), req.ws.id);
  res.json({ ok: true });
});

ws.delete("/members/:uid", admin, (req, res) => {
  if (Number(req.params.uid) === req.user.id) return bad(res, "不能把自己移出工作區");
  db.prepare("DELETE FROM memberships WHERE user_id = ? AND workspace_id = ?").run(Number(req.params.uid), req.ws.id);
  res.json({ ok: true });
});

ws.patch("/", admin, (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return bad(res, "請輸入工作區名稱");
  db.prepare("UPDATE workspaces SET name = ? WHERE id = ?").run(name, req.ws.id);
  res.json({ ok: true });
});

app.use("/api/ws", ws);

// ── 抓取狀態（所有登入者都能看）──────────────────────────────────────
app.get("/api/crawl/status", requireUser, (req, res) =>
  res.json({ running: crawlState.running, runId: crawlState.runId, trigger: crawlState.trigger, hours: crawlState.hours,
    startedAt: crawlState.startedAt, log: crawlState.log.slice(-80), next: nextRunAt() }));

// ── 系統（只有擁有者）────────────────────────────────────────────────
const sys = express.Router();
sys.use(requireUser, requireOwner);

sys.get("/settings", (req, res) => res.json(getRawSettings()));
sys.put("/settings", (req, res) => {
  const b = req.body || {};
  if (b.schedule_times != null && !String(b.schedule_times).split(/[,，\s]+/).filter(Boolean).every((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)))
    return bad(res, "排程時間格式要像 10:30，多個用逗號分隔");
  for (const k of ["track_days", "max_post_visits", "profile_scrolls"]) {
    if (b[k] != null && !(Number(b[k]) >= 1 && Number(b[k]) <= 100)) return bad(res, `${k} 需介於 1–100`);
  }
  setSettings(b);
  res.json({ ok: true });
});
sys.post("/reanalyze", (req, res) => res.json(reanalyzeAll()));

sys.get("/workspaces", (req, res) =>
  res.json(db.prepare(`SELECT w.*, (SELECT COUNT(*) FROM memberships m WHERE m.workspace_id = w.id) AS members,
      (SELECT COUNT(*) FROM topics t WHERE t.workspace_id = w.id) AS topics,
      (SELECT COUNT(*) FROM accounts a WHERE a.workspace_id = w.id) AS accounts FROM workspaces w ORDER BY w.id`).all()));
sys.post("/workspaces", (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return bad(res, "請輸入工作區名稱");
  res.json({ ok: true, id: createWorkspace(name, req.user.id) });
});
sys.delete("/workspaces/:id", (req, res) => {
  if (db.prepare("SELECT COUNT(*) AS n FROM workspaces").get().n <= 1) return bad(res, "至少要保留一個工作區");
  db.prepare("DELETE FROM workspaces WHERE id = ?").run(Number(req.params.id));
  res.json({ ok: true });
});

sys.get("/users", (req, res) =>
  res.json(db.prepare(`SELECT u.id, u.username, u.display_name, u.is_owner, u.created_at,
      (SELECT group_concat(w.name || '（' || m.role || '）', '、') FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = u.id) AS workspaces
      FROM users u ORDER BY u.id`).all()));
sys.post("/users/:id/password", (req, res) => {
  if (String(req.body?.password || "").length < 8) return bad(res, "密碼至少 8 個字元");
  setPassword(Number(req.params.id), req.body.password);
  res.json({ ok: true });
});
sys.delete("/users/:id", (req, res) => {
  if (Number(req.params.id) === req.user.id) return bad(res, "不能刪除自己");
  db.prepare("DELETE FROM users WHERE id = ?").run(Number(req.params.id));
  res.json({ ok: true });
});

app.use("/api/system", sys);

app.use("/api", (req, res) => bad(res, "找不到這個 API", 404));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "伺服器錯誤：" + err.message });
});

app.listen(PORT, HOST, () => {
  console.log(`Threads 監測系統已啟動：http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  if (needsSetup()) console.log("第一次使用：打開上面的網址建立管理員帳號");
  startScheduler();
});
