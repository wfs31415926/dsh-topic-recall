# dsh-topic-recall

在**同一个 DSH 会话**里按话题选择性召回历史。它不把整段历史塞回上下文，而是：

1. 每条新用户消息进来时，先判断是不是**换话题**（与最近 8 条文本消息的相关度低于阈值）；
2. 只有换话题时，才去**更早的历史**里找相关片段；
3. 相关度达标才注入一小段（默认 ≤1000 字、≤3 个“用户问 + 助手答”片段）；
4. 同一条用户消息的多个 step 内去重，不会反复注入；换到新的用户消息后允许重新召回（旧片段可能已被代理层折叠）。

没换话题、历史不相关、消息太短（“继续”“好的”）时，插件什么都不做，token 开销接近 0。

## 安装

插件是一个 bundle 目录，用 DSH 的插件管理器安装本目录的绝对路径：

```
plugin_manager install_bundle
  target: D:\Program Files\DeepSeek Harness\chat\dsh-plugins\topic-recall
```

安装后重启 DSH 或按提示重载。插件自带 patch：

```yaml
- insert:
    - id: dsh-topic-recall
      name: 'dsh-topic-recall'
      config: {}
```

更新已安装的 link 包时，manifest（locale/icon/配置项）可以热重载，但 **JS 模块需要重启 DSH** 才会换成新代码。

## 配置

在 DSH 的插件配置里可调（都有默认值）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `skipSubagents` | `true` | 子 agent 不注入 |
| `recentWindow` | `8` | 最近 N 条文本消息视为“已在上下文”，不参与召回 |
| `shiftThreshold` | `0.45` | 与近期消息相关度 ≥ 此值视为同话题，跳过 |
| `matchThreshold` | `0.32` | 历史片段相关度 ≥ 此值才注入 |
| `minQueryTokens` | `3` | 当前消息有效 token 少于此值不处理 |
| `maxItems` | `3` | 单次最多片段数 |
| `maxChars` | `1000` | 单次注入正文上限（字符） |
| `perMessageChars` | `420` | 每条消息截断长度 |
| `minMessageChars` | `12` | 历史候选最小长度 |
| `forceHints` | `true` | 消息含“之前/上次/还记得…”时强制检索 |
| `debugTool` | `false` | 注册 `topic_recall_debug` 调试工具（会占一点工具 schema token） |

## 调试

先在插件配置里把 `debugTool` 设为 `true`，插件才会注册 `topic_recall_debug` 工具：

- 不传参数：查看本会话最近的召回判定、注入次数、上次注入大小；
- 传 `query`：对当前会话历史干跑一次相关性打分（只读，不注入），用于观察阈值是否合适。

## 相关度算法

- 分词：CJK 字符 bigram + ASCII 标识符（`plugin_manager`、`install_bundle` 会整体保留）；
- 权重：IDF 用历史消息自身统计，常见词降权，最高 3.6；
- 相关度：只在“历史里出现过的 query 词”上算加权覆盖率，避免新词稀释；
- 噪声控制：命中至少 2 个 token；命中片段扩展成“用户问 + 助手答”成对文本后按长度截断。

## 边界

- `agent/pre-step` 的 `decision.messages` 只是本轮新增的消息，完整历史从 `agent.session.deriveMessages()`（会话 surface）读取；不读取 proxy 层的压缩状态，也不依赖 compaction 事件。
- ACP（billion-context）的折叠发生在**代理层**，只改发给模型的请求体，不回收 `session.surface`；因此 harness 与插件始终能拿到完整历史，“历史是否已被折叠”无法在插件侧精确观测。本插件的做法是：只从“比近期窗口更老”的历史里按相关度筛选，因此最坏情况是召回一段仍可见的相关内容（少量重复），换话题时不会把无关历史带进来。
- 纯内存状态，DSH 重启后去重清空；同一条用户消息的多个 step 内不重复注入，换到新的用户消息后允许重新召回（旧片段可能已被代理层折叠）。
- 无网络请求、不写文件、不额外调用模型。

## 开发

```
node test/core.test.mjs
```

`lib/core.js` 不依赖宿主，可单独测试；`lib/index.js` 只做事件接线与注入。

## 发布

发布前先在 `package.json` 补上 `repository` / `homepage`（指向你的 GitHub 仓库）。

```
npm pack
npm publish --access public
```

发布后到 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提 PR 加一条条目；dshmarket 与站点会读取该列表，通常一天内收录。不要把条目提到 dshmarket 仓库。
