# 配置

Previously 完全通过环境变量进行配置——六个内置变量，零个配置文件，一个隐式的后端开关来决定读取操作走 GitHub API 还是本地文件系统。

> **要点：** 三个变量是必需的（`DEEPSEEK_API_KEY`、`GITHUB_REPO_OWNER`、`GITHUB_REPO_NAME`）。第四个变量（`GITHUB_TOKEN`）实际上也是必需的——它控制着整个 GitHub 后端。没有它，应用会改为读写本地文件系统。

## 环境变量参考

运行时实际读取的所有变量，汇总在一张表中：

| 变量 | 是否必需 | 是否内置 | 默认值 | 运行时效果 |
|---|---|---|---|---|
| `DEEPSEEK_API_KEY` | 是 | 是 | — | 同时驱动 worker 和主模型两个层级。`@ai-sdk/deepseek` 提供者会自动从环境中读取该变量——没有源码文件直接引用 `process.env.DEEPSEEK_API_KEY`。 |
| `GITHUB_TOKEN` | 见说明 | 是 | — | 该变量是否存在**就是后端开关**。设置后，应用使用 Octokit/GitHub API 后端；未设置时，应用回退到本地文件系统。本地开发时保留未设置或注释掉状态。空字符串 `GITHUB_TOKEN=` 现在能正确回退到本地文件系统。一个细粒度 PAT，权限为 Contents read/write，范围限定到单个仓库。 |
| `GITHUB_REPO_OWNER` | 使用 GitHub 后端时必需 | 是 | `local` | 拥有 memory 仓库的 GitHub 用户名或组织。在多个模块中被读取，包括 chat 路由、flush 端点、episodic 管理器和身份/资料模块。 |
| `GITHUB_REPO_NAME` | 使用 GitHub 后端时必需 | 是 | `local` | 存储 memory 数据的仓库名称。与 `GITHUB_REPO_OWNER` 的消费点相同。 |
| `STORAGE` | 否 | 是 | 自动检测 | 选择数据源：`local`（文件系统）、`github`（GitHub API）或 `demo`（只读的预置角色数据集）。未设置时自动检测：存在 `GITHUB_TOKEN` → `github`；`NODE_ENV=development` → `local`；否则 → `demo`。在 `demo` 模式下，`memory/` 读取由预置的角色数据集提供（默认：Caleb，`personal_14`），写入会被接收但从不持久化——应用返回成功响应但丢弃数据。 |
| `BENCHMARK_BASE_URL` | 否 | 否 | — | `demo` 模式使用的远程 benchmark-data 仓库基础 URL（例如 `https://raw.githubusercontent.com/previously-lab/benchmark-data/main`）。在 `demo` 模式下未设置时，读取会回退到磁盘上的本地 `../benchmark-data` 兄弟目录。 |
| `ANTHROPIC_API_KEY` | 否 | 仅路线图 | — | 出现在 `README.md` 中，`@ai-sdk/anthropic` 依赖也已安装，但**已发布的代码中没有任何地方读取 `process.env.ANTHROPIC_API_KEY`** 或实例化 Anthropic 提供者。多提供者支持在模型注册表中已有类型定义（`provider: "deepseek" | "anthropic" | "openai"`），但 `DEFAULT_MODELS` 只包含 DeepSeek 条目。在 v0.7 中设置此变量没有任何运行时效果。 |

> **关于 `GITHUB_TOKEN` 的说明：** 当 `STORAGE` 未设置时，数据源在单一位置自动检测——`src/lib/data-source/resolve.ts`：存在 `GITHUB_TOKEN` → GitHub API；`NODE_ENV=development` → 本地文件系统；否则 → demo。没有专门的 `USE_GITHUB` 环境变量。这是有意为之：最简单的切换方式，无需配置文件，没有额外的接口面。

## 后端切换：GitHub API vs 本地文件系统 vs Demo

存储后端是隐式的，有意这样设计。当 `STORAGE` 未设置时，它会根据 `GITHUB_TOKEN` 和 `NODE_ENV` 自动检测；你也可以显式设置它：

