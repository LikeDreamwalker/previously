# Slices（时间切片）

每一次对话都是一条由时间切片组成的时间线——一段连续的来回交流，一个 Markdown 文件。

## 什么是切片

**切片（slice）**是情景记忆（episodic memory）的存储单元：一个以 `.md` 文件形式保存的独立对话会话，带有 YAML 前置元数据。它是 L2 记忆层——L0 和 L1 在构建时打包，L2（切片）在运行时按需获取。没有数据库，没有二进制格式。只有纯 Markdown 存放在你的仓库中。

每个切片保存一段连续的对话轮次——你和 Previously 在一次交互中交换的消息——以及由 **worker 模型**（廉价的维护调用，在每一轮对话后保持元数据最新）维护的元数据。

## 生命周期

一个切片有三种状态：**open（打开）**、**active（活跃）**和 **closed（关闭）**。

| 阶段 | 发生什么 |
|-------|-------------|
| **打开（Open）** | 聊天路由在你发送消息且没有活跃切片时调用 `createSlice()`。根据当前 UTC 时间推导出 `slice_id`，初始化第一条用户轮次，并将切片保存在内存中。此时不写入磁盘。 |
| **扩展（Extend）** | 后续每条消息调用 `appendTurn()`——轮次被推入内存中的切片。切片在整个会话期间保留在内存中。定期（每 N 个轮次以及在 `beforeunload` 时）通过 `saveSliceSnapshot()` 将检查点快照写入磁盘。 |
| **关闭（Close）** | 在 **30 分钟静默**后，切片器触发。`closeSlice()` 将切片标记为 `status: "closed"`，设置 `end` 时间戳，将完整的 `.md` 写入磁盘，更新月度索引（`_index.json`），并将切片的标签编织到主题索引（strands）`strands.json` 中。下一条消息将打开一个新的切片。 |

> **一条规则，没有例外。** 唯一的切片触发因素是时间静默——自上一轮对话以来过去 30 分钟（`TIME_SILENCE_THRESHOLD_MS = 1,800,000 ms`）。容量检查和 worker 连续性启发式逻辑曾在 M8 中原型验证后被移除。它们永远不会被重新引入。

页面刷新时，`tryLoadTodaySlice()` 扫描今天的目录，找到最近一个仍标记为 `active` 的 `.md` 文件并重新加载——你可以从中断的地方继续。

## 目录结构

切片存储在 `memory/episodic/slices/` 下，采用三层日历层级：

```
memory/episodic/
  slices/
    2025/
      11/
        21/
          0825.md     -- 一个切片
          0930.md     -- 同一天的另一切片
        _index.json   -- 2025年11月的月度索引
    12/
      ...
  strands.json         -- 全局关键词到切片的索引
```

一个日历日是一个**目录**。一个目录可以包含多个切片文件——每个 `HHMM` 时段一个文件。每个文件最多包含一次不间断的对话。

> 路径和 `slice_id` 中的 `HHMM` 是 **UTC 时间**——从第一条用户消息的 UTC 日期和时间推导而来。你当地的挂钟时间单独存储在 `timezone` 前置元数据字段中。这使得路径在不同时区和夏令时切换下保持稳定。

## YAML 前置元数据

每个切片文件以 `---` 分隔的 YAML 开头。以下是所有字段——全部由 worker 模型在关闭或维护期间写入：

| 字段 | 类型 | 必需 | 描述 |
|-------|------|----------|-------------|
| `slice_id` | string | 是 | `YYYY-MM-DD-HHMM`，第一条消息的 UTC 日期时间 |
| `focus` | string | 是 | 核心主题，一句话 |
| `status` | `"active"` 或 `"closed"` | 是 | 生命周期阶段 |
| `start` | string | 是 | 第一轮对话的 UTC ISO 8601 时间戳 |
| `end` | string | 否 | 最后一轮对话的 UTC ISO 8601 时间戳（活跃时不存在） |
| `timezone` | string | 是 | 交互时用户的 IANA 时区，例如 `"Asia/Shanghai"` |
| `summary` | string | 是 | worker 生成的摘要，最多 100 个字符 |
| `open_loops` | string[] | 是 | 悬而未决的问题或需要继续的线程 |
| `decisions` | string[] | 是 | 本切片的结论或行动项 |
| `tags` | string[] | 是 | 语义关键词（这些会编织到主题索引中） |
| `related_slices` | string[] | 是 | 相关切片的相对路径，例如 `["2026/06/22/1430"]`——可以为空 |
| `emotional_tone` | string | 否 | `"positive"`、`"neutral"`、`"negative"` 或 `"mixed"`——由 worker 模型评估 |

空字符串和 `undefined` 字段会从 YAML 中去除。空数组（`open_loops: []`）按原样序列化——它们会显示为空白列表。

## 对话轮次正文

在前置元数据之后，每条消息成为一个二级标题：

```
## Turn 1 — 2023-04-21T06:10:00.000Z (user)

你的消息正文...

## Turn 2 — 2023-04-21T06:13:00.000Z (agent)

Previously 的回复...

## Turn 3 — 2023-04-21T06:15:00.000Z (user)

你的后续消息...
```

格式始终为 `## Turn N — <ISO_TIMESTAMP> (<role>)`，以 em dash 分隔。`parseTurns()` 函数根据这些标题重建数组。

## 一个真实的切片文件

