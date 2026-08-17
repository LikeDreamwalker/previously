# 部署

大约 10 分钟即可拥有属于你自己的 Previously 实例。你需要从模板创建一个私有副本、生成 GitHub token，然后部署到 Vercel。无需管理服务器，无需搭建数据库 —— 一个仓库、一个 token、一次部署就能跑起来。

> [!WARNING]
> **尚无鉴权机制。** Previously 处于早期开发阶段，尚未内置身份验证或访问控制功能。任何持有你部署链接的人都可以使用你的实例，并访问或修改你的记忆数据。请妥善保管你的部署链接，不要公开分享。如有可能，限制 Vercel 部署的可见范围。鉴权功能是高优先级特性，即将推出。

## 创建你的私有副本

Previously 是一个 [GitHub 模板仓库](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-repository-from-a-template)。在 [Previously 仓库页面](https://github.com/previously-lab/agent) 点击 **Use this template**，然后选择 **Create a new repository**。**请将新仓库设为私有** —— 这个仓库存储着 agent 的记忆数据（时间片、记忆节点、任务和会话状态）。私有仓库确保只有你和你的 agent 可以访问这些内容。

> 你的仓库包含应用代码。Agent 创建的记忆数据存储在环境变量所指向的 GitHub 仓库中 —— 默认就是你自己的仓库，但也可以指向你拥有的任意其他仓库。代码与记忆在设计上就是解耦的。

## 创建 GitHub token

Previously 通过 GitHub API 读写记忆数据。你需要一个限定到单个仓库的细粒度个人访问 token。

1. 前往 **GitHub Settings**（点击头像 → **Settings**）。
2. 在左侧边栏中，点击 **Developer settings**。
3. 点击 **Personal access tokens** → **Fine-grained tokens**。
4. 点击 **Generate new token**。
5. 填写名称（如 "Previously"）并选择过期时间。
6. 在 **Repository access** 下，选择 **Only select repositories** 并选中你的私有仓库。
7. 在 **Permissions** 下，找到 **Contents** 并将其设为 **Read and write**。
8. 点击 **Generate token** 并**立即复制 token** —— 之后你将无法再次查看。

Token 需要 Contents 读写权限，因为 Previously 需要读取记忆文件（时间片、记忆节点、任务列表），并在 agent 工作时写入新内容。将权限限定到单个仓库，可以在 token 意外泄露时尽可能缩小影响范围。

## 部署到 Vercel

两种方式，从更新最顺滑到搭建最快速。

### 方式 A：导入到 Vercel（推荐）

1. 从模板创建你的私有副本（上一步已完成）。
2. 前往 [vercel.com](https://vercel.com) 并用你的 GitHub 账号登录。
3. 点击 **Add New** → **Project**。
4. 从仓库列表中导入你的私有仓库。如果找不到，点击 **Adjust GitHub App Permissions** 授权 Vercel 访问该仓库。
5. 在 **Environment Variables** 区域，添加 `DEEPSEEK_API_KEY`、`GITHUB_TOKEN`、`GITHUB_REPO_OWNER` 和 `GITHUB_REPO_NAME`（见下方说明）。
6. 点击 **Deploy**。

Vercel 会自动检测 Next.js 项目、构建并分配一个 URL。这样就完成了。

### 方式 B：本地开发（用于测试）

在本机上运行 Previously：

```bash
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git
cd YOUR_REPO
pnpm install
pnpm dev
```

启动前需创建 `.env.local` 文件（见下方说明）。应用将在 `http://localhost:3000` 运行。

## 环境变量

本地开发时，在项目根目录创建 `.env.local`。Vercel 部署时，在项目设置的 **Settings → Environment Variables** 中添加这些变量。

```bash
# 必填 — DeepSeek API 密钥（为主模型提供能力；worker 层级从同一提供者解析）
DEEPSEEK_API_KEY=sk-...

# 必填 — 你上一步创建的 GitHub token
GITHUB_TOKEN=github_pat_...

# 必填 — 你的 GitHub 用户名和仓库名
GITHUB_REPO_OWNER=your-username
GITHUB_REPO_NAME=your-repo-name

# 可选 — 只读的演示角色模式
# STORAGE=demo
```

| 变量 | 是否必填 | 说明 | 获取方式 |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | 是 | 为主模型提供 DeepSeek 认证（默认情况下，worker 层级也从同一提供者派生）。 | [platform.deepseek.com](https://platform.deepseek.com) —— 注册账号并生成 API 密钥。 |
| `GITHUB_TOKEN` | 是 | 细粒度个人访问 token。所有 GitHub 读写操作都通过它进行。 | [上一步已创建](#创建-github-token)。 |
| `GITHUB_REPO_OWNER` | 是 | 拥有记忆数据仓库的 GitHub 用户名或组织名。 | 你的 GitHub 用户名。 |
| `GITHUB_REPO_NAME` | 是 | 存放记忆数据的仓库名。默认就是你自己的仓库，但也可以指向你拥有的任意仓库。 | 你在 GitHub 上的仓库名。 |
| `STORAGE` | 否 | 选择数据源：`local`（文件系统）、`github`（GitHub API）或 `demo`（只读的预置角色数据集）。未设置时自动检测。 | — |

## 同步上游更新

Previously 内置了同步机制。当新版本发布时：

1. 打开你的 Previously 实例，前往 **Settings**（设置）。
2. 在 **Version & Updates**（版本与更新）区域，如果看到"发现新版本"的提示，点击 **Sync from upstream**（从上游同步）。
3. 最新代码将自动合并到你的仓库。Vercel 会在下次推送时自动重新部署。

你的个人数据（`memory/`、`tasks/`、`sessions/`）永远不会被覆盖 —— 只有代码目录会被同步。同步操作会创建一个合适的合并提交，完整保留你的 git 历史。

### 手动同步（备用方案）

如果内置同步按钮不可用，可以在命令行中手动合并上游更新。首先添加上游远程仓库（仅需设置一次）：

```bash
git remote add upstream https://github.com/previously-lab/agent.git
git fetch upstream
git merge upstream/main --allow-unrelated-histories
git push origin main
```

推送后 Vercel 会自动重新部署。

### 同步涉及的内容

代码目录（`src/`、`content/`、`public/`、`messages/`、`scripts/` 等）和根目录配置文件会从上游同步。时间线记忆数据（`memory/episodic/`）已被 gitignore，因此拉取新代码不会覆盖你累积的记忆。`memory/`、`tasks/`、`sessions/` 中的个人数据始终受到保护。

## 相关文档

- [架构](/docs/architecture) —— 三层分离与数据模型
- [快速上手](/docs/getting-started) —— 浏览界面，发送第一条消息
