// ── 登入、session、工作區權限 ─────────────────────────────────────────
import crypto from "crypto";
import { db, now } from "./db.js";

const SESSION_DAYS = 14;
export const COOKIE = "tm_session";
const ROLE_RANK = { viewer: 1, editor: 2, admin: 3 };

export function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 64).toString("hex") };
}

export function verifyPassword(password, salt, hash) {
  const a = crypto.scryptSync(String(password), salt, 64);
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const needsSetup = () => !db.prepare("SELECT 1 FROM users LIMIT 1").get();

export function validateCredentials(username, password) {
  if (!/^[A-Za-z0-9_.@-]{3,40}$/.test(String(username || ""))) return "帳號需為 3–40 個英數字（可含 _ . @ -）";
  if (String(password || "").length < 8) return "密碼至少 8 個字元";
  return null;
}

export function createUser({ username, display_name, password, is_owner = 0 }) {
  const { salt, hash } = hashPassword(password);
  const r = db.prepare("INSERT INTO users (username, display_name, pass_salt, pass_hash, is_owner, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(username, display_name || username, salt, hash, is_owner ? 1 : 0, now());
  return Number(r.lastInsertRowid);
}

export function setPassword(userId, password) {
  const { salt, hash } = hashPassword(password);
  db.prepare("UPDATE users SET pass_salt = ?, pass_hash = ? WHERE id = ?").run(salt, hash, userId);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

// 簡單的暴力破解防護：同一帳號連錯 5 次鎖 5 分鐘
const failures = new Map();
export function checkLogin(username, password) {
  const f = failures.get(username);
  if (f && f.count >= 5 && Date.now() - f.last < 5 * 60000) return { error: "密碼錯誤次數過多，請 5 分鐘後再試" };
  const u = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!u || !verifyPassword(password, u.pass_salt, u.pass_hash)) {
    failures.set(username, { count: (f?.count || 0) + 1, last: Date.now() });
    return { error: "帳號或密碼錯誤" };
  }
  failures.delete(username);
  return { user: u };
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(token, userId, now(), expires);
  return { token, maxAge: SESSION_DAYS * 86400 };
}

export function destroySession(token) {
  if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const sessionToken = (req) => parseCookies(req.headers.cookie)[COOKIE];

export function sessionUser(req) {
  const token = sessionToken(req);
  if (!token) return null;
  const row = db.prepare(`SELECT u.id, u.username, u.display_name, u.is_owner, s.expires_at
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(token);
  if (!row) return null;
  if (row.expires_at < now()) { destroySession(token); return null; }
  return { id: row.id, username: row.username, display_name: row.display_name, is_owner: !!row.is_owner };
}

export function userWorkspaces(user) {
  if (user.is_owner) {
    return db.prepare(`SELECT w.id, w.name, COALESCE(m.role, 'admin') AS role FROM workspaces w
        LEFT JOIN memberships m ON m.workspace_id = w.id AND m.user_id = ? ORDER BY w.id`).all(user.id)
      .map((w) => ({ ...w, role: "admin" }));
  }
  return db.prepare(`SELECT w.id, w.name, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = ? ORDER BY w.id`).all(user.id);
}

// ── express middleware ────────────────────────────────────────────────
export function requireUser(req, res, next) {
  const user = sessionUser(req);
  if (!user) return res.status(401).json({ error: "請先登入", setup: needsSetup() });
  req.user = user;
  next();
}

export function requireOwner(req, res, next) {
  if (!req.user?.is_owner) return res.status(403).json({ error: "只有系統擁有者可以操作" });
  next();
}

// 工作區由 X-Workspace 標頭（或 ?ws=）指定；系統擁有者對所有工作區都是 admin
export function withWorkspace(minRole = "viewer") {
  return (req, res, next) => {
    const wsId = Number(req.headers["x-workspace"] || req.query.ws);
    if (!wsId) return res.status(400).json({ error: "缺少工作區" });
    const ws = db.prepare("SELECT id, name FROM workspaces WHERE id = ?").get(wsId);
    if (!ws) return res.status(404).json({ error: "工作區不存在" });
    let role = req.user.is_owner ? "admin" : db.prepare("SELECT role FROM memberships WHERE user_id = ? AND workspace_id = ?").get(req.user.id, wsId)?.role;
    if (!role) return res.status(403).json({ error: "你不是這個工作區的成員" });
    if (ROLE_RANK[role] < ROLE_RANK[minRole]) return res.status(403).json({ error: `需要「${minRole}」以上權限` });
    req.ws = { id: ws.id, name: ws.name, role };
    next();
  };
}

export const roleAtLeast = (role, min) => ROLE_RANK[role] >= ROLE_RANK[min];
