// ── 角色權限：每個角色能看哪些選單、選單裡哪些區塊，以及操作層級 ─────────────
// 選單用「允許清單」：勾了才看得到，之後新增的選單預設不開放給自訂角色。
// 區塊用「隱藏清單」：預設都顯示，取消勾選才隱藏，之後新增的區塊預設會出現。
// 操作層級沿用 viewer／editor／admin：決定能不能改主題帳號、觸發抓取、管理成員。
// 系統擁有者不受角色限制；「角色權限」「系統設定」兩頁只有系統擁有者能進。
import { db, now } from "./db.js";

export const MENUS = [
  { key: "overview", label: "總覽", group: "前台", blocks: [
    ["overview.kpi", "指標卡"], ["overview.charts", "每日新貼文與留言情緒圖"], ["overview.top_posts", "互動最高的貼文"],
    ["overview.flagged", "需要注意的留言"], ["overview.neg_keywords", "負面關鍵字出現次數"], ["overview.last_run", "最近一次抓取"]] },
  { key: "negative", label: "負面留言板", group: "前台", blocks: [
    ["negative.kpi", "指標卡"], ["negative.signals", "最常出現的負面訊號"], ["negative.list", "負面留言列表"], ["negative.csv", "下載 CSV"]] },
  { key: "topics", label: "主題監測", group: "前台", blocks: [
    ["topics.ranking", "主題熱度排名"], ["topics.trend", "熱度趨勢圖"], ["topics.hot", "主題熱門貼文"]] },
  { key: "compare", label: "主題交叉比較", group: "前台", blocks: [
    ["compare.daily", "每日提及數與互動數圖"], ["compare.dist", "互動分布"], ["compare.table", "數字對照"]] },
  { key: "posts", label: "貼文成效", group: "前台", blocks: [
    ["posts.compare", "貼文互動比較"], ["posts.list", "全部串文成效"], ["posts.csv", "下載 CSV"]] },
  { key: "views", label: "瀏覽分析", group: "前台", blocks: [
    ["views.kpi", "指標卡"], ["views.scatter", "瀏覽 × 互動圖"], ["views.table", "各貼文曝光判斷"]] },
  { key: "accounts", label: "帳號比較", group: "前台", blocks: [
    ["accounts.summary", "帳號總覽"], ["accounts.growth", "粉絲成長速度"], ["accounts.compare", "一對一比較"]] },
  { key: "times", label: "最佳發文時段", group: "前台", blocks: [
    ["times.heatmap", "星期 × 時段熱力圖"], ["times.recommend", "建議發文時段"]] },
  { key: "patterns", label: "內容成功模式", group: "前台", blocks: [
    ["patterns.insights", "高成效貼文的共同點"], ["patterns.features", "特徵比較與常見詞"], ["patterns.examples", "高成效範例"]] },
  { key: "manage", label: "監測設定", group: "後台", blocks: [["manage.topics", "主題監測"], ["manage.accounts", "帳號監測"]] },
  { key: "quick", label: "立即爬文", group: "後台", blocks: [["quick.run", "立即爬文操作"], ["quick.latest", "最新 10 篇貼文"]] },
  { key: "crawl", label: "抓取與排程", group: "後台", blocks: [["crawl.run", "立即抓取與即時紀錄"], ["crawl.latest", "最新 10 篇貼文"], ["crawl.runs", "抓取紀錄"]] },
  { key: "members", label: "成員", group: "後台", blocks: [], note: "需要「管理」操作層級" },
];
export const GLOBAL_BLOCKS = [["global.export", "右上角「匯出 Excel 報表」"]];

const MENU_KEYS = MENUS.map((m) => m.key);
const BLOCK_KEYS = new Set([...MENUS.flatMap((m) => m.blocks.map(([k]) => k)), ...GLOBAL_BLOCKS.map(([k]) => k)]);
const LEVELS = ["viewer", "editor", "admin"];
export const LEVEL_NAME = { admin: "管理", editor: "編輯", viewer: "檢視" };

