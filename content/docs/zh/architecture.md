# 架构

Previously 是部署在 Vercel 上的云端 Agent，读取 GitHub 文件、调用 LLM、把响应流式传回——没有数据库，没有定时任务，没有持久化服务器。让它与众不同的，是**每一轮聊天都跑在一次耐久的 Vercel Workflow 运行里**：每一次 LLM 调用、每一次工具调用，都是单独耐久、自动重试的步骤。GitHub 仍是记忆的唯一事实来源——Workflow 只是执行容器。

## 三层架构

系统分为三个层，每层有明确的职责和严格的边界：

| 层 | 是什么 | 做什么 |
|-------|------------|--------------|
| **浏览器 / 手机** | Next.js App Router UI | 渲染聊天界面。捕获输入。流式输出响应。仅此而已——没有业务逻辑，没有状态机，没有本地记忆。 |
| **Vercel** | 编排层 | 接收触发 → 读 GitHub 状态 → 运行 Agent workflow → 写回。无状态、事件驱动、耐久。 |
| **GitHub 私有仓库** | 单一事实来源 | 保存一切：`src/`（agent 只读）、`memory/`、`tasks/`、`sessions/`（agent 可读写）。代码和数据共存于一个仓库中。 |

> **关键要点：没有数据库，没有常驻 agent，没有持久连接。** Previously 完全运行在 Vercel 的请求生命周期内。你发送一条消息，回合 workflow 触发，响应流式传回。响应结束时没有后台进程——除非有耐久循环在跑，而即使那样，它的状态也持久化到仓库，而不是某台服务器。

## 耐久的回合 Workflow

整个 Agent 是 `src/app/api/chat/turn-workflow.ts`——一个 `"use workflow"` 控制器。每个用户消息触发一次这样的运行：

1. **日常维护（housekeeping）** —— 解析或恢复当前时间切片，应用 30 分钟静默规则，追加本轮用户消息。
2. **worker 扫描** —— 一个廉价 worker 模型（从主模型供应商派生）在一次调用里扫描近期切片摘要找回忆指针、维护切片元数据，并应用**语义门**：琐碎回合（「谢谢」「继续」）不产生标签、不进线索索引。
3. **组装 prompt** —— 系统 prompt 由身份、用户卡片、情景时间线上下文组装而成。
4. **主模型 Agent 循环** —— 主模型作为 `WorkflowAgent`（`@ai-sdk/workflow`）运行。每一次 LLM 调用、每一次工具调用都是它自己的耐久步骤：工具执行器是 `src/app/api/agent/tool-executors.ts` 里独立的 `"use step"` 函数，运行时对瞬时失败自动重试。Agent 推理、回忆、读取、回答。
5. **收尾（finalize）** —— 追加本轮、保存切片快照、更新索引与线索。

因为每一步都耐久，运行能扛住断线。客户端的 `WorkflowChatTransport` 在标签页回到前台时重新挂到同一次运行上，回放错过的东西。后台循环用同一个 agent 层，跑在独立的 workflow 运行里。

## Agent 层

Agent 层在 `src/app/api/agent/`，聊天回合与任何后台循环共用：

| 文件 | 用途 |
|------|------|
| `agent.ts` | 创建 `WorkflowAgent`，配置模型、思考、工具集 |
| `tools.ts` | 工具定义（schema + context schema）——聊天 Agent 的工具集 |
| `tool-executors.ts` | 每个工具的独立 `"use step"` 执行器 |
| `register-model-classes.ts` | 注册模型 host，使它们能跨 workflow→step 边界重建 |

### 工具

聊天 Agent 拿到的是一套小而克制的工具。概念工具（读取你给了它 id 的切片 / 信念 / 认知）：

| 工具 | 用途 |
|------|------|
| `readSlice` | 读取一个切片的轮次，可选 `range` |
| `readPreviously` | 跨时间读取用户卡片的信念快照 |
| `readAgentTimeline` | 读取 Agent 自己过去的推理 |
| `listSlices` / `readTimeline` | 浏览时间线（主要是回忆引擎的活） |
| `listStrands` / `readStrand` | 跨切片追踪一个关键词 |

委托工具：

| 工具 | 用途 |
|------|------|
| `recall` | 把真正的搜索交给 worker 模型的回忆引擎，返回指针 |
| `webSearch` / `webFetch` | 上网查资料 |

> **回忆一次，然后停止。** 主 Agent 不自己浏览记忆——探索是回忆引擎的活。它调用一次 `recall`，用 `readSlice` 读需要的内容，然后继续。`startLoop` 已定义但当前被注释掉（后台循环在稳定化期间暂时禁用）。

## 双层模型分工

模型层（`src/lib/models/`）解析出两层：

