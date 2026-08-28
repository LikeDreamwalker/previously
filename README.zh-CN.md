<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">中文</a>
</p>

<p align="center">
  <img alt="Previously — 落地页、时间线与输入栏" src="public/screenshots/chat-dark.png" width="800">
</p>

<p align="center">
  <strong>Previously on you.</strong>
</p>

<p align="center">
  一个按「时间」记忆、而不是按「聊天线程」记忆的 AI Agent。
</p>

<p align="center">
  <a href="https://previously.ldwid.com"><strong>previously.ldwid.com</strong></a>
  ·
  <a href="https://previously.ldwid.com/docs/recall"><strong>在线 Playground</strong></a>
  ·
  <a href="https://previously.ldwid.com/docs"><strong>文档</strong></a>
  ·
  <a href="https://github.com/previously-lab/agent"><strong>GitHub</strong></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-experimental-orange" alt="状态：实验阶段">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="协议：MIT">
  <a href="https://sdk.vercel.ai"><img src="https://img.shields.io/badge/AI_SDK-v7-8b5cf6" alt="AI SDK v7"></a>
  <img src="https://img.shields.io/badge/Next.js-16.3-black" alt="Next.js 16.3">
  <img src="https://img.shields.io/badge/TypeScript-6.x-3178C6" alt="TypeScript 6">
  <img src="https://img.shields.io/badge/Tailwind_CSS-4-38bdf8" alt="Tailwind CSS 4">
  <img src="https://img.shields.io/badge/memory-episodic-ec4899" alt="记忆：情景记忆">
</p>

---

## 这是什么

Previously 是一个轻量的云端 Agent——打开一个浏览器标签页，它就在那里。它能读、能写、能思考、能替你行动。它和其他 Agent 最大的不同不在某个单一功能，而在于：**没有「对话」。** 只有一段持续的关系，排布在一条时间线上。

大多数 AI Agent 把你的生活切成一堆聊天线程。每开一个新线程，一切从零开始。记忆被割裂、脆弱、易失。那个「会话列表」——从即时通讯软件继承来的界面产物——成了 AI 的默认交互模型，可人类的关系从来不是这样运作的。

Previously 用**时间切片**取代聊天线程：一种按人类记忆真实运作方式组织的情景记忆——先按_什么时候_发生的，再按_关于什么_。你不需要管理对话。你只需要出现、说话。因为上下文是从时间线上动态组装，而不是塞进一个越滚越大的 prompt 窗口，所以永远不会出现 Agent 突然「忘记」长对话开头的那一刻。

名字来自电视剧开场前的闪回：_"Previously on…"（前情提要）_——一段简短回顾，提醒你上次发生了什么，刚刚好够你接上剧情。

