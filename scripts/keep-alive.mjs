// ── 看門狗：讓伺服器與 Cloudflare 臨時通道一直活著 ─────────────────────
// 每 30 秒檢查一次：
//   1. http://127.0.0.1:<PORT> 沒回應 → 重新啟動伺服器
//   2. 公開網址沒回應 → 重開通道，取得新網址
// 檢查公開網址時「不使用本機 DNS」：先用 1.1.1.1／8.8.8.8 解析，再直接連那個 IP（帶 SNI）。
// 因為校園等網路可能不解析 *.trycloudflare.com，用本機 DNS 會誤判成掛掉、每次都重開、網址一直換。
// 連公共 DNS 都查不到時，只看通道程序在不在，不重開。
// 公開網址寫在 data/logs/current_url.txt；只會動自己啟動的程序（PID 記在 data/logs/keepalive.json）。
//   node scripts/keep-alive.mjs          常駐執行
//   node scripts/keep-alive.mjs --once   只檢查一次
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import https from "https";
import { Resolver } from "dns";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = process.env.TM_DATA_DIR ? path.resolve(process.env.TM_DATA_DIR) : path.join(ROOT, "data");
const LOGS = path.join(DATA, "logs");
const STATE_FILE = path.join(LOGS, "keepalive.json");
const URL_FILE = path.join(LOGS, "current_url.txt");
const TUNNEL_LOG = path.join(LOGS, "cloudflared.log");
const PORT = Number(process.env.PORT || 3900);
const LOCAL = `http://127.0.0.1:${PORT}/api/setup-status`;
const CHECK_MS = 30000;
const ONCE = process.argv.includes("--once");
const CLOUDFLARED = process.env.CLOUDFLARED_PATH || "C:/Program Files (x86)/cloudflared/cloudflared.exe";
const PUBLIC_DNS = ["1.1.1.1", "8.8.8.8"];

fs.mkdirSync(LOGS, { recursive: true });
const stamp = () => new Date().toLocaleString("sv-SE", { timeZone: "Asia/Taipei" }).slice(0, 19);
function log(msg) {
  const line = `[${stamp()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(LOGS, "keepalive.log"), line + "\n");
}

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; } };
const writeState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), "utf8");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function localOk() {
  try { return (await fetch(LOCAL, { signal: AbortSignal.timeout(8000) })).ok; } catch { return false; }
}

// 用公共 DNS 解析，避開本機／校園 DNS 的封鎖
function resolvePublic(host) {
  return new Promise((resolve) => {
    const r = new Resolver();
    r.setServers(PUBLIC_DNS);
    r.resolve4(host, (err, addrs) => resolve(err || !addrs?.length ? [] : addrs));
  });
}

// true 正常／false 連不上／null 無法判斷（DNS 查不到）
async function publicOk(url) {
  let host;
  try { host = new URL(url).hostname; } catch { return false; }
  const ips = await resolvePublic(host);
  if (!ips.length) return null;
  return await new Promise((resolve) => {
    const req = https.request(
      { host: ips[0], servername: host, path: "/api/setup-status", headers: { Host: host }, timeout: 12000 },
      (res) => { res.resume(); resolve(res.statusCode > 0 && res.statusCode < 500); });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function startServer(state) {
  const out = fs.openSync(path.join(LOGS, "server.out.log"), "a");
  const err = fs.openSync(path.join(LOGS, "server.err.log"), "a");
  const p = spawn(process.execPath, ["--no-warnings", path.join(ROOT, "server", "index.js")],
    { cwd: ROOT, detached: true, stdio: ["ignore", out, err], windowsHide: true });
  p.unref();
  state.serverPid = p.pid;
  log(`伺服器已啟動（PID ${p.pid}）`);
}

async function startTunnel(state) {
  if (state.tunnelPid && alive(state.tunnelPid)) {
    try { process.kill(state.tunnelPid); log(`關掉沒回應的通道（PID ${state.tunnelPid}）`); } catch {}
    await sleep(1500);
  }
  if (fs.existsSync(TUNNEL_LOG)) fs.renameSync(TUNNEL_LOG, path.join(LOGS, "cloudflared.prev.log"));
  const p = spawn(CLOUDFLARED, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${PORT}`, "--logfile", TUNNEL_LOG],
    { detached: true, stdio: "ignore", windowsHide: true });
  p.unref();
  state.tunnelPid = p.pid;

  let url = null;
  for (let i = 0; i < 30 && !url; i++) {
    await sleep(2000);
    try { url = (fs.readFileSync(TUNNEL_LOG, "utf8").match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/) || [])[0] || null; } catch {}
  }
  if (!url) { log("通道啟動了，但讀不到網址"); return; }
  state.url = url;
  for (let i = 0; i < 20; i++) { if ((await publicOk(url)) !== false) break; await sleep(5000); }
  fs.writeFileSync(URL_FILE, `${url}\n更新時間：${stamp()}\n`, "utf8");
  log(`公開網址：${url}`);
}

// 通道程序不在就重開；讀得到網址就順便補寫 state
function adoptTunnel(state) {
  if (state.tunnelPid && alive(state.tunnelPid)) return true;
  try {
    const m = fs.readFileSync(TUNNEL_LOG, "utf8").match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) state.url = m[0];
  } catch {}
  return false;
}

async function check() {
  const state = readState();
  if (!(await localOk())) {
    log("伺服器沒有回應");
    startServer(state);
    await sleep(4000);
    if (!(await localOk())) log("伺服器重啟後仍無回應，看 data/logs/server.err.log");
  }

  const verdict = state.url ? await publicOk(state.url) : false;
  if (verdict === true) {
    // 正常，順手確認網址檔是最新的
    try { if (!fs.readFileSync(URL_FILE, "utf8").startsWith(state.url)) fs.writeFileSync(URL_FILE, `${state.url}\n更新時間：${stamp()}\n`, "utf8"); }
    catch { fs.writeFileSync(URL_FILE, `${state.url}\n更新時間：${stamp()}\n`, "utf8"); }
  } else if (verdict === null) {
    // 公共 DNS 也查不到（網路異常或網址剛建立）：只看程序在不在，不要一直重開
    if (!adoptTunnel(state)) { log("通道程序不在，重新啟動"); await startTunnel(state); }
    else log(`暫時查不到網址，但通道程序還在（PID ${state.tunnelPid}），先不動`);
  } else {
    log(state.url ? `公開網址連不上：${state.url}` : "還沒有公開網址");
    await startTunnel(state);
  }
  state.checked_at = stamp();
  writeState(state);
}

log(ONCE ? "檢查一次" : `看門狗啟動（每 ${CHECK_MS / 1000} 秒檢查一次）`);
await check();
if (!ONCE) {
  while (true) {
    await sleep(CHECK_MS);
    try { await check(); } catch (e) { log("檢查失敗：" + e.message); }
  }
}
