// ── 資料庫：Node 內建 SQLite，檔案在 data/threads.db ──────────────────
// 貼文、留言、帳號資料是全域共用（同一篇貼文可能被多個工作區的主題抓到）；
// 主題、監測帳號、成員則屬於各自的工作區。
import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, "..");
// TM_DATA_DIR 可指定另一個資料夾（例如測試用），預設是專案下的 data/
export const DATA_DIR = process.env.TM_DATA_DIR ? path.resolve(process.env.TM_DATA_DIR) : path.join(ROOT, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, "threads.db"));
export const now = () => new Date().toISOString();

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── 團隊 ──
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT NOT NULL UNIQUE,
  display_name TEXT,
  pass_salt    TEXT NOT NULL,
  pass_hash    TEXT NOT NULL,
  is_owner     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- role: admin 管理成員與設定 / editor 管理主題、帳號、觸發抓取 / viewer 只能看
CREATE TABLE IF NOT EXISTS memberships (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  PRIMARY KEY (user_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- ── 監測項目（屬於工作區）──
-- type: keyword 內文含關鍵字 / hashtag 主題標籤（Threads 帳號下方那一行主題，或內文 #標籤）
CREATE TABLE IF NOT EXISTS topics (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN ('keyword', 'hashtag')),
  term         TEXT NOT NULL,
  max_days     INTEGER NOT NULL DEFAULT 3,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  UNIQUE (workspace_id, type, term)
);

-- kind: own 自己的帳號 / competitor 競品
CREATE TABLE IF NOT EXISTS accounts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  handle       TEXT NOT NULL,
  label        TEXT,
  kind         TEXT NOT NULL CHECK (kind IN ('own', 'competitor')),
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  UNIQUE (workspace_id, handle)
);

-- ── 抓回來的資料（全域）──
CREATE TABLE IF NOT EXISTS profiles (
  handle     TEXT PRIMARY KEY,
  name       TEXT,
  bio        TEXT,
  followers  INTEGER,
  last_seen  TEXT
);

CREATE TABLE IF NOT EXISTS profile_snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  handle      TEXT NOT NULL,
  run_id      INTEGER,
  captured_at TEXT NOT NULL,
  followers   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_profile_snap ON profile_snapshots(handle, captured_at);

-- likes/replies/reposts/shares/views 是最近一次抓到的值；歷史值在 post_metrics
-- author 一律存成不含 @ 的 handle；visited_at 是點進貼文頁抓過留言的時間
CREATE TABLE IF NOT EXISTS posts (
  code            TEXT PRIMARY KEY,
  author          TEXT,
  topic_tag       TEXT,
  content         TEXT,
  media_type      TEXT,
  posted_at       TEXT,
  url             TEXT,
  first_seen      TEXT,
  last_seen       TEXT,
  visited_at      TEXT,
  likes           INTEGER DEFAULT 0,
  replies         INTEGER DEFAULT 0,
  reposts         INTEGER DEFAULT 0,
  shares          INTEGER DEFAULT 0,
  views           INTEGER,
  sentiment       TEXT,
  sentiment_score INTEGER,
  neg_hits        TEXT DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author, posted_at);
CREATE INDEX IF NOT EXISTS idx_posts_time ON posts(posted_at);

CREATE TABLE IF NOT EXISTS post_topics (
  post_code TEXT NOT NULL REFERENCES posts(code) ON DELETE CASCADE,
  topic_id  INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  PRIMARY KEY (post_code, topic_id)
);
CREATE INDEX IF NOT EXISTS idx_post_topics_topic ON post_topics(topic_id);