- **主模型** —— 用户在聊天工具栏选，持久化到 `memory/user/config.json`。负责推理、工具调用、生成回答。
- **worker 模型** —— 从主模型供应商派生的廉价档（或手动固定）。跑日常维护调用：回忆扫描、元数据维护、语义门。这样每轮成本低，重活交给主模型。

`resolveWorkerModel()`（`src/lib/models/worker.ts`）的选择顺序：手动固定 → 同供应商轻量档 → 主模型。目录是 models.dev 驱动的（`src/lib/models/catalog.ts`），以配置的 API key 环境变量为门槛，并按各供应商实时 `/models` 端点反过滤。

## 前端架构

Next.js App Router 强制执行严格的服务器组件/客户端组件边界。`page.tsx` 是一个服务器组件，预加载用户配置、设置演示人格，然后渲染 `ChatPage`——一个持有 AI SDK `useChat` hook（配 `WorkflowChatTransport`）的轻量客户端外壳。

页面是一个垂直滚动器：

1. **Hero** —— 服务端渲染的 `"Previously on {名字}"`。
2. **吸附的横向时间线** —— `HorizontalTimeline`，一排日期圆点，吸附在 AppHeader 下方。
3. **聊天内容** —— 实时消息；选中过去的圆点时是历史切片视图。
4. **吸附的输入栏** —— 带模型选择器、思考开关、图片附件和演示触发按钮。

消息渲染是一条统一流式管道（`src/lib/chat/build-stream.ts`）：推理合并进 `ThinkingSteps`，工具调用按 `toolCallId` 合并进 `ToolRenderer` 卡片，`data-phase` 部分变成 `PhaseIndicator`，`data-evolution` 部分驱动每条气泡的 `EvolutionIndicator`。一切通过 `AnimatePresence` 内联渲染在助手气泡内。

## 核心模块

| 模块 | 路径 | 用途 |
|--------|------|---------|
| 能力 | `src/lib/capabilities.ts` | 全局应用模式检查（isAIConfigured、isDemo、canWrite） |
| 情景记忆 | `src/lib/episodic/` | 时间切片管理、切片规则、线索索引 |
| 回合分析器 | `src/lib/episodic/flash/turn-analyzer.ts` | worker 模型的日常维护调用 |
| 时间本地化 | `src/lib/episodic/time-localize.ts` | 读工具的服务端本地时间标注 |
| 用户卡片 | `src/lib/episodic/previously-*` | 紧凑用户卡片 + `applyCardUpdate` |
| 模型注册 | `src/lib/models/` | models.dev 目录、供应商分发、worker 解析 |
| GitHub 工具 | `src/lib/tools/` | 通过 Octokit 的 readFile/writeFile/listFiles |
| 路径白名单 | `src/lib/whitelist/` | 安全边界：仅 memory/tasks/sessions |

## 安全模型

安全完全在 TypeScript 的工具边界强制执行。

### 路径白名单

`src/lib/whitelist/index.ts` 定义仅有的三个可写目录：

```
memory/   tasks/   sessions/
```

`normalizePath()` 解码 URI 组件、把反斜杠转正斜杠、解析 `./` 与 `../` 片段、去掉前导斜杠。`isPathAllowed()` 拒绝空路径和绝对路径（Unix 与 Windows 盘符），然后检查路径是否以三个允许前缀之一开头。

### `src/` 是 Agent 只读

`src/` 目录根本不在白名单里。没有 Agent 工具能写进去。Agent 可以通过 git 读 `src/`，但不能改——路径白名单拒绝写尝试。这保证代码库完整性独立于 Agent 的执行。

### GitHub Token 范围

`GITHUB_TOKEN` 限定为单个仓库的 contents 读写。Agent 只操作一个仓库：由 `GITHUB_REPO_OWNER` / `GITHUB_REPO_NAME` 定义的那个。没有跨仓库访问。

所有路径验证都在服务端——客户端不可信。浏览器从不构造文件路径或做存储决策。

## 数据源模式

存储有三种模式，由 `STORAGE` 控制：

| 模式 | 何时用 | 行为 |
|------|--------|------|
| `local` | 本地开发 | 读写本地文件系统 |
| `github` | 生产环境 | 通过 GitHub API（Octokit）读写你的仓库 |
| `demo` | 预览 | 只读，内置人格 |

自动检测：有 `GITHUB_TOKEN` → `github`；`NODE_ENV=development` → `local`；否则 → `demo`。

## 接下来（路线图）

- 一等公民的线索——每条线索带滚动摘要与回忆集成
- 重新启用后台循环（`startLoop` 已定义但被注释）
- 时间线上更丰富的跨切片导航
- 更多演示人格

项目状态徽章是 **实验阶段**。

## 相关

- [记忆模型](/content/docs/zh/memory-model) — 切片、线索与用户卡片如何工作
- [回忆](/content/docs/zh/recall) — 双层检索流水线详解
- [时间线](/content/docs/zh/timeline) — UI 表面以及 Agent 如何看待你的过去
