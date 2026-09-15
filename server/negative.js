// ── 負面留言板：把「可能是負面」的留言與貼文盡量找出來 ──────────────────
// 比情緒分析寬很多：輿情關鍵字、強烈負評與粗話、一般抱怨、質問句、勸退、反諷語氣、
// 負面表情都算訊號，依權重加總分成 高／中／低 三級。寧可多抓，由人判斷。
// 系統設定裡的「負面輿情關鍵字」與「負面詞」也會併進來，改字典就會影響這裡。
import { db, getSettings } from "./db.js";

const DAY = 86400000;
const SCOPE = `scope AS (
  SELECT pt.post_code AS code FROM post_topics pt JOIN topics t ON t.id = pt.topic_id WHERE t.workspace_id = :ws
  UNION
  SELECT p.code FROM posts p JOIN accounts a ON a.handle = p.author WHERE a.workspace_id = :ws
)`;

// [詞或正規式, 權重, 類別]：3 = 輿情級（人身、法律、權益）、2 = 強烈負評、1 = 一般抱怨與句型、0.5 = 語氣線索
const words = (list, weight, cat) => list.map((w) => [w, weight, cat]);
const CLAUSE = "[^。！？!?\\n，,；;]";
const BUILTIN = [
  ...words(["性騷", "騷擾", "性侵", "偷拍", "霸凌", "歧視", "恐嚇", "威脅", "暴力", "打人", "受傷", "自殺", "輕生",
    "詐騙", "被偷", "竊盜", "偷竊", "申訴", "投訴", "檢舉", "抗議", "陳情", "提告", "告你", "地檢署", "報警", "爆料",
    "黑箱", "欠薪", "資遣", "裁員", "減薪", "停招", "退場", "倒閉", "超收"], 3, "輿情"),
  ...words(["垃圾", "廢物", "爛透", "糟透", "擺爛", "敷衍", "靠北", "靠杯", "三小", "殺小", "智障", "白癡", "白痴", "腦殘",
    "北七", "低能", "他媽", "媽的", "有病", "吃屎", "吃什麼屎", "噁心", "可悲", "吃相難看", "斂財", "學店", "沒救",
    "無心辦學", "坑錢", "被坑", "騙錢", "丟臉", "不負責", "推卸", "踢皮球", "沒人管", "沒人理", "已讀不回", "刁難",
    "壓榨", "剝削", "血汗", "不公平", "不合理", "不透明", "官僚"], 2, "強烈負評"),
  [/幹(?!嘛|麻|部|事|什麼|啥|活|練|勁|線|道|細)/, 2, "粗話"],
  ...words(["失望", "後悔", "傻眼", "無言", "離譜", "誇張", "太扯", "很扯", "超扯", "好扯", "扯爆", "什麼鬼", "搞什麼", "搞屁",
    "搞一堆", "正事不做", "花里胡哨", "花里胡俏", "浪費", "白繳", "盤子", "血虧", "不爽", "火大", "生氣", "氣死", "崩潰",
    "受不了", "忍不了", "夠了", "討厭", "痛苦", "悲劇", "心寒", "寒心", "無奈", "空洞", "不像學校", "很瞎", "好瞎", "超瞎",
    "很差", "太差", "好差", "超差", "差勁", "糟糕", "很廢", "好廢", "爛掉", "壞掉", "故障", "卡頓", "漏水", "停電", "停水",
    "沒冷氣", "不冷", "太熱", "很吵", "太吵", "好吵", "很臭", "好臭", "髒", "蟑螂", "老鼠", "排隊", "很擠", "太擠", "擠爆",
    "搶不到", "選不到", "借不到", "沒位子", "太貴", "很貴", "超貴", "好貴", "漲價", "難吃", "退學", "休學", "轉學", "延畢",
    "被當", "踩雷", "地雷", "避雷", "雷校", "勸退", "快跑", "快逃", "可憐", "慘", "要死", "是怎樣", "誰要用"], 1, "抱怨"),
  [/(?<!燦)爛(?!漫)/, 1, "抱怨"],
  [/(?<!麻)煩(?!請)/, 1, "抱怨"],
  [new RegExp(`(怎麼|為什麼|為何|憑什麼)${CLAUSE}{0,12}?(都不|還不|不能|沒有|沒人|不處理|不改|這樣|那麼|這麼)`), 1, "質問句"],
  [new RegExp(`(到底|究竟)${CLAUSE}{0,12}?(在幹嘛|在幹麻|在做什麼|要怎樣|想怎樣|在想什麼|要幹嘛)`), 1, "質問句"],
  [/(不|沒)(處理|回應|回覆|理人|管|改善|改進)/, 1, "不處理"],
  [new RegExp(`(學費|錢)${CLAUSE}{0,10}?(白繳|浪費|拿去|拿來|在哪|貴|坑)`), 1, "學費不滿"],
  [/(不要|別|勿)(念|讀|來|選|去|報)/, 1, "勸退"],
  [/(爛|差|糟|慘|廢|醜)(透|爆|死)/, 1, "強烈負評"],
  [/(熱|冷|吵|臭|累|餓|煩|氣)死/, 1, "抱怨"],
  [/(敢不敢|還敢|好意思|真好笑|有夠好笑)/, 0.5, "反諷"],
  [/(笑死|呵呵|是喔|好喔|蛤)/, 0.5, "反諷語氣"],
  [/(==|= =|-_-|－＿－|\.{4,}|…{2,}|⋯{2,}|[?？]{2,})/, 0.5, "無奈符號"],
  [/(😅|🙄|😡|🤬|💩|😠|😤|🙃|😒|😑|😞|😩|😫|🤮|🤢|👎|😓|😔|🤡|🥲)/u, 0.5, "負面表情"],
];

