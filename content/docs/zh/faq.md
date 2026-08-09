# 常见问题

关于 Previously 如何工作、运行成本以及边界在哪里的常见问题。

## 有数据库吗？

没有。所有状态都是带有 YAML frontmatter 的纯 Markdown 文件，存储在 GitHub 仓库中。没有数据库、没有向量存储、没有 ORM，也没有专有格式。Slice、strand、node——一切都是文件。

唯一的结构性索引是一个 JSON 文件：`memory/episodic/strands.json` 将每个 strand 关键字映射到其对应的 slice 路径。按月度的 slice 索引（`_index.json`）位于月份目录（`slices/YYYY/MM/`）中，比 slice 文件本身高一层级，slice 文件以 `MM/DD/HHMM.md` 格式存储。这就是全部"管道"了。没有 Postgres、没有 SQLite、没有 Pinecone。

> **关键要点：你的记忆就是一个 git 仓库里 Markdown 文件的目录树。仅此而已。**

## 其他工具能读取我的记忆吗？

可以。记忆是带有 YAML frontmatter 的纯 Markdown——没有 SDK、没有 API 网关、没有供应商锁定。Previously 写入记忆。Claude Code 读取记忆。Codex 扩充记忆。任何能解析 Markdown 并读取 GitHub 仓库的工具都能读取你的记忆。

这种可移植性是核心设计目标。你永远不需要导出或迁移数据；只需让不同的工具指向同一个仓库即可。

## 在长对话中它会遗忘吗？

不会——不像不断增长的提示窗口那样会遗忘。Previously 没有无限累积的聊天线程。每次请求都会基于时间线从头组装上下文，并且保持边界可控。

其机制位于 `src/lib/context/assembler.ts`。每次请求都会获得一次全新的上下文组装，默认预算为 8,000 token。当预算超出时（第 76 行：`budget - 500` 保留空间），block 停止加载。这意味着时间线可以跨越数月的对话不断增长，但加载到任何单次请求中的内容始终保持相关且符合窗口大小。

不存在 agent 突然忘记长对话开头的情况，因为根本没有单一的长对话——上下文每轮都会重建。

## 切片是如何关闭的？

一条规则：30 分钟静默（无活动）。当你开始对话时，一个 slice 打开；在你保持互动期间保持活跃；30 分钟无活动后自动关闭。

阈值硬编码在 `src/lib/episodic/slicer.ts` 中：

```ts
export const TIME_SILENCE_THRESHOLD_MS = 30 * 60 * 1000;
```

函数 `checkTimeSilence()` 将已过的毫秒数与阈值进行比较。没有容量限制、没有话题切换规则、也没有 worker 连续性检查。容量检查和 worker 连续性检查已在 M8 期间移除——仅基于时间的 slicing 是全部逻辑。

## 它达到生产就绪了吗？

没有。Previously 是实验性的（v0.7）。README 带有"实验性"状态徽章，并明确说明"尚未准备好用于个人或生产用途"。

这是个人部署，而非 SaaS 产品。作者承诺长期维护，但项目处于活跃的早期开发阶段。预计会遇到粗糙的边缘、破坏性变更以及仍在路线图上的功能。

## 代码和记忆共享同一个仓库吗？

可以共享，也可以分开。部署后的应用读写由环境变量 `GITHUB_REPO_OWNER` 和 `GITHUB_REPO_NAME` 指定的 GitHub 仓库。这些环境变量也可以指向一个与代码仓库不同的专用私有记忆仓库。

项目自身的约定（在 `CLAUDE.md` 中描述）将代码和数据放在同一个仓库中——其中 `src/` 为 agent 只读，而数据目录（`memory/`、`tasks/`、`sessions/`）为 agent 读写。但配置给了你选择权。独立的记忆仓库也是可行的，并在快速入门中有文档说明。

## 运行成本是多少？

两个成本中心：

- **LLM API 使用费**——Previously 使用你自己的 API 密钥（DeepSeek 和/或 Anthropic）运行。两层架构（worker 模型用于快速召回扫描，主模型用于深度推理）是出于成本考虑：廉价模型处理常见情况，昂贵的推理保留给需要的时候。
- **托管费用**——Vercel Pro（部署按钮指向 Vercel）。Vercel 的免费套餐可能覆盖轻度使用，但持续使用可能需要付费计划。GitHub 仓库存储基本上是免费的。

Previously 不收取任何订阅费、按席位收费或使用加价。你提供基础设施和密钥；该项目是介于两者之间的编排层。

## 我的数据隐私吗？

是的，这是设计使然。记忆存储在你拥有的 GitHub 仓库中（快速入门推荐使用私有仓库）。访问由 GitHub fine-grained personal access token 控制，该 token 限定为单个仓库的 contents 读写权限。没有保存你对话的平台数据库。没有第三方服务器存储你的 slice 或 strand。

你完全拥有数据的所有权。克隆它、备份它、迁移到其他供应商——它们只是 git 仓库中的文件。

## 相关文档

- [记忆模型](/content/docs/zh/memory-model)——了解 slice、strand 和上下文组装如何工作
- [架构概述](/content/docs/zh/architecture)
