# 回忆（Recall）

回忆是 Previously 检索相关历史对话的方式——这是一个双层引擎：廉价的 worker 模型返回轻量级指针，然后主模型读取它选中的切片，整个过程在一次回合内完成。

## 双层回忆引擎

Previously 中的情景记忆以**切片（slice）**的形式存储——位于 `memory/episodic/slices/2025/11/21/0825.md` 这类路径下的 Markdown 文件，每个文件对应一次对话爆发，在你说话时打开，在静默 30 分钟后关闭。经过数周和数月，这些切片会积累成一个深度档案。挑战在于：Agent 如何在不每次读取所有内容的情况下找到重要的信息？

Previously 将这个问题拆分为两个反射层次：

| 层次 | 模型 | 成本 | 作用 |
|-------|-------|------|-------------|
| **worker 扫描**（条件反射） | 解析出的 worker 模型 | 便宜、快速 | 扫描近期切片摘要，返回**指针**——`{ slice_id, relevance, reason }`——从不返回完整内容 |
| **主模型深读**（审慎推理） | 你在工具栏选的主模型 | 较慢，启用思考 | 接收指针，通过 `readSlice` 按需读取完整切片，当扫描未找到结果时直接探索目录 |

worker 的设计允许出错。它以完整性换取速度：它读取的是摘要，而非完整正文。主模型是安全网——它可以在指针所指的方向深入挖掘，或者从头开始探索目录树。

> **要点**：worker 回答"往哪里找。"主模型回答"这意味着什么。"两者不可互相替代。

### 第 1 步：worker 扫描（观察约 500ms）

扫描在**响应流打开之前**运行。每个用户请求触发 `recall` 工具（`src/app/api/agent/tool-executors.ts` 中的 `recallExecute`），在单次往返中调用 worker 模型。扫描读取近期已关闭切片的摘要并判断相关性。

扫描返回带 `hits` 数组的结构化结果。每个命中是一个指针——切片 ID、相关性分数（0–1）以及一行匹配原因。模型被提示最多返回 5 个。

**worker 不读取主题索引**（strand index，即 `strands.json`）。主题索引（在切片关闭时建立的从关键词到切片路径的映射）存在于磁盘上，主模型可以通过 `readStrand` 按需访问它，但 worker 扫描本身只搜索近期切片摘要。

> **回忆一次，然后停止。** 如果扫描什么都没找到，那就是确定性的答案——该查询没有过去的上下文。Agent 被指示不要为同一个主题再次调用 `recall`，而是从对话和自身知识作答。

```preview
demo: thinking-steps
```

回忆阶段渲染为一个可折叠卡片，带 History 图标。折叠时：显示查询与命中数。展开时：每条命中显示为 `slice_id` + 原因 + 相关性百分比、一行斜体推理文字以及置信度。

### 第 2 步：深读

worker 的指针列表被注入主模型的上下文。主模型决定通过调用 `readSlice` 工具完整打开哪些切片。它还可以追踪线索（`readStrand`）、浏览时间线（`readTimeline`、`listSlices`、`listStrands`），或查看它已有的信念（`readPreviously`）。

| 工具 | 用途 |
|------|---------|
| `readSlice` | 读取一个切片的轮次，可选 `range` |
| `readStrand` | 跨携带它的切片追踪一个关键词 |
| `readPreviously` | 读取用户卡片的信念快照 |
| `readTimeline` / `listSlices` / `listStrands` | 探索时间线与索引 |

当 worker 找到命中时，主模型会收到指导："这些摘要通常就足够了——只有在需要摘要未包含的细节时，才读取特定切片。"当扫描未找到任何内容时，主模型被指示直接探索目录——如果它想要关键词索引，则从 `strands.json` 开始。

### 第 3 步：元数据维护

执行扫描的同一个 housekeeping 环节也会为**当前活跃切片**——即当前对话正在写入的切片——提议元数据更新。回合分析器（`src/lib/episodic/flash/turn-analyzer.ts`）是 housekeeping 内的唯一 worker 模型调用，在一次廉价扫描里产出三样东西：

- **message_tags** —— 当前用户消息的关键词标签（编织进线索）
- **semantic_hint** —— 这条消息关于哪些已有线索，以及为什么
- **closed_marking** —— 即将关闭切片的 focus、summary、精炼标签与情绪基调

一个**语义门**随之运行：琐碎回合（「谢谢」「继续」）不产生标签、不进线索索引、不触发演化——一次性噪音不会污染时间线。

## 三阶段聊天渲染

单条助手消息渲染为三个视觉上不同的阶段，在 `ChatMessage` 中按 part 类型划分：

```
推理（大脑图标，可折叠卡片，在气泡内）
    |
    v
回忆 / 工具（历史/工具图标，内联卡片）
    |
    v
响应（文本 + 行内工具调用，在气泡内）
```

```preview
demo: thinking-steps
```

### 1. 推理阶段

当主模型启用了思考功能（默认：开启，推理程度按工具栏选择），推理作为 `reasoning` parts 流出。客户端将其渲染为 `ThinkingSteps`——一个带 Brain 图标的 `PhaseIndicator` 可折叠卡片。

- **折叠摘要**："思考 · Ns"计时器
- **展开内容**：推理 markdown

### 2. 回忆 / 工具阶段

工具调用通过 `ToolRenderer` 以内联可折叠卡片渲染，各带人类可读标签：

| 工具 | 你看到 |
|------|--------|
| `recall` | Recalling "..."（回忆中） |
| `readSlice` | Viewing {date}（查看中） |
| `readStrand` | Following "..."（追踪中） |
| `readPreviously` | 正在读前情提要… |

每张卡片有五种视觉状态：**运行中**（spinner）、**已完成**（圆点）、**错误**（红）、**中断**（黄）、**拒绝**（红）。点击展开查看完整工具输出——CSS `grid-template-rows` 过渡，无需 JS 测高。

### 3. 响应阶段

响应正文在 `Bubble` 内渲染。文本通过 `MarkdownRenderer`（react-markdown + remark-gfm + rehype-highlight）处理。工具调用按照主模型调用的顺序以内联方式出现，每个由对应的工具渲染器包装。

## 相关文档

- [切片（Slices）](/docs/zh/slices) —— 切片如何创建、关闭和索引
- [主题索引（Strands）](/docs/zh/strands) —— 跨切片的语义关键词索引（实验性）
- [架构（Architecture）](/docs/zh/architecture) —— 回合 workflow 与消息渲染的完整组件树