// 抱怨詞前面有否定詞就不算（「並不後悔」「不難過」）；輿情級一律算，寧可多抓
const NEGATED = /(不|沒|別|免|無|並不|不會|沒有|不再)$/;
function findTerm(text, term, weight) {
  let i = text.indexOf(term);
  while (i !== -1) {
    if (weight >= 3 || !NEGATED.test(text.slice(Math.max(0, i - 2), i))) return true;
    i = text.indexOf(term, i + term.length);
  }
  return false;
}

// 後台字典併進來：負面輿情關鍵字算輿情級、負面詞算一般抱怨（內建已有的不重複）
function lexicon() {
  const s = getSettings();
  const have = new Set(BUILTIN.filter(([p]) => typeof p === "string").map(([p]) => p));
  return [
    ...s.neg_keywords.filter((w) => !have.has(w)).map((w) => [w, 3, "輿情"]),
    ...BUILTIN,
    ...s.neg_words.filter((w) => !have.has(w)).map((w) => [w, 1, "抱怨"]),
  ];
}

function detect(text, lex) {
  const t = String(text || "");
  const hits = [];
  let score = 0;
  let serious = false;
  for (const [p, weight, cat] of lex) {
    let term;
    if (typeof p === "string") { if (!findTerm(t, p, weight)) continue; term = p; }
    else { const m = t.match(p); if (!m) continue; term = m[0]; }
    // 較長的詞已經命中同一段文字就不重複加分（「爛透」算過就不再算「爛」）
    if (hits.some((h) => h.term === term || h.term.includes(term))) continue;
    hits.push({ term, cat, weight });
    score += weight;
    if (weight >= 3) serious = true;
  }
  return { hits, score, serious };
}

// 字典情緒判為負面也算一分；整體偏正面且只有語氣線索的，多半是玩笑，不列入
function levelOf(d, sentiment) {
  const score = d.score + (sentiment === "negative" ? 1 : 0);
  if (score <= 0) return null;
  if (sentiment === "positive" && d.score < 1) return null;
  if (d.serious || score >= 3) return "high";
  if (score >= 2) return "mid";
  return "low";
}

const RANK = { high: 3, mid: 2, low: 1 };
const url = (author, code) => `https://www.threads.com/@${author}/post/${code}`;

