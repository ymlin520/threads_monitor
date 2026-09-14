// ── 文字分析：負面輿情關鍵字＋字典式情緒判斷 ──────────────────────────
// 字典都在後台「分析字典」可以改；改完按「重新分析全部」會套到舊資料。
import { db, getSettings } from "./db.js";

const NEGATORS = "不沒別無非";

export function dictFrom(settings) {
  return {
    neg_keywords: settings.neg_keywords,
    pos_words: settings.pos_words,
    neg_words: settings.neg_words,
  };
}

// 計算 word 在 text 中出現幾次，並區分前面有沒有否定詞（「不喜歡」算負面）
function countHits(text, word) {
  let plain = 0;
  let negated = 0;
  let i = text.indexOf(word);
  while (i !== -1) {
    if (i > 0 && NEGATORS.includes(text[i - 1])) negated++;
    else plain++;
    i = text.indexOf(word, i + word.length);
  }
  return { plain, negated };
}

export function analyze(text, dict) {
  const t = String(text || "");
  const negHits = dict.neg_keywords.filter((k) => t.includes(k));

  let pos = 0;
  let neg = 0;
  for (const w of dict.pos_words) {
    const h = countHits(t, w);
    pos += h.plain;
    neg += h.negated;
  }
  const negMatched = new Set(negHits);
  for (const w of dict.neg_words) if (t.includes(w)) negMatched.add(w);
  neg += negMatched.size;

  const score = pos - neg;
  const sentiment = score > 0 ? "positive" : score < 0 ? "negative" : "neutral";
  return { sentiment, score, negHits };
}

export function reanalyzeAll() {
  const dict = dictFrom(getSettings());
  let posts = 0;
  let comments = 0;
  const upPost = db.prepare("UPDATE posts SET sentiment = ?, sentiment_score = ?, neg_hits = ? WHERE code = ?");
  for (const p of db.prepare("SELECT code, content FROM posts").all()) {
    const a = analyze(p.content, dict);
    upPost.run(a.sentiment, a.score, JSON.stringify(a.negHits), p.code);
    posts++;
  }
  const upComment = db.prepare("UPDATE comments SET sentiment = ?, sentiment_score = ?, neg_hits = ? WHERE code = ?");
  for (const c of db.prepare("SELECT code, content FROM comments").all()) {
    const a = analyze(c.content, dict);
    upComment.run(a.sentiment, a.score, JSON.stringify(a.negHits), c.code);
    comments++;
  }
  return { posts, comments };
}