以下是一个已完成的切片在磁盘上的样子。`related_slices` 字段不存在，因为没有设置相关切片（序列化器会去除空值，但显式空数组 `related_slices: []` 会出现；最常见的情况是该字段根本未被填充）。

```preview
demo: slice-file
```

```markdown
---
slice_id: 2023-04-21-0610
focus: Housing project delays and trust crisis management
status: closed
start: "2023-04-21T06:10:00.000Z"
end: "2023-04-21T07:18:00.000Z"
timezone: America/Chicago
summary: Contractor qualification and property deed mismatches stalled
  multiple household files, triggering a community trust crisis...
decisions:
  - Prioritize direct phone calls to affected households before public meetings
  - Use 'real blocker plus specific next step' frame in public communication
open_loops:
  - Whether overall community trust can recover after timeline delays
  - How to balance individual calls and collective meetings under tight resources
tags:
  - work-pressure
  - housing-project
  - trust-crisis
  - community-communication
emotional_tone: mixed
---

## Turn 1 — 2023-04-21T06:10:00.000Z (user)

The housing rehab files that were supposed to close this month are
stalled again. At the public meeting last night residents were angry...

## Turn 2 — 2023-04-21T06:13:00.000Z (agent)

That sounds rough. What specifically broke down — contractor
qualification, property deeds, or something else?
```

这个文件的每一部分都是人类可读、git-diff 友好且能被任何处理 Markdown 和 YAML 的工具解析的。Gray-matter 在 Rust/TypeScript 端完成解析。

## Strands：基于切片的语义索引

每个切片带有 `tags`。当一个切片关闭时，`updateStrands()` 将每个标签编织到 `memory/episodic/strands.json` 中——一个将关键词映射到切片路径的单一文件：

```json
{
  "work-pressure": [
    "2023/04/21/0610",
    "2023/04/22/0915"
  ],
  "housing-project": [
    "2023/04/21/0610"
  ],
  "trust-crisis": [
    "2023/04/21/0610"
  ]
}
```

**strand（主题）**就是某个关键词的条目——"某件事情的完整历史"在时间上的贯穿。它是在情景切片之上构建的轻量、无损的语义记忆层。标签在切片关闭时聚合为主题；读取主题用于回忆是未来的里程碑（实验性功能）。

```preview
demo: strands-index
```

## 切片如何与 worker 和主模型协同工作

**worker/主模型分工**管控元数据和回忆：

- **worker 扫描**（已解析的 worker 模型）在每一轮对话中运行。它维护切片的前置元数据——focus、summary、decisions、open loops、tags、emotional_tone。它还扫描最近已关闭切片的摘要以进行回忆命中。如果维护调用失败，则使用安全默认值（intent 设为 `"chat"`，不更新元数据）。
- **主模型深度读取**（主模型）在 worker 未返回结果或问题需要更丰富上下文时，通过 `readSlice` 工具读取完整的切片正文执行深度回忆。

当一个切片关闭时，worker 冻结元数据，切片在磁盘上密封。

## 存储后端

子系统在两个后端之间透明切换：

| 环境 | 后端 | 选择条件 |
|-------------|---------|-----------|
| 开发环境 | 本地文件系统 | 未设置 `GITHUB_TOKEN` |
| 生产环境 | GitHub REST API | 存在 `GITHUB_TOKEN` |

所有 I/O 通过管理器中的 `fsReadFile`/`fsWriteFile`/`fsListFiles` 封装函数进行。相同的代码路径在两个环境中均可工作——无需手动切换。

## 关闭时维护的索引

当一个切片关闭时，两个辅助结构会更新：

1. **月度索引**（`memory/episodic/slices/YYYY/MM/_index.json`）——一个由精简条目（`SliceIndexEntry`: id、focus、summary、tags、status、start、open_loops、decisions）组成的 JSON 数组。使时间线 UI 能够在无需读取每个文件的情况下浏览标题。
2. **主题索引**（`strands.json`）——上述的关键词到切片的映射。条目经过去重，确保同一切片不会在同一标签下出现两次。

## 设计原理

- **仅基于时间的切片**使系统保持可预测。容量阈值和基于 worker 的连续性启发式逻辑在当前阶段增加了复杂性而没有带来经过验证的好处——它们在 M8 中被移除。
- **内存中的活跃切片配合定期快照**避免了过多的 GitHub API 写入。切片存在于模块级变量中，每 N 个轮次和在 `beforeunload` 时快照，但绝不在*每一轮*都写入。
- **YAML 前置元数据 + Markdown 正文**是所有文档生态系统的原始素材。它在任何 Markdown 查看器中都能渲染，在 git 中差异清晰可见，并且解析器存在于每种语言中。Gray-matter 处理 TypeScript 端。
- **情景与语义分离**呼应了 Endel Tulving 1972 年的理论。切片是情景性的（按*何时*组织）。主题（strands）和记忆节点（memory nodes）是语义性的（按*什么*组织）。回忆先扫描*何时*，再检索*什么*。

## 相关文档

- [时间线（Timeline）](/zh/docs/timeline) —— 按日期浏览切片的水平日期点条
- [主题索引（Strands）](/zh/docs/strands) —— 切片档案的语义标签索引
- [回忆（Recall）](/zh/docs/recall) —— worker 扫描与主模型检索
- [记忆系统（Memory System）](/zh/docs/memory-system) —— 三层架构