// f：days、topicId、handle、kind、type（comment／post／all）、level、q、sort、all（CSV 用，不截斷）
export function negativeBoard(ws, f = {}) {
  const lex = lexicon();
  const params = { ws, since: new Date(Date.now() - (Number(f.days) || 30) * DAY).toISOString() };
  const where = [];
  if (f.topicId) { where.push("EXISTS (SELECT 1 FROM post_topics x WHERE x.post_code = p.code AND x.topic_id = :tid)"); params.tid = Number(f.topicId); }
  if (f.handle) { where.push("p.author = :handle"); params.handle = String(f.handle).replace(/^@/, ""); }
  if (f.kind) { where.push("p.author IN (SELECT handle FROM accounts WHERE workspace_id = :ws AND kind = :kind)"); params.kind = f.kind; }
  const extra = where.length ? " AND " + where.join(" AND ") : "";
  const type = ["comment", "post", "all"].includes(f.type) ? f.type : "comment";

  const rows = [];
  if (type !== "post") {
    rows.push(...db.prepare(`WITH ${SCOPE}
      SELECT 'comment' AS type, c.code, c.author, c.content, c.posted_at, c.likes, c.author_liked, c.sentiment,
        p.code AS post_code, p.author AS post_author, p.content AS post_content
      FROM comments c JOIN scope s ON s.code = c.post_code JOIN posts p ON p.code = c.post_code
      WHERE c.posted_at >= :since${extra}`).all(params));
  }
  if (type !== "comment") {
    rows.push(...db.prepare(`WITH ${SCOPE}
      SELECT 'post' AS type, p.code, p.author, p.content, p.posted_at, p.likes, 0 AS author_liked, p.sentiment,
        p.code AS post_code, p.author AS post_author, p.content AS post_content
      FROM posts p JOIN scope s ON s.code = p.code
      WHERE p.posted_at >= :since${extra}`).all(params));
  }

  const q = String(f.q || "").trim().toLowerCase();
  let items = [];
  for (const r of rows) {
    const d = detect(r.content, lex);
    const level = levelOf(d, r.sentiment);
    if (!level) continue;
    if (q && !String(r.content || "").toLowerCase().includes(q) && !d.hits.some((h) => h.term.toLowerCase() === q || h.cat === q)) continue;
    items.push({
      type: r.type, code: r.code, author: r.author, content: r.content, posted_at: r.posted_at, likes: r.likes,
      author_liked: !!r.author_liked, sentiment: r.sentiment, level, score: d.score, hits: d.hits,
      url: url(r.author, r.code),
      post: r.type === "comment" ? { code: r.post_code, author: r.post_author, content: String(r.post_content || "").slice(0, 80), url: url(r.post_author, r.post_code) } : null,
    });
  }

  // 分級數量、常見訊號都以「套用分級篩選前」的結果計算，切換分級時數字不會跳
  const counts = { total: items.length, high: 0, mid: 0, low: 0, posts: new Set(items.map((i) => i.post?.code || i.code)).size };
  const freq = new Map();
  for (const i of items) {
    counts[i.level]++;
    for (const h of i.hits) {
      const k = `${h.cat}|${h.term}`;
      freq.set(k, (freq.get(k) || 0) + 1);
    }
  }
  const topSignals = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24)
    .map(([k, n]) => { const [cat, term] = k.split("|"); return { cat, term, count: n }; });

  if (RANK[f.level]) items = items.filter((i) => i.level === f.level);
  const sorts = {
    likes: (a, b) => b.likes - a.likes || RANK[b.level] - RANK[a.level],
    newest: (a, b) => (a.posted_at < b.posted_at ? 1 : -1),
    severity: (a, b) => RANK[b.level] - RANK[a.level] || b.score - a.score || b.likes - a.likes,
  };
  items.sort(sorts[f.sort] || sorts.severity);

  const shown = f.all ? items.length : Math.min(items.length, 500);
  return { counts, topSignals, shown, matched: items.length, items: items.slice(0, shown) };
}

const tw = (iso) => (iso ? new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 16).replace("T", " ") : "");
const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const LEVEL_NAME = { high: "高", mid: "中", low: "低" };

export function negativeCsv(items) {
  const head = ["嚴重度", "類型", "時間(台灣)", "作者", "內容", "讚", "命中訊號", "所屬貼文", "連結"];
  const lines = items.map((i) => [LEVEL_NAME[i.level], i.type === "comment" ? "留言" : "貼文", tw(i.posted_at), "@" + i.author, i.content,
    i.likes, i.hits.map((h) => `${h.cat}:${h.term}`).join("、") || "字典判定負面", i.post ? i.post.url : "", i.url].map(csvCell).join(","));
  return "﻿" + [head.join(","), ...lines].join("\n");
}