```typescript
resolveDataSource(); // "local" | "github" | "demo" —— STORAGE 覆盖，否则自动检测
```

| 后端 | 何时选中 | 读取方式 | 写入方式 |
|---|---|---|---|
| **GitHub API** | `STORAGE=github`，或存在 `GITHUB_TOKEN` 时自动检测 | `octokit.rest.repos.getContent`，base64 解码。需要 `GITHUB_REPO_OWNER` 和 `GITHUB_REPO_NAME`。 | 在同一仓库上执行 `createOrUpdateFileContents`。 |
| **本地文件系统** | `STORAGE=local`，或在开发环境中自动检测 | 从 `DATA_ROOT = join(process.cwd())` 执行 `fs.readFileSync`。从项目根目录读取物理文件。 | 向同一根目录执行 `fs.writeFileSync`。 |
| **Demo（只读）** | `STORAGE=demo`，或否则自动检测 | 从预置的角色数据集读取——本地 `../benchmark-data/{persona}/...` 兄弟目录或 `BENCHMARK_BASE_URL` 远程地址。 | 空操作：返回成功，丢弃数据。 |

各存储后端执行相同的安全边界：
- **路径白名单**：仅 `memory/`、`tasks/` 和 `sessions/` 可读写；`src/` 对 agent 只读
- **大小上限**：所有文件读取的 `MAX_FILE_SIZE_BYTES = 1_000_000`（1 MB）

本地文件系统后端是你在开发时（`pnpm dev`）使用的后端。它读写磁盘上的真实文件——无需 GitHub，无需网络，没有速率限制。GitHub 后端是你部署到 Vercel 时使用的后端。代码路径在路由处理器处分叉（参见 `src/app/api/chat/route.ts` 第 ~434-475 行），但接口完全相同。

## Demo 模式行为

`STORAGE=demo` 将整个 memory 层切换到针对预置角色数据集的只读演示模式。以下是具体变化：

### demo 读取来自哪里

在 demo 模式下，每次 `memory/` 读取都由 benchmark-data 角色数据集提供，而不是仓库自身的 `memory/` 目录：

```
memory/episodic/slices/...  →  {persona}/episodic/slices/...     （来自 benchmark-data）
memory/nodes/some-node.md   →  {persona}/nodes/some-node.md     （来自 benchmark-data）
```

默认角色是 `personal_14`（Caleb）。当 `BENCHMARK_BASE_URL` 未设置时，读取来自本地兄弟目录 `../benchmark-data/{persona}/...`；设置后，则来自远程基础 URL（例如 `https://raw.githubusercontent.com/previously-lab/benchmark-data/main/{persona}/...`）。demo 读取永远不会触及仓库真实的 `memory/` 目录。

### 写入：接收但不持久化

Demo 模式使写入成为空操作：

- `writeFileDemo`（`src/lib/demo/demo-fs.ts`）返回 `{ path, created: false }`，在任何地方都不写入——本地和远程 demo 后端均是如此。

agent 会看到写入成功。数据被静默丢弃。

### 远程 demo 数据

当部署没有本地 benchmark-data 检出目录的 demo 实例时，将 `BENCHMARK_BASE_URL` 设置为 benchmark-data 仓库的 raw URL：

```bash
STORAGE=demo
BENCHMARK_BASE_URL=https://raw.githubusercontent.com/previously-lab/benchmark-data/main
```

设置该变量后，demo 读取会从该基础 URL 获取；未设置时，回退到本地 `../benchmark-data` 兄弟目录。

### 角色选择器

在 demo 模式下，hero 区域变成角色选择器（`hero-section.tsx` 通过 `listDemoPersonas` 加载角色列表），你可以在预置角色之间切换。

## 模型注册表与模型路由

Previously 附带一个由 models.dev 驱动的模型注册表。两个层级，同一个目录：

| 层级 | 用途 | 模型 | 温度 | 工具模式 |
|---|---|---|---|---|
| **Worker** | 统一意图分类 + 召回扫描 + 元数据维护 | 已解析的 worker 模型（主提供者的廉价层级） | 低 | 结构化、非思考 |
| **主模型** | 深度推理、完整 slice 读取、响应生成 | 用户选择的主模型 | SDK 默认 | 用户选择 |

