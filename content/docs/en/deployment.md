# Deployment

Get your own Previously running in about 10 minutes. You'll create a private copy from the template, create a GitHub token, and deploy to Vercel. No server management, no database setup — just a repo, a token, and a deploy.

> [!WARNING]
> **No authentication yet.** Previously is in early development and does not yet have built-in authentication or access control. Anyone with your deployment URL can use your instance — and access or modify your memory data. Keep your deployment URL private. Do not share it publicly. Limit your Vercel deployment visibility if possible. Authentication is a high-priority feature and will be available soon.

## Create your private copy

Previously is a [GitHub Template Repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-repository-from-a-template). Click **Use this template** on the [Previously repo page](https://github.com/previously-lab/agent) and choose **Create a new repository**. **Make your new repository private** — this repository holds your agent's memory data (episodic slices, memory nodes, tasks, and session state). A private repo keeps everything accessible only to you and your agent.

> Your repository contains the application code. Memory data your agent creates is stored in whichever GitHub repository the environment variables point to — by default your own repo, but you can point it at a different repo entirely. Code and memory are decoupled by design.

## Create a GitHub token

Previously uses the GitHub API to read and write memory data. You need a fine-grained personal access token scoped to your repository.

1. Go to **GitHub Settings** (your profile picture → **Settings**).
2. In the left sidebar, click **Developer settings**.
3. Click **Personal access tokens** → **Fine-grained tokens**.
4. Click **Generate new token**.
5. Give it a name (like "Previously") and choose an expiration.
6. Under **Repository access**, select **Only select repositories** and pick your private repo.
7. Under **Permissions**, find **Contents** and set it to **Read and write**.
8. Click **Generate token** and **copy the token immediately** — you won't be able to see it again.

The token needs Contents read/write because Previously reads memory files (episodic slices, memory nodes, task lists) and writes new ones as the agent works. Scoping it to a single repo limits the blast radius if the token is ever exposed.

## Deploy to Vercel

Two options, from smoothest updates to quickest setup.

### Option A: Import to Vercel (recommended)

1. Create your private copy from the template (you already did this above).
2. Go to [vercel.com](https://vercel.com) and sign in with your GitHub account.
3. Click **Add New** → **Project**.
4. Import your private repo from the repository list. If it's not visible, click **Adjust GitHub App Permissions** and grant Vercel access to the repo.
5. In the **Environment Variables** section, add `DEEPSEEK_API_KEY`, `GITHUB_TOKEN`, `GITHUB_REPO_OWNER`, and `GITHUB_REPO_NAME` (see below).
6. Click **Deploy**.

Vercel detects Next.js, builds, and gives you a URL. That's it.

### Option B: Local dev (for testing)

To run Previously on your own machine:

```bash
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git
cd YOUR_REPO
pnpm install
pnpm dev
```

Create a `.env.local` file (see below) before starting. The app runs on `http://localhost:3000`.

## Environment variables

For local dev, create `.env.local` in the project root. For Vercel deployment, add these in your project settings under **Settings → Environment Variables**.

```bash
# Required — DeepSeek API key (powers the main model; the worker tier resolves from the same provider)
DEEPSEEK_API_KEY=sk-...

# Required — the GitHub token you created above
GITHUB_TOKEN=github_pat_...

# Required — your GitHub username and the repo name
GITHUB_REPO_OWNER=your-username
GITHUB_REPO_NAME=your-repo-name

# Optional — read-only demo persona mode
# STORAGE=demo
```

| Variable | Required | What it is | Where to get it |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | Yes | Authenticates requests to DeepSeek for the main model (and, by default, the worker tier derived from the same provider). | [platform.deepseek.com](https://platform.deepseek.com) — create an account and generate an API key. |
| `GITHUB_TOKEN` | Yes | The fine-grained personal access token. Every GitHub read and write flows through it. | [Created above](#create-a-github-token) in the token setup steps. |
| `GITHUB_REPO_OWNER` | Yes | Your GitHub username or organization that owns the repository holding memory data. | Your GitHub username. |
| `GITHUB_REPO_NAME` | Yes | The repository name where memory data lives. By default this is your repo, but you can point it at any repo you own. | Your repo's name on GitHub. |
| `STORAGE` | No | Selects the data source: `local` (filesystem), `github` (GitHub API), or `demo` (read-only pre-seeded persona dataset). Auto-detected when unset. | — |

## Syncing upstream updates

Previously has a built-in sync mechanism. When a new version is released:

1. Open your Previously instance and go to **Settings**.
2. In the **Version & Updates** section, if you see "Update available," click **Sync from upstream**.
3. The latest code is merged into your repository automatically. Vercel redeploys on the next push.

Your personal data (`memory/`, `tasks/`, `sessions/`) is never overwritten — only code directories are synced. The sync creates a proper merge commit that preserves your git history.

### Manual sync (fallback)

If the built-in sync button is unavailable, you can merge upstream changes manually from the command line. First, add the upstream remote (one-time setup):

```bash
git remote add upstream https://github.com/previously-lab/agent.git
git fetch upstream
git merge upstream/main --allow-unrelated-histories
git push origin main
```

Vercel redeploys automatically after the push.

### What sync touches

Code directories (`src/`, `content/`, `public/`, `messages/`, `scripts/`, etc.) and root config files are synced from upstream. Episodic memory data (`memory/episodic/`) is gitignored, so pulling in new code never overwrites your accumulated memory. Your personal data in `memory/`, `tasks/`, and `sessions/` is always preserved.

## Related

- [Architecture](/docs/architecture) — three-layer separation and data model
- [Getting Started](/docs/getting-started) — tour the interface and send your first message
