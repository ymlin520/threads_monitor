// 不開網頁、直接抓一次：npm run crawl
import { db } from "./db.js";
import { startCrawl } from "./crawler.js";

const r = startCrawl("cli", "命令列");
if (!r.ok) {
  console.error(r.error);
  process.exit(1);
}
await r.done;
const run = db.prepare("SELECT status, error FROM runs WHERE id = ?").get(r.runId);
console.log(`run #${r.runId}：${run.status}${run.error ? "（" + run.error + "）" : ""}`);
process.exit(run.status === "success" ? 0 : 1);
