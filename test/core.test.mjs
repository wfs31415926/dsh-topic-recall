import assert from "node:assert/strict";
import { buildUnits, coverage, dryRun, planRecall, tokenize } from "../lib/core.js";

const user = (text) => ({ role: "user", source: { kind: "user" }, content: [{ type: "text", text }] });
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }] });
const pluginUser = (text) => ({ role: "user", source: { kind: "plugin:x" }, content: [{ type: "text", text }] });
const toolResult = (text) => ({ role: "user", source: { kind: "tool" }, content: [{ type: "text", text }] });

function fillers(n) {
  const out = [];
  const topics = [
    "今天中午吃什么比较好",
    "这家面馆的味道还不错",
    "下午要开个需求评审会",
    "会议纪要记得发我一份",
    "周末想去公园走一走",
    "天气预报说明天有雨",
    "这个月的账单要核对一下",
    "记得给猫买猫粮",
    "晚上八点看个电影",
    "电影票已经买好了"
  ];
  for (let i = 0; i < n; i += 1) {
    out.push(user(topics[i % topics.length]));
    out.push(assistant(`好的，关于“${topics[i % topics.length]}”我记下了。`));
  }
  return out;
}

// 1) 分词：CJK bigram + ASCII 标识符
{
  const tokens = tokenize("plugin_manager 的 install_bundle 安装路径");
  assert.ok(tokens.has("w:plugin_manager"));
  assert.ok(tokens.has("w:install_bundle"));
  assert.ok(tokens.has("c:安装"));
  assert.ok(tokens.has("c:路径"));
}

// 2) 同话题：近期已在上下文，不召回
{
  const messages = [
    user("FlatList 的 key 应该怎么设置"),
    assistant("FlatList 的 key 建议用稳定的业务 id，不要用 index。"),
    user("FlatList 的 key 用 index 可以吗"),
    assistant("可以用，但列表顺序变化时会有性能问题。"),
    user("FlatList 的 key 用 index 会怎样"),
  ];
  const plan = planRecall(messages);
  assert.equal(plan.action, "skip");
  assert.equal(plan.reason, "same-topic");
}

// 3) 话题切换 + 历史相关：注入，且带用户+助手成对片段
{
  const messages = [
    user("插件安装后怎么重启 DSH"),
    assistant("用 plugin_manager install_bundle 安装后，重启 DSH 进程即可生效。安装路径要传绝对目录。"),
    ...fillers(5),
    user("之前那个插件安装路径的问题后来怎么解决的"),
  ];
  const plan = planRecall(messages);
  assert.equal(plan.action, "inject");
  assert.ok(plan.items.length >= 1);
  assert.ok(plan.text.includes("插件安装") || plan.text.includes("install_bundle"));
  assert.ok(plan.text.includes("用户：") && plan.text.includes("助手："));
  assert.ok(plan.text.length < 1300);
}

// 4) 话题切换但历史无关：不注入
{
  const messages = [
    user("今天中午吃什么比较好"),
    assistant("可以吃面，附近新开了一家面馆。"),
    ...fillers(5),
    user("Flutter 的 Provider 应该怎么用"),
  ];
  const plan = planRecall(messages);
  assert.equal(plan.action, "skip");
  assert.ok(["no-match", "too-few-query-tokens"].includes(plan.reason), `unexpected: ${plan.reason}`);
}

// 5) 已注入过的片段会去重
{
  const messages = [
    user("部署脚本里的端口是多少"),
    assistant("部署脚本里默认端口是 8080。"),
    ...fillers(5),
    user("之前说的部署端口是多少"),
  ];
  const first = planRecall(messages);
  assert.equal(first.action, "inject");
  const seen = new Set(first.items.map((item) => item.key));
  const second = planRecall(messages, { seen });
  assert.equal(second.action, "skip");
}

// 6) 插件注入消息和工具结果不进入索引
{
  const messages = [
    pluginUser("【长期记忆】插件安装路径是 D:\\x"),
    toolResult("命令输出：install_bundle ok"),
    user("插件安装路径是什么"),
    assistant("安装路径在 D 盘。"),
  ];
  const units = buildUnits(messages);
  assert.equal(units.length, 2);
  assert.ok(units.every((unit) => unit.role === "user" || unit.role === "assistant"));
}

// 7) 干跑打分可用
{
  const messages = [user("部署脚本里的端口是多少"), assistant("默认端口 8080。"), ...fillers(3), user("换个话题")];
  const result = dryRun(messages, "部署端口", {}, 3);
  assert.ok(result.units >= 8);
  assert.ok(result.top.length === 3);
  assert.ok(result.top[0].coverage > 0);
}

// 8) 短消息（继续/好的）不处理
{
  const messages = [...fillers(5), user("继续")];
  const plan = planRecall(messages);
  assert.equal(plan.action, "skip");
  assert.ok(["too-few-query-tokens", "current-too-short"].includes(plan.reason), `unexpected: ${plan.reason}`);
}

console.log("core tests passed");
