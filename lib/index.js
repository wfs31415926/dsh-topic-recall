import { createUserMessage } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import { DEFAULTS, dryRun, hashText, isRealUser, messageText, planRecall } from "./core.js";

export const name = "dsh-topic-recall";
export const inject = ["tools"];

export const Config = z.object({
  /** 总开关。 */
  enabled: z.boolean().default(true),
  /** 子 agent 不注入（子 agent 上下文独立，注入会浪费 token）。 */
  skipSubagents: z.boolean().default(true),
  /** 近期窗口：最近 N 条文本消息视为“已在上下文”，不参与召回。 */
  recentWindow: z.number().min(1).max(40).default(DEFAULTS.recentWindow),
  /** 与近期消息相关度 >= 该值视为同话题，跳过召回。 */
  shiftThreshold: z.number().min(0).max(1).default(DEFAULTS.shiftThreshold),
  /** 与历史片段相关度 >= 该值才注入。 */
  matchThreshold: z.number().min(0).max(1).default(DEFAULTS.matchThreshold),
  /** 当前消息有效 token 少于此值不处理。 */
  minQueryTokens: z.number().min(1).max(30).default(DEFAULTS.minQueryTokens),
  /** 单次最多几个片段。 */
  maxItems: z.number().min(1).max(8).default(DEFAULTS.maxItems),
  /** 单次注入正文字符上限。 */
  maxChars: z.number().min(200).max(4000).default(DEFAULTS.maxChars),
  /** 每条消息截断长度。 */
  perMessageChars: z.number().min(80).max(2000).default(DEFAULTS.perMessageChars),
  /** 历史候选最小长度。 */
  minMessageChars: z.number().min(4).max(500).default(DEFAULTS.minMessageChars),
  /** 显式提到“之前/上次/还记得”时强制检索。 */
  forceHints: z.boolean().default(true),
  /** 注册 topic_recall_debug 调试工具；默认关闭，避免工具 schema 常驻上下文。 */
  debugTool: z.boolean().default(false)
});

const MAX_SESSIONS = 16;
const MAX_SEEN = 240;

/** sessionId -> 运行状态（内存态，进程重启即清空）。 */
const sessions = new Map();

function stateOf(sessionId) {
  let state = sessions.get(sessionId);
  if (!state) {
    state = {
      steps: 0,
      messageCount: 0,
      userCount: 0,
      lastUserKey: "",
      lastPlan: null,
      lastMessages: null,
      lastPlanningCount: 0,
      historyCount: 0,
      incomingCount: 0,
      lastInjectAt: 0,
      lastInjectionChars: 0,
      injections: 0,
      recalls: 0,
      seen: new Set()
    };
    sessions.set(sessionId, state);
    if (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) sessions.delete(oldest);
    }
  }
  return state;
}

function sessionIdOfAgent(agent) {
  const id = agent?.session?.header?.id;
  return typeof id === "string" && id.length > 0 ? id : "unknown";
}

function visibleKeyOf(message) {
  const text = messageText(message);
  if (!text) return "";
  return `${message?.role ?? "?"}:${hashText(text)}`;
}

function summarizePlan(plan) {
  if (!plan) return null;
  return {
    action: plan.action,
    reason: plan.reason ?? null,
    continuity: plan.continuity ?? null,
    items: Array.isArray(plan.items)
      ? plan.items.map((item) => ({
          from: item.from,
          to: item.to,
          coverage: item.coverage,
          matched: item.matched,
          chars: item.chars
        }))
      : [],
    totalChars: plan.totalChars ?? 0,
    top: plan.top ?? null
  };
}

