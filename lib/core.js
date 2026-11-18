/**
 * dsh-topic-recall 核心算法（无宿主依赖，便于单测）。
 *
 * 思路：
 * 1. 从规划消息（历史 + 本轮新增）里抽取「真实用户」和「助手」的文本消息（跳过插件注入、工具结果）。
 * 2. 用「字符 bigram + ASCII 标识符」做分词；用历史消息自身的 IDF 加权。
 * 3. 先判断当前消息是否与最近 N 条消息同话题：同话题直接跳过（近期上下文已经够了）。
 * 4. 话题切换时，只在【较老的历史】里找与当前消息相关的片段；相关度不够就不注入。
 * 5. 命中后按「用户问题 + 助手回答」成对扩展、合并、截断，产出极小的一段召回文本。
 */

export const DEFAULTS = {
  enabled: true,
  skipSubagents: true,
  /** 近期窗口：最近多少条文本消息视为“已在上下文里”，不参与召回。 */
  recentWindow: 8,
  /** 当前消息与近期消息的相关度 >= 该值，视为同话题，跳过召回。 */
  shiftThreshold: 0.45,
  /** 历史片段与当前消息的相关度 >= 该值才注入。 */
  matchThreshold: 0.32,
  /** 当前消息有效 token 少于此值则不处理（“继续”“好的”这类）。 */
  minQueryTokens: 3,
  /** 单次最多注入几个片段。 */
  maxItems: 3,
  /** 单次注入正文的字符上限（不含格式头尾）。 */
  maxChars: 1000,
  /** 每条消息截断长度。 */
  perMessageChars: 420,
  /** 历史消息候选的最小长度。 */
  minMessageChars: 12,
  /** 显式提到“之前/上次/还记得”时，强制检索，不受同话题判断限制。 */
  forceHints: true,
  /** 是否注册调试工具；默认关闭，避免工具 schema 常驻上下文。 */
  debugTool: false
};

/** 高频功能词 bigram，避免“我们/这个/可以”这类词把相关度抬虚。 */
const STOP_BIGRAMS = new Set([
  "我们", "你们", "他们", "她们", "它们", "这个", "那个", "这些", "那些",
  "什么", "怎么", "怎样", "可以", "已经", "还是", "就是", "因为", "所以",
  "但是", "不过", "如果", "然后", "现在", "一下", "不是", "没有", "应该",
  "一个", "这样", "那样", "时候", "自己", "觉得", "知道", "而且", "或者",
  "虽然", "其实", "真的", "比较", "非常", "可能", "帮我", "谢谢", "好的",
  "的话", "了吧", "了吗", "是不", "有点", "一点", "这里", "那里", "进行",
  "使用", "对于", "以及", "需要", "希望", "麻烦", "东西", "事情"
]);

const FORCE_RE = /之前|上次|上回|还记得|记得|刚才|刚刚|先前|早先|前面说过|早前|历史记录|前面提到/;

const UNSEEN_WEIGHT = 1.0;
const MAX_IDF = 3.6;

/** 提取消息里的纯文本（跳过 reasoning / tool call 等块）。 */
export function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      parts.push(block.text);
    }
  }
  return parts.join("\n").trim();
}

export function isRealUser(message) {
  return message?.role === "user" && message?.source?.kind === "user";
}

export function isAssistant(message) {
  return message?.role === "assistant";
}

export function hashText(text) {
  let h = 2166136261;
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** 分词：CJK 字符 bigram + ASCII 标识符（小写）。 */
export function tokenize(text) {
  const out = new Set();
  if (!text) return out;
  const s = String(text).toLowerCase();
  for (const m of s.matchAll(/[a-z0-9][a-z0-9._\-/\\]{1,}/g)) {
    if (m[0].length >= 2) out.add(`w:${m[0]}`);
  }
  const runs = s.match(/[\u3400-\u9fff]+/g) ?? [];
  for (const run of runs) {
    const chars = Array.from(run);
    for (let i = 0; i + 1 < chars.length; i += 1) {
      const bigram = chars[i] + chars[i + 1];
      if (!STOP_BIGRAMS.has(bigram)) out.add(`c:${bigram}`);
    }
    if (chars.length === 1) out.add(`c:${chars[0]}`);
  }
  return out;
}

/** 把消息列表转成可检索的文本单元（保持原顺序）。 */
export function buildUnits(messages) {
  const units = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const text = messageText(message);
    if (!text) continue;
    const role = isRealUser(message) ? "user" : isAssistant(message) ? "assistant" : null;
    if (!role) continue;
    units.push({ pos: units.length, index, role, text, tokens: tokenize(text) });
  }
  return units;
}