CREATE TABLE IF NOT EXISTS post_metrics (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  post_code   TEXT NOT NULL REFERENCES posts(code) ON DELETE CASCADE,
  run_id      INTEGER,
  captured_at TEXT NOT NULL,
  likes       INTEGER,
  replies     INTEGER,
  reposts     INTEGER,
  shares      INTEGER,
  views       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_metrics_post ON post_metrics(post_code, captured_at);

CREATE TABLE IF NOT EXISTS comments (
  code            TEXT PRIMARY KEY,
  post_code       TEXT NOT NULL REFERENCES posts(code) ON DELETE CASCADE,
  author          TEXT,
  content         TEXT,
  posted_at       TEXT,
  likes           INTEGER DEFAULT 0,
  replies         INTEGER DEFAULT 0,
  author_liked    INTEGER DEFAULT 0,
  sentiment       TEXT,
  sentiment_score INTEGER,
  neg_hits        TEXT DEFAULT '[]',
  first_seen      TEXT,
  last_seen       TEXT
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_code);

CREATE TABLE IF NOT EXISTS runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger        TEXT,
  started_by     TEXT,
  started_at     TEXT,
  finished_at    TEXT,
  status         TEXT,
  logged_out     INTEGER DEFAULT 0,
  posts_found    INTEGER DEFAULT 0,
  posts_new      INTEGER DEFAULT 0,
  posts_skipped  INTEGER DEFAULT 0,
  posts_visited  INTEGER DEFAULT 0,
  profiles_seen  INTEGER DEFAULT 0,
  comments_found INTEGER DEFAULT 0,
  comments_new   INTEGER DEFAULT 0,
  error          TEXT,
  log            TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`);

// ── 舊資料庫補欄位 ──────────────────────────────────────────────────
function addColumn(table, column, type, backfill) {
  if (db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  if (backfill) db.exec(backfill);
}
// 有留言或瀏覽數的貼文，代表之前已經點進去抓過
addColumn("posts", "visited_at", "TEXT",
  "UPDATE posts SET visited_at = last_seen WHERE views IS NOT NULL OR code IN (SELECT DISTINCT post_code FROM comments)");
addColumn("runs", "posts_skipped", "INTEGER DEFAULT 0");
// 立即爬文：時間窗（小時）、發起的工作區、這次新收的貼文代碼（JSON 陣列）
addColumn("runs", "window_hours", "INTEGER");
addColumn("runs", "workspace_id", "INTEGER");
addColumn("runs", "new_codes", "TEXT");

// ── 系統設定（全域，只有系統擁有者能改）：全部存成字串 ──────────────
const DEFAULTS = {
  schedule_enabled: "1",
  schedule_times: "10:30",
  track_days: "7",
  max_post_visits: "20",
  profile_scrolls: "4",
  // 0：抓過的貼文不再重抓（預設）；1：每次都回頭更新舊貼文的互動數與留言，才畫得出成長曲線
  revisit_old: "0",
  headless: "0",
  browser_channel: "chrome",
  neg_keywords:
    "性騷,性侵,偷拍,霸凌,歧視,爆料,申訴,抗議,停招,退場,詐騙,漏水,竊盜,超收,提告,地檢署,黑箱,欠薪,資遣,裁員,性平",
  pos_words:
    "讚,好棒,厲害,羨慕,喜歡,愛,推,感謝,謝謝,開心,幸福,優秀,支持,方便,舒服,好爽,太好,好看,好吃,屌,驕傲,期待,可愛,加油",
  neg_words:
    "爛,垃圾,白繳,生氣,失望,糟糕,噁心,靠北,可惡,誇張,不爽,難過,傻眼,無言,離譜,擺爛,抱怨,不公平,黑心,毒,丟臉,坑,可憐,不合理",
};

const insertDefault = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
for (const [k, v] of Object.entries(DEFAULTS)) insertDefault.run(k, v);

export const splitList = (s) =>
  String(s || "")
    .split(/[,，、\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

export function getRawSettings() {
  const out = {};
  for (const r of db.prepare("SELECT key, value FROM settings").all()) out[r.key] = r.value;
  return out;
}

export function getSettings() {
  const r = getRawSettings();
  return {
    schedule_enabled: r.schedule_enabled === "1",
    schedule_times: splitList(r.schedule_times),
    track_days: Number(r.track_days) || 7,
    max_post_visits: Number(r.max_post_visits) || 20,
    profile_scrolls: Number(r.profile_scrolls) || 4,
    revisit_old: r.revisit_old === "1",
    headless: r.headless === "1",
    browser_channel: r.browser_channel || "chrome",
    neg_keywords: splitList(r.neg_keywords),
    pos_words: splitList(r.pos_words),
    neg_words: splitList(r.neg_words),
  };
}

export function setSettings(obj) {
  const up = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  for (const [k, v] of Object.entries(obj)) {
    if (!(k in DEFAULTS)) continue;
    up.run(k, String(v));
  }
}

// 建立工作區時放一個預設主題，第一次登入就有東西可抓
export function createWorkspace(name, ownerUserId) {
  const ws = db.prepare("INSERT INTO workspaces (name, created_at) VALUES (?, ?)").run(name, now());
  const wsId = Number(ws.lastInsertRowid);
  if (ownerUserId) db.prepare("INSERT INTO memberships (user_id, workspace_id, role) VALUES (?, ?, 'admin')").run(ownerUserId, wsId);
  return wsId;
}

// 多步寫入包成一個交易
export function tx(fn) {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
