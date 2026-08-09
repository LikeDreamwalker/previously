# 记忆模型

Previously 摒弃了数据库和向量存储。记忆是 git 仓库中的纯 Markdown 文件——情景时间片记录发生了什么、何时发生，语义 strand 和知识节点记录事物是什么——在推理时根据 token 预算进行组装。

## 情景记忆：时间线

Previously 将每次对话爆发记录为一个 **slice**：个人时间线上的一篇 Markdown 文件。路径精确告诉你它发生在何时：

```
memory/episodic/slices/2025/11/21/0825.md
```

一个日历天是一个目录，可能包含多个 slice 文件。Slice 在你开始说话时开启，在你保持参与期间持续活跃，并在静默 30 分钟后自动关闭（`src/lib/episodic/slicer.ts`）。跨月跨年地自上而下阅读，slices 构成了你的自传——发生了什么、何时发生，按时间顺序排列。

每个 slice 都带有包含结构化元数据的 YAML frontmatter：

```yaml
---
focus: Planning the M8 flash overhaul
summary: Reviewed slicer architecture, decided on time-only slicing
open_loops: [strand integration, demo mode scope]
decisions: [Slice by time only; no topic-based splitting]
tags: [m8, episodic, architecture]
related_slices: [2025/11/20/1430.md]
emotional_tone: focused
status: closed
start: 2025-11-21T08:25:00Z
end: 2025-11-21T09:10:00Z
---
```

对话轮次以 `## Turn N -- ISO_TIMESTAMP (role)` 标题的形式呈现在 Markdown 正文中。此格式由 gray-matter 库管理——每个 git 客户端、每个编辑器以及每个 LLM 都能解析它，无需专有工具。

> **关键要点：时间线是由时间驱动的，而非主题驱动的。** 有对话时 slice 开启，静默时关闭。没有容量限制，也没有主题切换规则。你的对话历史是无损且按时间顺序排列的。

```preview
demo: slice-file
```

## 语义记忆，第一层：Strands

**Strand** 是一个关键词——比如 `work`、`family`、`health`、`housing`——贯穿所有携带它的 slice。文件 `memory/episodic/strands.json` 将每个 strand 映射到其 slice 路径：

```json
{
  "strands": {
    "housing": [
      "memory/episodic/slices/2025/03/10/0915.md",
      "memory/episodic/slices/2025/04/02/1400.md",
      "memory/episodic/slices/2025/06/18/1100.md"
    ],
    "work": [
      "memory/episodic/slices/2025/06/18/1100.md",
      "memory/episodic/slices/2025/07/01/0800.md"
    ]
  }
}
```

Strands 在 slice 关闭时通过 `updateStrands` 构建。Slice = 发生了什么；strand = 它关于什么。Strands 构成了情景时间线上薄而无损的语义索引——某个主题跨时间的完整历史，无需复制内容。

> **路线图：** Strands 目前不含滚动摘要。更丰富的第一类 strand（带有自己的叙事摘要和召回集成）是未来的里程碑。

```preview
demo: strands-index
```

## 语义记忆，第二层：记忆节点

**记忆节点** 是 `memory/nodes/` 下独立的结构化知识单元，由 Previously 自己（主模型，通过 `writeFile`）在对话揭示出关于你的真正值得注意的信息时编写。与自动构建的关键词索引 strands 不同，nodes 是手动或代理撰写的知识单元，具有类型化 schema：

| 字段 | 用途 |
|-------|---------|
| `type` | `concept`、`experience`、`project`、`people` 或 `personality` |
| `priority` | 1–10，默认为 5 |
| `domain` | 分类领域，默认为 `general` |
| `tags` | 用于匹配的关键词标签 |
| `related` | 链接到其他节点 ID |
| `backlinks` | 来自 YAML frontmatter 的反向链接（静态） |
| `status` | `active` 或 `deprecated` |
| `access_count` | 尚未实现（scorer 会读取但从未写入） |
| `last_accessed` | 仅日期字符串（YYYY-MM-DD） |
| `superseded_by` | 取代此节点的节点 ID |

节点相关性在召回时进行评分：

```
score = (priority
         + keyword-tag-match[+5 each]
         + graph_bonus[+2 per already-selected linked node]
         + freq_bonus[min(access_count * 0.3, 3)])
         * time_decay

where time_decay = 0.9^(daysSinceAccess / 7)  ~10% decay per week
```

已弃用的节点始终得分为 0。此评分为上下文组装器的选择提供依据。