function buildIdf(units) {
  const df = new Map();
  for (const unit of units) {
    for (const token of unit.tokens) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const n = Math.max(1, units.length);
  const idf = new Map();
  for (const [token, count] of df) {
    idf.set(token, Math.min(MAX_IDF, Math.log((n + 1) / (count + 0.5))));
  }
  return idf;
}

function weightOf(token, idf) {
  return idf.get(token) ?? UNSEEN_WEIGHT;
}

/**
 * 相关度：只在「历史里出现过的 query 词」上算覆盖率。
 * 当前消息里全新的词（历史里从未出现）无法匹配，不应稀释相关度，
 * 否则“之前那个插件安装路径的问题后来怎么解决的”会因为多了几个新词就被判成不相关。
 */
export function coverage(queryTokens, docTokens, idf) {
  let total = 0;
  let knownTotal = 0;
  let matched = 0;
  let matchedCount = 0;
  for (const token of queryTokens) {
    const weight = weightOf(token, idf);
    total += weight;
    if (!idf.has(token)) continue;
    knownTotal += weight;
    if (docTokens.has(token)) {
      matched += weight;
      matchedCount += 1;
    }
  }
  return {
    coverage: knownTotal > 0 ? matched / knownTotal : 0,
    matched: matchedCount,
    weight: total,
    knownWeight: knownTotal
  };
}

function clip(text, max) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, Math.max(1, max - 1))}…` : t;
}

function skip(reason, extra = {}) {
  return { action: "skip", reason, ...extra };
}

function nearest(units, from, step, role, limit) {
  let pos = from + step;
  let walked = 0;
  while (pos >= 0 && pos < units.length && walked <= limit) {
    if (units[pos].role === role) return pos;
    pos += step;
    walked += 1;
  }
  return -1;
}

/** 把单条命中扩展成「用户问 + 助手答」的成对片段。 */
function expandRange(hitPos, units) {
  const hit = units[hitPos];
  let from = hitPos;
  let to = hitPos;
  if (hit.role === "assistant") {
    const userPos = nearest(units, hitPos, -1, "user", 6);
    if (userPos !== -1) from = userPos;
  } else {
    const assistantPos = nearest(units, hitPos, 1, "assistant", 6);
    if (assistantPos !== -1) to = assistantPos;
  }
  if (to - from > 3) {
    if (hit.role === "assistant") to = Math.min(to, hitPos + 1);
    else from = Math.max(from, hitPos - 1);
  }
  return { from, to };
}

function renderRange(units, from, to, maxChars) {
  const lines = [];
  for (let pos = from; pos <= to; pos += 1) {
    const unit = units[pos];
    if (!unit) continue;
    const label = unit.role === "user" ? "用户" : "助手";
    lines.push(`${label}：${clip(unit.text, maxChars)}`);
  }
  return lines.join("\n");
}

function formatRecall(items) {
  const head = [
    "【会话历史召回 · 自动注入，非用户输入】",
    "当前消息与近期的对话内容不同；下面是从本会话较早历史中筛出的可能相关片段（已截断，仅作背景参考）："
  ].join("\n");
  const body = items.map((item, i) => `--- ${i + 1} ---\n${item.body}`).join("\n");
  const tail = "（若与当前问题无关，请忽略本段；不要向用户提及这个注入机制。）";
  return `${head}\n${body}\n${tail}`;
}

function topHits(units, queryTokens, idf, k) {
  const scored = units.map((unit) => {
    const c = coverage(queryTokens, unit.tokens, idf);
    return {
      pos: unit.pos,
      index: unit.index,
      role: unit.role,
      coverage: Number(c.coverage.toFixed(3)),
      matched: c.matched,
      chars: unit.text.length,
      snippet: clip(unit.text, 100)
    };
  });
  scored.sort((a, b) => b.coverage - a.coverage || b.matched - a.matched);
  return scored.slice(0, k);
}

/**
 * 主决策：返回 {action:"inject", text, items, ...} 或 {action:"skip", reason, ...}。
 * cfg.seen 是 Set<string>，用于跳过本会话已经注入过的片段。
 */
export function planRecall(messages, cfg = {}) {
  const conf = { ...DEFAULTS, ...cfg };
  const units = buildUnits(messages);
  const userUnits = units.filter((unit) => unit.role === "user");
  if (!userUnits.length) return skip("no-user-message");
  const current = userUnits[userUnits.length - 1];
  const currentPos = current.pos;
  if (current.text.length < 4) return skip("current-too-short");
  const queryTokens = tokenize(current.text);
  if (queryTokens.size < conf.minQueryTokens) return skip("too-few-query-tokens", { queryTokens: queryTokens.size });

  const history = units.filter((unit) => unit.pos < currentPos);
  if (!history.length) return skip("no-history");
  const idf = buildIdf(history);

  const recent = history.slice(-conf.recentWindow);
  let continuity = { coverage: 0, matched: 0, weight: 0 };
  for (const unit of recent) {
    const c = coverage(queryTokens, unit.tokens, idf);
    if (c.coverage > continuity.coverage) continuity = c;
  }
  continuity = { coverage: Number(continuity.coverage.toFixed(3)), matched: continuity.matched };
  const forced = conf.forceHints && FORCE_RE.test(current.text);
  if (!forced && continuity.coverage >= conf.shiftThreshold) {
    return skip("same-topic", { continuity });
  }

  const older = history.slice(0, Math.max(0, history.length - conf.recentWindow));
  if (older.length < 2) return skip("no-old-history", { continuity });

  const hits = [];
  for (const unit of older) {
    if (unit.text.length < conf.minMessageChars) continue;
    const c = coverage(queryTokens, unit.tokens, idf);
    if (c.matched < 2 || c.coverage < conf.matchThreshold) continue;
    hits.push({ pos: unit.pos, coverage: c.coverage, matched: c.matched });
  }
  if (!hits.length) {
    return skip("no-match", {
      continuity,
      top: topHits(older.slice(-80), queryTokens, idf, 3)
    });
  }

  hits.sort((a, b) => b.coverage - a.coverage || b.matched - a.matched);
  const ranges = [];
  for (const hit of hits) {
    const range = expandRange(hit.pos, units);
    ranges.push({ ...range, coverage: hit.coverage, matched: hit.matched });
  }
  ranges.sort((a, b) => a.from - b.from);
  const mergedRanges = [];
  for (const range of ranges) {
    const last = mergedRanges[mergedRanges.length - 1];
    if (last && range.from <= last.to + 1) {
      last.to = Math.max(last.to, range.to);
      last.coverage = Math.max(last.coverage, range.coverage);
      last.matched = Math.max(last.matched, range.matched);
    } else {
      mergedRanges.push({ ...range });
    }
  }
  mergedRanges.sort((a, b) => b.coverage - a.coverage || b.matched - a.matched);

  const items = [];
  let chars = 0;
  for (const range of mergedRanges) {
    let to = range.to;
    if (to - range.from > 5) to = range.from + 5;
    const body = renderRange(units, range.from, to, conf.perMessageChars);
    if (!body) continue;
    const key = hashText(body.slice(0, 160));
    if (conf.seen instanceof Set && conf.seen.has(key)) continue;
    const size = body.length + 20;
    if (items.length >= conf.maxItems) break;
    if (items.length > 0 && chars + size > conf.maxChars) continue;
    items.push({
      from: range.from,
      to,
      coverage: Number(range.coverage.toFixed(3)),
      matched: range.matched,
      chars: body.length,
      key,
      body
    });
    chars += size;
  }
  if (!items.length) return skip("already-recall-or-too-large", { continuity });

  return {
    action: "inject",
    text: formatRecall(items),
    items,
    continuity,
    queryTokens: queryTokens.size,
    totalChars: chars
  };
}

/** 调试：对给定 query 在整段消息上干跑一次打分，不注入。 */
export function dryRun(messages, query, cfg = {}, k = 5) {
  const conf = { ...DEFAULTS, ...cfg };
  const units = buildUnits(messages);
  const queryTokens = tokenize(query);
  const idf = buildIdf(units);
  const top = topHits(units, queryTokens, idf, Math.max(1, Math.min(20, k)));
  return {
    query,
    queryTokens: queryTokens.size,
    units: units.length,
    idfSize: idf.size,
    top
  };
}