### worker 是被解析出来的，而非硬编码

worker 调用在响应流打开**之前**运行。它发起一次廉价的调用——turn analyzer——在单次往返中完成三项工作：意图分类、召回扫描和元数据维护。worker 模型由 `resolveWorkerModel()`（`src/lib/models/worker.ts`）解析：手动固定 → 同提供者的轻量模型 → 主模型本身。worker 调用始终廉价、结构化且非思考。

### 主模型选择

主模型按请求从客户端选择：

```typescript
const model = (body.model as string) ?? 'deepseek-chat';
```

客户端默认值也是 `deepseek-chat`（`getClientSetting('PREVIOUSLY_MODEL', 'deepseek-chat')`）。模型注册表（`src/lib/models/registry.ts`）只定义了两种型号：

| 模型 ID | 显示名称 | 支持思考 | 视觉 | 最大 token |
|---|---|---|---|---|
| `deepseek-chat` | DeepSeek Chat | 是 | 否 | 65536 |
| `deepseek-reasoner` | DeepSeek Reasoner | 是 | 否 | 65536 |

`deepseek-reasoner` 存在于注册表中，作为用户可选的选项可用，但它**不是默认值**，也**不会由思考开关自动选择**。已发布的路径始终使用 `deepseek-chat`。

### 思考开关

思考开关是一个请求级别的布尔值（`body.thinking`，默认 `true`），它**不是**模型切换。启用时，服务器会向 `deepseek-chat` 调用添加 provider 选项：

```typescript
providerOptions: {
  deepseek: {
    thinking: { type: 'enabled' },
    reasoningEffort: 'medium',
  },
}
```

禁用时，不发送任何 `providerOptions`。思考时长在服务端测量（从第一个推理 chunk 到第一个文本 chunk 之间的挂钟时间），并作为 `data-reasoning` 事件发出——不通过客户端计时器追踪。

> **微妙之处：** `deepseek-reasoner` 存在于注册表中，但思考开关不会切换到这个模型。路由代码和客户端默认值都是 `deepseek-chat`。该开关是 **deepseek-chat 上的一个 provider 级别选项**，而非模型切换。

## 国际化

i18n 使用 `next-intl`，正好两个语言环境：

| 语言环境 | 代码 | 默认 |
|---|---|---|
| 英语 | `en` | 是 |
| 中文 | `zh` | 否 |

配置位于 `src/i18n/routing.ts`：

```typescript
defineRouting({
  locales: ['en', 'zh'],
  defaultLocale: 'en',
});
```

翻译文件：
- `messages/en.json`
- `messages/zh.json`

导航必须使用 `@/i18n/navigation` 中的工具函数，而不是 `next/navigation`（由项目约定强制）。locale 布局用 `NextIntlClientProvider` 包裹内容。

## 未包含的变量

一些你可能期望的环境变量，以及它们不存在的原因：

| 你可能期望的变量 | 实际情况 |
|---|---|
| `USE_GITHUB` | 不存在。后端开关是 `STORAGE` 环境变量，并在 `src/lib/data-source/resolve.ts` 中自动检测——隐式、零配置、有意为之。 |
| `LOG_LEVEL` | 未实现。日志功能较简单。 |
| `DATABASE_URL` | 没有数据库。状态存储在 GitHub 文件中。 |
| `PORT` | 应用不读取该变量；由 Next.js 处理。 |
| `ANTHROPIC_API_KEY` | 依赖已安装，README 中提及，**但已发布的代码中没有读取它的地方**。属于路线图/储备性质。 |

## 相关文档

- [部署](/docs/zh/deployment) —— 包含完整 `.env.local` 模板的部署指南
- [情景记忆](/docs/zh/episodic-memory) —— slice 和 strand 的工作原理；配置使之可访问的数据
- [召回](/docs/zh/recall) —— worker 和主模型如何使用已配置的模型