// ── 資料表與預設角色 ──────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS roles (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  level         TEXT NOT NULL CHECK (level IN ('admin', 'editor', 'viewer')),
  menus         TEXT NOT NULL DEFAULT '[]',
  hidden_blocks TEXT NOT NULL DEFAULT '[]',
  builtin       TEXT,
  created_at    TEXT NOT NULL
);
`);
if (!db.prepare("PRAGMA table_info(memberships)").all().some((c) => c.name === "role_id")) {
  db.exec("ALTER TABLE memberships ADD COLUMN role_id INTEGER");
}

// 三個預設角色對應原本的管理員／編輯／檢視者，看得到的選單跟改版前一樣
const DEFAULTS = [
  { builtin: "admin", name: "管理員", level: "admin", menus: MENU_KEYS },
  { builtin: "editor", name: "編輯", level: "editor", menus: MENU_KEYS.filter((k) => k !== "members") },
  { builtin: "viewer", name: "檢視者", level: "viewer", menus: MENU_KEYS.filter((k) => k !== "members") },
];
for (const d of DEFAULTS) {
  if (db.prepare("SELECT 1 FROM roles WHERE builtin = ?").get(d.builtin)) continue;
  const name = db.prepare("SELECT 1 FROM roles WHERE name = ?").get(d.name) ? `${d.name}（預設）` : d.name;
  db.prepare("INSERT INTO roles (name, level, menus, hidden_blocks, builtin, created_at) VALUES (?, ?, ?, '[]', ?, ?)")
    .run(name, d.level, JSON.stringify(d.menus), d.builtin, now());
}
db.exec(`UPDATE memberships SET role_id = (SELECT id FROM roles WHERE roles.builtin = memberships.role) WHERE role_id IS NULL`);

// ── 權限解析 ─────────────────────────────────────────────────────────
const parse = (s) => { try { return JSON.parse(s || "[]"); } catch { return []; } };

// 回傳 { level, role_id, role_name, menus, hidden, owner }；不是這個工作區的成員回傳 null
export function permsFor(user, wsId) {
  if (user.is_owner) return { level: "admin", role_id: null, role_name: "系統擁有者", menus: MENU_KEYS, hidden: [], owner: true };
  const m = db.prepare(`SELECT m.role AS legacy, r.id AS rid, r.name, r.level, r.menus, r.hidden_blocks
      FROM memberships m LEFT JOIN roles r ON r.id = m.role_id WHERE m.user_id = ? AND m.workspace_id = ?`).get(user.id, wsId);
  if (!m) return null;
  if (!m.rid) {
    const d = DEFAULTS.find((x) => x.builtin === m.legacy) || DEFAULTS[2];
    return { level: d.level, role_id: null, role_name: d.name, menus: d.menus, hidden: [], owner: false };
  }
  // 「成員」頁只有管理層級能用，就算勾了也不開放
  const menus = parse(m.menus).filter((k) => k !== "members" || m.level === "admin");
  return { level: m.level, role_id: m.rid, role_name: m.name, menus, hidden: parse(m.hidden_blocks), owner: false };
}

// ── express middleware：需要其中任一選單／不能被隱藏的區塊 ─────────────────
export const needMenu = (...keys) => (req, res, next) => {
  const p = req.ws?.perms;
  if (!p || p.owner || keys.some((k) => p.menus.includes(k))) return next();
  res.status(403).json({ error: "你的角色沒有這個頁面的權限" });
};
export const needBlock = (key) => (req, res, next) => {
  const p = req.ws?.perms;
  if (!p || p.owner || !p.hidden.includes(key)) return next();
  res.status(403).json({ error: "你的角色沒有這個功能的權限" });
};

// ── 角色管理 ─────────────────────────────────────────────────────────
export const registry = () => ({ menus: MENUS, global: GLOBAL_BLOCKS, levels: LEVEL_NAME });

export function listRoles() {
  return db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM memberships m WHERE m.role_id = r.id) AS members FROM roles r
      ORDER BY r.builtin IS NULL, CASE r.builtin WHEN 'admin' THEN 1 WHEN 'editor' THEN 2 WHEN 'viewer' THEN 3 END, r.id`).all()
    .map((r) => ({ ...r, menus: parse(r.menus), hidden_blocks: parse(r.hidden_blocks) }));
}

export const getRole = (id) => db.prepare("SELECT * FROM roles WHERE id = ?").get(Number(id)) || null;

// 回傳錯誤訊息字串；成功回傳 { id }
export function saveRole(id, body = {}) {
  const name = String(body.name || "").trim();
  if (!name || name.length > 30) return { error: "角色名稱需為 1–30 字" };
  const level = LEVELS.includes(body.level) ? body.level : null;
  if (!level) return { error: "操作層級不正確" };
  const menus = [...new Set((Array.isArray(body.menus) ? body.menus : []).filter((k) => MENU_KEYS.includes(k)))];
  if (!menus.length) return { error: "至少要勾一個選單" };
  const hidden = [...new Set((Array.isArray(body.hidden_blocks) ? body.hidden_blocks : []).filter((k) => BLOCK_KEYS.has(k)))];
  const dup = db.prepare("SELECT id FROM roles WHERE name = ?").get(name);
  if (dup && dup.id !== Number(id)) return { error: "已經有同名的角色" };

  if (id) {
    const r = getRole(id);
    if (!r) return { error: "找不到角色" };
    if (r.builtin === "admin" && level !== "admin") return { error: "預設的「管理員」角色必須維持管理層級" };
    db.prepare("UPDATE roles SET name = ?, level = ?, menus = ?, hidden_blocks = ? WHERE id = ?")
      .run(name, level, JSON.stringify(menus), JSON.stringify(hidden), r.id);
    db.prepare("UPDATE memberships SET role = ? WHERE role_id = ?").run(level, r.id); // 舊欄位跟著同步
    return { id: r.id };
  }
  const ins = db.prepare("INSERT INTO roles (name, level, menus, hidden_blocks, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(name, level, JSON.stringify(menus), JSON.stringify(hidden), now());
  return { id: Number(ins.lastInsertRowid) };
}

export function deleteRole(id) {
  const r = getRole(id);
  if (!r) return { error: "找不到角色" };
  if (r.builtin) return { error: "預設角色不能刪除" };
  const n = db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE role_id = ?").get(r.id).n;
  if (n) return { error: `還有 ${n} 位成員使用這個角色，請先改成其他角色` };
  db.prepare("DELETE FROM roles WHERE id = ?").run(r.id);
  return { ok: true };
}

// 指派角色時同時寫 role（舊欄位，存層級）與 role_id
export function assignRole(userId, wsId, roleId) {
  const r = getRole(roleId);
  if (!r) return { error: "角色不存在" };
  db.prepare(`INSERT INTO memberships (user_id, workspace_id, role, role_id) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, workspace_id) DO UPDATE SET role = excluded.role, role_id = excluded.role_id`).run(userId, wsId, r.level, r.id);
  return { ok: true };
}

export const builtinRoleId = (level) => db.prepare("SELECT id FROM roles WHERE builtin = ?").get(level)?.id;
