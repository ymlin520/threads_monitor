// ── 每日排程：伺服器開著時，到了設定的時間就自動抓一次 ───────────────
// 用這台電腦的本地時間比對；電腦關機或伺服器沒開，那一次就會錯過（不補跑）。
import { getSettings } from "./db.js";
import { startCrawl } from "./crawler.js";

let lastFired = "";
const pad = (n) => String(n).padStart(2, "0");
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function startScheduler() {
  setInterval(() => {
    const s = getSettings();
    if (!s.schedule_enabled) return;
    const d = new Date();
    const key = `${ymd(d)} ${hhmm(d)}`;
    if (s.schedule_times.includes(hhmm(d)) && lastFired !== key) {
      lastFired = key;
      const r = startCrawl("schedule", "排程");
      console.log("[scheduler]", key, r.ok ? `開始抓取 run #${r.runId}` : r.error);
    }
  }, 20000);
}

export function nextRunAt() {
  const s = getSettings();
  if (!s.schedule_enabled || !s.schedule_times.length) return null;
  const nowD = new Date();
  let best = null;
  for (const t of s.schedule_times) {
    const [h, m] = t.split(":").map(Number);
    const d = new Date(nowD);
    d.setHours(h, m, 0, 0);
    if (d <= nowD) d.setDate(d.getDate() + 1);
    if (!best || d < best) best = d;
  }
  return best ? best.toISOString() : null;
}
