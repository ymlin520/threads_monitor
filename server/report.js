// ── 報表匯出：多工作表 Excel（月報、客戶報告用）＋ 貼文 CSV ─────────────
import ExcelJS from "exceljs";
import { db } from "./db.js";
import * as A from "./analytics.js";

const tw = (iso) => (iso ? new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 16).replace("T", " ") : "");
const SENT = { positive: "正面", neutral: "中性", negative: "負面" };

function sheet(wb, name, columns, rows) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = columns.map(([header, key, width]) => ({ header, key, width: width || 14 }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEFEA" } };
  for (const r of rows) ws.addRow(r);
  ws.eachRow((row, i) => { if (i > 1) row.alignment = { vertical: "top", wrapText: true }; });
  return ws;
}

export function buildWorkbook(workspace, days) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Threads 監測系統";
  wb.created = new Date();

  const ov = A.overview(workspace.id, days);
  const k = ov.kpi;
  sheet(wb, "總覽", [["項目", "k", 26], ["數值", "v", 18]], [
    { k: "工作區", v: workspace.name },
    { k: "期間", v: `近 ${days} 天` },
    { k: "匯出時間（台灣）", v: tw(new Date().toISOString()) },
    { k: "貼文數", v: k.posts },
    { k: "總互動數（讚＋留言＋轉發＋分享）", v: k.interactions },
    { k: "平均互動／篇", v: k.avg_inter },
    { k: "互動中位數／篇", v: k.median_inter },
    { k: "總瀏覽數（有瀏覽資料的貼文）", v: k.views_total },
    { k: "已抓留言數", v: k.comments },
    { k: "正面／中性／負面留言", v: `${k.comments_pos}／${k.comments_neu}／${k.comments_neg}` },
    { k: "含負面關鍵字的貼文", v: k.flagged_posts },
    { k: "含負面關鍵字的留言", v: k.flagged_comments },
  ]);

  sheet(wb, "主題熱度", [
    ["類型", "type", 10], ["主題", "term", 16], ["提及數", "mentions", 10], ["總互動", "interactions", 12],
    ["平均互動", "avg_inter", 10], ["互動中位數", "median_inter", 12], ["平均瀏覽", "views_avg", 12],
    ["提及趨勢", "mtrend", 12], ["互動趨勢", "itrend", 12], ["負面標記", "flagged", 10], ["最熱門貼文", "top", 50],
  ], A.topicSummary(workspace.id, days).map((t) => ({
    ...t,
    type: t.type === "hashtag" ? "標籤" : "關鍵字",
    mtrend: t.mention_trend.label + (t.mention_trend.change != null ? `（${t.mention_trend.change}%）` : ""),
    itrend: t.inter_trend.label + (t.inter_trend.change != null ? `（${t.inter_trend.change}%）` : ""),
    top: t.top ? `@${t.top.author}：${t.top.content}（互動 ${t.top.inter}）` : "",
  })));

  sheet(wb, "貼文成效", [
    ["發布時間（台灣）", "time", 17], ["作者", "author", 16], ["主題", "topics", 14], ["內文", "content", 60],
    ["讚", "likes", 8], ["留言", "replies", 8], ["轉發", "reposts", 8], ["分享", "shares", 8], ["總互動", "inter", 10],
    ["瀏覽", "views", 10], ["互動／千次瀏覽", "per_k_views", 12], ["互動率%", "er", 10], ["情緒", "sent", 8],
    ["負面關鍵字", "neg", 14], ["連結", "url", 40],
  ], A.postsList(workspace.id, { days, sort: "inter", limit: 2000 }).map((p) => ({
    ...p, time: tw(p.posted_at), author: "@" + p.author, sent: SENT[p.sentiment] || "", neg: p.neg_hits.join("、"),
  })));

  const comments = db.prepare(`SELECT c.*, p.url AS post_url FROM comments c JOIN posts p ON p.code = c.post_code
      WHERE c.post_code IN (SELECT pt.post_code FROM post_topics pt JOIN topics t ON t.id = pt.topic_id WHERE t.workspace_id = ?
        UNION SELECT p2.code FROM posts p2 JOIN accounts a ON a.handle = p2.author WHERE a.workspace_id = ?)
      AND p.posted_at >= ? ORDER BY (c.neg_hits != '[]') DESC, c.likes DESC`)
    .all(workspace.id, workspace.id, new Date(Date.now() - days * 86400000).toISOString());
  sheet(wb, "留言", [
    ["留言時間（台灣）", "time", 17], ["留言者", "author", 16], ["留言內容", "content", 60], ["讚", "likes", 8],
    ["原作者說讚", "al", 10], ["情緒", "sent", 8], ["負面關鍵字", "neg", 14], ["所屬貼文", "post_url", 40],
  ], comments.map((c) => ({
    ...c, time: tw(c.posted_at), al: c.author_liked ? "是" : "", sent: SENT[c.sentiment] || "", neg: JSON.parse(c.neg_hits || "[]").join("、"),
  })));

  sheet(wb, "帳號比較", [
    ["類型", "kind", 8], ["帳號", "handle", 18], ["名稱", "label", 16], ["粉絲數", "followers", 12], ["期間粉絲成長", "growth", 12],
    ["成長率%", "growth_pct", 10], ["每日成長", "growth_per_day", 10], ["貼文數", "posts", 8], ["每週發文", "posts_per_week", 10],
    ["平均互動", "avg_inter", 10], ["互動中位數", "median_inter", 12], ["互動率%", "er", 10], ["平均瀏覽", "views_avg", 12],
  ], A.accountsSummary(workspace.id, days).map((a) => ({ ...a, kind: a.kind === "own" ? "自己" : "競品", handle: "@" + a.handle, label: a.label || a.name || "" })));

  return wb;
}

const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function postsCsv(posts) {
  const head = ["發布時間(台灣)", "作者", "主題", "內文", "讚", "留言", "轉發", "分享", "總互動", "瀏覽", "互動率%", "情緒", "負面關鍵字", "連結"];
  const lines = posts.map((p) => [tw(p.posted_at), "@" + p.author, p.topics, p.content, p.likes, p.replies, p.reposts, p.shares, p.inter,
    p.views, p.er, SENT[p.sentiment] || "", p.neg_hits.join("、"), p.url].map(csvCell).join(","));
  return "﻿" + [head.join(","), ...lines].join("\n");
}