> 想了解背后的理念？读这篇深度文：[时间是不是 AI 记忆缺失的维度？](https://dev.to/likedreamwalker/is-time-the-missing-dimension-in-ai-memory-2l9c)（英文）

---

## 它长什么样

每次打开，你看到的是一条过去的时间线——而不是一列聊天线程。Agent 的思考、记忆回忆、每一次工具调用，都在答案流式输出的同时渲染在气泡里。没有黑箱。

<p align="center">
  <img alt="一次真实的 Agent 回合——思考、回忆、工具调用、回答一起流出" src="public/screenshots/conversation-dark.png" width="800">
</p>

<p align="center">
  <sub>一次真实回合：它先思考，回忆关于你的已知，读取记忆文件，搜索网页，然后回答——全部实时可见。</sub>
</p>

思考、回忆、输入栏——每一块都是独立的卡片。

<p align="center">
  <img alt="Agent 的内部思考" src="public/screenshots/thinking-steps.png" width="480">
  <br>
  <img alt="带模型选择器的聊天输入栏" src="public/screenshots/chat-input.png" width="260">
</p>

亮色、暗色，桌面、手机——它都适配。

<p align="center">
  <img alt="Previously 亮色模式" src="public/screenshots/chat-light.png" width="390">
  <br>
  <img alt="Previously 移动端" src="public/screenshots/chat-mobile-dark.png" width="180">
</p>

---

## 为什么重要

两个其实是同一个的问题：

1. **跨会话的记忆是坏的。** 跨会话回忆需要向量数据库、RAG 流水线和脆弱的 prompt 工程——即便如此，结果还是像在跟一个失忆的人说话。

2. **会话不是正确的容器。** 人类不会把记忆整理成「第 47 个聊天」。我们按_什么时候_发生、_关于什么_来记忆。「会话列表」是一个界面产物——不是认知模型。

修好记忆模型，交互模型自然就顺了。如果一个 Agent 真的记得你——跨时间、跨主题、跨几天几周的空档——那你根本不需要对话管理。你只需要出现、说话。

---

## 切片、线索、回忆

**切片（slice）**是一次对话片段——时间线上的一个 Markdown 文件。你开口时它打开，30 分钟沉默后关闭。每个切片携带摘要、决策、未决事项和标签（YAML frontmatter）。自上而下读过几个月、几年，切片就是你的自传。

**线索（strand）**是一个关键词——比如 `工作`、`家庭`、`健康`——出现在多个切片里。一个轻量索引把每条线索映射到所有携带它的切片：这个话题的完整历史。

> 切片 = 发生了什么。线索 = 关于什么。两者合起来，你就同时有了情景记忆和语义记忆——按时间记，也按主题记。

<p align="center">
  <img alt="时间线滚轮——所有切片在同一根轴上，打开即是现在" src="public/screenshots/timeline-strip.png" width="140">
</p>

当你问到涉及过去的事，主 Agent 会向一位**回忆同事（recall colleague）**提问——一个专门的子 Agent，像人回忆一样检索：先锁时间窗，再追话题线索，最后限额深读切片全文。它用自然语言回答，每个断言都挂原文引用，并附上它找过的路径——「我们不记得聊过这个」也是诚实、合法的答案。结果以一张卡片渲染在回答上方。

<p align="center">
  <img alt="回忆卡片——匹配到的切片，带相关度分数与理由" src="public/screenshots/recall-card.png" width="640">
</p>

完整的图景——回忆同事的契约、文件结构、YAML 结构，以及背后的认知科学——见 [记忆模型](https://previously.ldwid.com/docs/memory-model) 与 [架构](https://previously.ldwid.com/docs/architecture) 文档。

---

## 它是怎么搭的

三层，层与层之间一条硬边界：

| 层 | 是什么 | 做什么 |
|----|--------|--------|
| **浏览器 / 手机** | Next.js UI | 渲染对话、捕获输入、流式输出响应。不承载业务逻辑。 |
| **Vercel** | 编排层 | 读 GitHub 状态 → LLM 决策 → 执行 → 写回。无状态、事件驱动。 |
| **GitHub 仓库** | 真相之源 | `src/`（Agent 只读）+ `memory/`/`tasks/`/`sessions/`（Agent 可读写）。 |

两件让它与众不同的设计：

**没有数据库。** 你的记忆是带 YAML frontmatter 的纯 Markdown，提交进你自己的私有 GitHub 仓库。每个文件任何工具都能读、能移植到任何系统、由 git 做版本控制。没有云端数据库、没有向量存储、没有私有格式。你的记忆属于你。

**每一轮都是一次耐久运行。** 每次对话轮次都跑在 Vercel Workflow 里——每一次 LLM 调用、每一次工具调用都是独立耐久、自动重试的步骤。关掉标签页、锁屏、断网：Agent 会继续，等你回来它重新接上，把错过的东西补给你看。后台任务同理。

---

## 它能做什么

- **情景记忆**——时间切片存储，只有一条规则（沉默 30 分钟就关闭切片）
- **过程可见**——思考、回忆、工具调用全部实时内联流出，没有黑箱
- **同事制回忆**——回忆子 Agent 以证据锚定、附原文引用的方式回答；主 Agent 只保留校验通道
- **达尔文式自进化**——方向文档（`memory/evolution/direction.md`）定义「怎样才算对你更好」；证据锚定的 fitness 评分决定「要不要进化」；每个被接受的变更都进入 append-only 的变异档案。用户卡片只是这个回路的产物，而不是回路本身
- **处处是你的本地时间**——读工具预渲染你的本地时间，Agent 永远不会算错时区
- **琐碎回合不进记忆**——语义门把「谢谢」「继续」挡在时间线之外
- **多模型**——DeepSeek、Anthropic 以及任何 OpenAI 兼容供应商，工具栏可自选主模型
- **客户端模式**——整个系统可以作为本地内核运行：大脑用你本机已有的 Claude/Codex/Kimi 订阅（零配置、零 API key），或自带 API key（BYOK）获得与云端一致的完整流式体验
- **耐久后台任务**——长任务跨断线持续运行并回报进度
- **English & 中文**——完整国际化，支持暗色主题

---

## 在 Playground 里试试

文档站里嵌了一个**交互式 Playground**——基于 [`you`](https://github.com/previously-lab/you) 数据集（97 个时间片，2024→2026，由 [Loom](https://github.com/previously-lab/loom) 生成）真实跑回忆与自进化。无需注册、无需 API key：在[回忆文档页](https://previously.ldwid.com/docs/recall)点一个预设问题，看 Agent 真的想起来——思考流、检索轨迹、流式回答，全是真跑出来的。

---

## 自己跑一个

**简单方式——本地客户端（推荐）。** 一个 npm 包把内核装到你本机；记忆是本地 git 仓库，大脑可以用你已有的 Claude/Codex/Kimi 订阅（零 API key），也可以自带 key：

```bash
npm i -g @previously-lab/client@preview
previously     # 首次运行进入引导式初始化
```

见 [previously-lab/client](https://github.com/previously-lab/client) 与[文档](https://previously.ldwid.com/docs/getting-started)。

**云端方式——自托管本仓库。** 一个部署在 Vercel 上的 Next.js 应用，用你自己的 GitHub 仓库做存储：

1. **创建仓库** — 点击 [Previously 仓库](https://github.com/previously-lab/agent) 的 "Use this template" 按钮，或直接 fork，然后设为**私有**。你的记忆就存在这里。

2. **部署到 Vercel** — [导入你的仓库](https://vercel.com/new)，配置这些环境变量：

   | 变量 | 用途 |
   |------|------|
   | `GITHUB_TOKEN` | 对你的私有仓库拥有 contents 读写权限的 GitHub token |
   | `GITHUB_REPO_OWNER` | 你的 GitHub 用户名或组织 |
   | `GITHUB_REPO_NAME` | 你的私有仓库名 |
   | `DEEPSEEK_API_KEY` | DeepSeek API key（任何 AI SDK 支持的供应商均可） |

3. **或者本地运行** — `git clone` 你的仓库，`pnpm install`，`pnpm dev`。加 `PREVIOUSLY_MODE=client` 即为完全本地内核（文件系统存储，无需 GitHub 仓库）——`@previously-lab/client` 打包的正是这个模式。

存储有三种模式，由 `STORAGE` 控制：

| 模式 | 何时用 | 行为 |
|------|--------|------|
| `local` | 本地开发 | 读写本地文件系统 |
| `github` | 生产环境 | 通过 GitHub API 读写你的仓库 |
| `demo` | 预览 | 只读，内置人格 |

---

## 文档

完整文档在 **[previously.ldwid.com/docs](https://previously.ldwid.com/docs)**（中英双语）。应用内 `/docs` 路径已永久重定向至官网。关键页面：

- [简介](https://previously.ldwid.com/docs/introduction) — Previously 是什么、如何工作
- [切片与线索](https://previously.ldwid.com/docs/slices) — 核心记忆模型
- [架构](https://previously.ldwid.com/docs/architecture) — 流水线、模块、技术栈、设计决策
- [部署](https://previously.ldwid.com/docs/deployment) — 模板、配置、部署
- [常见问题](https://previously.ldwid.com/docs/faq)

面向 AI 工具，文档站提供机器可读索引 [`llms.txt`](https://previously.ldwid.com/llms.txt)（全文版见 [`llms-full.txt`](https://previously.ldwid.com/llms-full.txt)）。

---

## 项目状态：实验阶段

Previously 处于早期积极开发中，尚未准备好用于个人或生产环境。核心架构已经可用，但许多子系统仍在设计与建设中。它会长期维护下去——这是对「人类与 AI 如何随时间相处」的一次认真重想。

几条指导每个决策的原则：

1. **一个完整的 Agent，而不只是记忆工具。** 它能读、能写、能思考、能行动。记忆让它感觉连贯——但这不是它的全部。
2. **记忆才是难题。** 存储对话很简单。在正确时刻、以正确深度检索到正确的记忆，才是真正困难的。力气花在这里。
3. **你的记忆属于你。** 纯 Markdown 存在你自己的仓库里——可移植、任何工具可读、由 git 版本控制。
4. **简单优于精巧。** 一条切片规则，而不是三条。复杂度预算花在核心循环——存储、索引、回忆——而不是配置项上。
5. **人类记忆是正确隐喻。** 情景 vs 语义。快速扫描 vs 深度检索。按时间组织、充满上下文。

---

## 参与贡献

这是一个单人研究项目，所以门是开着的，但规矩很少：友善一点、倾向小而聚焦的 PR、如果改变了行为，请说明原因。想法和 issue 跟代码一样受欢迎。

---

## 致谢

感谢 [Vercel AI SDK](https://sdk.vercel.ai)、[shadcn/ui](https://ui.shadcn.com) 和 [Open Agents](https://github.com/open-agents) 社区。

---

## 作者

<p align="center">
  <a href="https://likedreamwalker.space"><img alt="LikeDreamwalker" src="public/ldw.svg" width="220"></a>
</p>

<p align="center">
  <a href="https://likedreamwalker.space">个人网站</a>
  ·
  <a href="https://github.com/previously-lab">GitHub</a>
  ·
  <a href="mailto:a@ldwid.com">邮箱</a>
</p>