## 分层记忆：L0/L1 与 L2

记忆按加载时机分为三个层级：

| 层级 | 内容 | 加载时机 | 可变？ |
|------|------|----------|--------|
| **L0** | 代理宪法（SOUL） | 构建时打包 | 运行时不可变 |
| **L1** | 代理指令（DIRECTIVES） | 构建时打包 | 运行时不可变 |
| **L2** | 情景 slices + strands + nodes | 运行时按需获取 | 工具可写 |

L0 和 L1 由 `scripts/generate-identity.mjs` 在构建时生成并编译为字符串。它们的源文件位于工具白名单之外——代理无法重写自己的灵魂。L2 通过工具从文件系统实时读取，情景记忆、strands 和 nodes 就存在于此。

用户档案（`memory/user/profile.md`）是一种混合体：它从 `memory/` 实时加载（运行时 L2），但通用的 `writeFile` 工具被阻止编辑它——只有专用的 `updateUserProfile` 工具才能修改它。

## 白名单边界

代理工具被限制在三个可写目录内（`src/lib/whitelist/index.ts`）：

```
memory/   tasks/   sessions/
```

`src/` 目录是代理**只读**的，任何工具都不可修改。路径验证会规范化输入——解码 URI 组件、将反斜杠转为正斜杠、解析 `./` 和 `../`、去除前导斜杠——然后在匹配允许的前缀之前拒绝空路径、绝对路径（`/`）和驱动器字母路径（`A:`）。

在白名单内，某些路径可读但禁止写入：

- `memory/episodic/`——系统拥有的 slices 和索引
- 任何 `_index.json` 文件
- `strands.json`
- `memory/user/profile.md`——只能通过其专用工具编辑

这可以防止意外或恶意损坏情景时间线和结构索引。

## 基于 Token 预算的上下文组装

当 Previously 构建提示词时，`src/lib/context/assembler.ts` 在默认 8,000 token 预算下打包 5 层负载：

| 层 | 内容 | 预算规则 |
|-----|---------|-------------|
| 0 | 系统提示词（宪法 + 指令） | 完整，始终包含 |
| 1 | 核心记忆节点（完整内容） | 上限为 budget × 0.7（为后续层预留 30%） |
| 2 | 会话摘要 + 最近轮次 | 每轮截断至 300 字符 |
| 3 | 扩展节点（仅摘要） | 第一段 ≤ 200 字符；到达 budget − 500 时停止 |
| 4 | 引用节点 | 仅 `[[wikilink]]` 标题 |

Token 估算采用启发式方法（`ceil(chars / 4)`）——不是真正的 tokenizer。随着预算填满，详细程度逐步下降：完整节点内容让位于摘要，摘要再让位于纯标题。这保证了每个请求都适合模型的上下文窗口，而不会硬性截断关键层。

## 为什么选择纯 Markdown + YAML

没有数据库，没有向量存储，也没有专有格式。每一段记忆都是一个带 YAML frontmatter 的 Markdown 文件。这个选择是经过深思熟虑的：

- **可移植** —— `git clone` 到任何地方，在任何设备上阅读，无需服务器。
- **Git 可比较** —— 对 slice、node 或 strand 的每次更改都记录在版本历史中。你可以看到 Previously 学习了什么以及何时学习的。
- **人类可编辑** —— 在 VS Code 中打开任意 slice，修正摘要，添加标签。无需管理 UI，无需 SDK。
- **任何工具都能读取** —— Previously 编写，Claude Code 读取，Codex 扩展。无锁定，无集成成本，无 schema 迁移。

文件即接口。

## 两层召回

召回遵循 Tulving 奠基的情景优先、语义其次的顺序：先扫描何时发生，再检索发生了什么。

1. **worker 扫描**（已解析的 worker 模型）——扫描最近的 slice 摘要，返回指向相关 slice 的指针。每轮元数据维护（tags、strands、summaries）通过 turn analyzer 折叠到这一轮往返中，该方法在 300ms 后重试一次，并回退到安全默认值。
2. **主模型深度读取**（主模型）——调用 `readSlice` 工具读取完整的 slice 内容以进行深度召回。这是昂贵、彻底的传递，从原始时间线中重建上下文。

这种分工让快速操作保持快速，同时将模型容量保留给需要它的工作。

## 相关

- [架构概览](/content/docs/en/architecture)
- [Agent 循环](/content/docs/en/agent-loop)
- [白名单与安全](/content/docs/en/security)
