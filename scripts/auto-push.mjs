// ── 每日自動推送到 GitHub ─────────────────────────────────────────────
// 由 Windows 工作排程器每天 17:00 執行：有變更就 commit，並推到 origin。
//   node scripts/auto-push.mjs            實際執行
//   node scripts/auto-push.mjs --dry-run  只檢查、不 commit 也不推
// 推送用的是 gh 已登入、且與 origin 擁有者同名的帳號憑證（例如 ymlin520），不會改 gh 的預設帳號。
// 紀錄寫在 data/logs/auto-push.log。
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DRY = process.argv.includes("--dry-run");
const LOG = path.join(ROOT, "data", "logs", "auto-push.log");
fs.mkdirSync(path.dirname(LOG), { recursive: true });

const stamp = () => new Date().toLocaleString("sv-SE", { timeZone: "Asia/Taipei" }).slice(0, 16);
function log(msg) {
  const line = `[${stamp()}]${DRY ? "[試跑]" : ""} ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG, line + "\n");
}
const run = (cmd, args, env) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", env: env || process.env });
  return { code: r.status, out: (r.stdout || "").trimEnd(), err: (r.stderr || r.error?.message || "").trim() };
};
const fail = (msg) => { log(msg); process.exit(1); };

const status = run("git", ["status", "--porcelain"]);
if (status.code !== 0) fail("git status 失敗：" + status.err);
const ahead = run("git", ["rev-list", "--count", "@{u}..HEAD"]);
const unpushed = ahead.code === 0 ? Number(ahead.out) : 0;
if (!status.out && !unpushed) { log("沒有變更，略過"); process.exit(0); }

// 推之前擋明顯的密鑰（追蹤中與未忽略的新檔都掃）
const secrets = run("git", ["grep", "-n", "-I", "--untracked", "-E",
  "github_pat_[A-Za-z0-9_]{20}|gh[opsu]_[A-Za-z0-9]{30}|sk-[A-Za-z0-9_-]{30}|-----BEGIN [A-Z ]*PRIVATE KEY-----"]);
if (secrets.code === 0) fail("疑似含有密鑰，停止推送：\n" + secrets.out);

if (status.out) {
  log(`待提交的變更：\n${status.out}`);
  if (!DRY) {
    const add = run("git", ["add", "-A"]);
    if (add.code !== 0) fail("git add 失敗：" + add.err);
    const commit = run("git", ["commit", "-m", `自動備份 ${stamp()}`]);
    if (commit.code !== 0) fail("git commit 失敗：" + (commit.err || commit.out));
    log(commit.out.split("\n")[0]);
  }
} else {
  log(`沒有新變更，但有 ${unpushed} 個 commit 還沒推`);
}

const remote = run("git", ["remote", "get-url", "origin"]).out;
const owner = remote.match(/github\.com[/:]([^/]+)\//)?.[1];
if (!owner) fail("讀不到 origin 的 GitHub 擁有者：" + remote);
const token = run("gh", ["auth", "token", "--user", owner]);
if (token.code !== 0 || !token.out) fail(`取不到 gh 帳號 ${owner} 的憑證（請先 gh auth login）：${token.err}`);
if (DRY) { log(`gh 帳號 ${owner} 憑證可用，推送目標 ${remote}`); process.exit(0); }

const push = run("git", ["push", "origin", "HEAD"], { ...process.env, GH_TOKEN: token.out });
if (push.code !== 0) fail("推送失敗：" + push.err);
log(`已推送到 ${remote}`);