function debugTool(cfg) {
  return {
    name: "topic_recall_debug",
    description:
      "调试“会话历史召回”插件：查看本会话最近的召回判定；传 query 可对当前会话历史干跑一次相关性打分（只读，不注入、不改上下文）。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "可选：用这句话干跑一次召回打分" },
        k: { type: "integer", minimum: 1, maximum: 20, default: 5, description: "干跑返回条数" }
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: { text: { type: "string", description: "JSON 格式的调试信息" } }
      },
      render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }]
    },
    async execute(args, exec) {
      const sessionId = sessionIdOfAgent(exec?.agent);
      const state = sessions.get(sessionId);
      const query = typeof args?.query === "string" ? args.query.trim() : "";
      const fallback =
        typeof exec?.agent?.session?.deriveMessages === "function"
          ? exec.agent.session.deriveMessages()
          : [];
      const messages = state?.lastMessages ?? fallback;
      if (query) {
        const result = dryRun(messages, query, cfg, args?.k ?? 5);
        return { text: JSON.stringify({ sessionId, dryRun: result }, null, 2) };
      }
      return {
        text: JSON.stringify(
          {
            sessionId,
            config: {
              enabled: cfg.enabled,
              recentWindow: cfg.recentWindow,
              shiftThreshold: cfg.shiftThreshold,
              matchThreshold: cfg.matchThreshold,
              maxItems: cfg.maxItems,
              maxChars: cfg.maxChars
            },
            state: state
              ? {
                  steps: state.steps,
                  messageCount: state.messageCount,
                  userCount: state.userCount,
                  injections: state.injections,
                  recalls: state.recalls,
                  seen: state.seen.size,
                  lastInjectAt: state.lastInjectAt,
                  lastInjectionChars: state.lastInjectionChars,
                  lastPlanningCount: state.lastPlanningCount,
                  historyCount: state.historyCount,
                  incomingCount: state.incomingCount,
                  lastPlan: summarizePlan(state.lastPlan)
                }
              : null
          },
          null,
          2
        )
      };
    }
  };
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) };
  if (cfg.enabled === false) {
    ctx.logger?.info?.("dsh-topic-recall: disabled by config");
  }

  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    try {
      if (cfg.enabled === false) return decision;
      if (decision === undefined || decision.kind !== "enter") return decision;
      const messages = decision.messages;
      if (!Array.isArray(messages) || messages.length === 0) return decision;
      const agent = payload?.agent;
      if (cfg.skipSubagents && agent?.session?.header?.origin === "subagent") return decision;
      if (payload?.signal?.aborted) return decision;

      const sessionId = sessionIdOfAgent(agent);
      const state = stateOf(sessionId);
      state.steps += 1;

      const users = messages.filter(isRealUser);
      state.userCount = users.length;
      if (!users.length) return decision;
      const lastUser = users[users.length - 1];
      const userKey = `${users.length}|${hashText(messageText(lastUser))}`;
      if (state.lastUserKey === userKey) return decision;
      // 新的用户消息：清空上一轮的注入去重。同一轮内的多个 step 仍会去重，
      // 但跨轮回到同一旧话题时允许重新召回（旧片段可能已被代理层折叠）。
      state.seen.clear();
      state.lastUserKey = userKey;

      // 关键：pre-step 的 decision.messages 只是本轮新增的消息（通常只有
      // 当前这条用户消息），并不是完整历史。历史必须从 session surface 取。
      let history = [];
      try {
        if (typeof agent?.session?.deriveMessages === "function") {
          history = agent.session.deriveMessages() ?? [];
        }
      } catch {
        history = [];
      }
      // 某些时序下 surface 可能已经包含本轮这条用户消息；去掉尾部重复，
      // 否则“当前消息”会和自己判成同话题，永远不触发召回。
      const tail = history[history.length - 1];
      if (tail && isRealUser(tail) && visibleKeyOf(tail) === visibleKeyOf(lastUser)) {
        history = history.slice(0, -1);
      }
      state.historyCount = history.length;
      state.incomingCount = messages.length;

      // 历史（surface）+ 本轮新增消息一起做规划。ACP 的折叠只发生在
      // 代理层，不会回收 session surface，因此能按相关度筛到完整旧历史；
      // 只召回“比近期窗口更老、且与当前话题相关”的片段。
      const planningMessages = [...history, ...messages];
      state.lastMessages = planningMessages;
      state.messageCount = planningMessages.length;
      state.lastPlanningCount = planningMessages.length;
      const plan = planRecall(planningMessages, { ...cfg, seen: state.seen });
      state.lastPlan = plan;
      if (plan.action !== "inject" || !plan.text) {
        return decision;
      }

      const index = messages.indexOf(lastUser);
      if (index < 0) return decision;
      const recallMessage = createUserMessage({
        content: [{ type: "text", text: plan.text }],
        source: {
          kind: `plugin:${name}`,
          form: "recall",
          sections: [{ name: "topic-recall", text: plan.text }]
        }
      });
      const rewritten = [...messages];
      rewritten.splice(index, 0, recallMessage);
      for (const item of plan.items) {
        state.seen.add(item.key);
        if (state.seen.size > MAX_SEEN) {
          const first = state.seen.values().next().value;
          if (first !== undefined) state.seen.delete(first);
        }
      }
      state.injections += 1;
      state.recalls += plan.items.length;
      state.lastInjectAt = Date.now();
      state.lastInjectionChars = plan.text.length;
      ctx.logger?.info?.(
        `dsh-topic-recall: injected ${plan.text.length} chars / ${plan.items.length} item(s) sid=${sessionId.slice(0, 12)}`
      );
      return { ...decision, messages: rewritten };
    } catch (error) {
      ctx.logger?.warn?.(
        `dsh-topic-recall: pre-step failed (fail-open): ${error instanceof Error ? error.stack ?? error.message : String(error)}`
      );
      return decision;
    }
  });

  if (cfg.debugTool) ctx.tools.register(debugTool(cfg));
}
