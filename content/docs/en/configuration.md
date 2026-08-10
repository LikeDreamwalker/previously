# Configuration

Previously is configured exclusively through environment variables — six shipped vars, zero config files, one implicit backend switch that determines whether reads hit GitHub's API or your local filesystem.

> **Key takeaway:** Three variables are required (`DEEPSEEK_API_KEY`, `GITHUB_REPO_OWNER`, `GITHUB_REPO_NAME`). A fourth (`GITHUB_TOKEN`) is what you think of as required — it gates the entire GitHub backend. Without it, the app reads and writes the local filesystem instead.

## Environment variable reference

Every variable the runtime actually reads, in one table:

| Variable | Required | Shipped | Default | Runtime effect |
|---|---|---|---|---|
| `DEEPSEEK_API_KEY` | Yes | Yes | — | Powers both the worker and main model tiers. The `@ai-sdk/deepseek` provider reads it automatically from the environment — no source file references `process.env.DEEPSEEK_API_KEY` directly. |
| `GITHUB_TOKEN` | See note | Yes | — | Presence of this variable **is the backend switch**. When set, the app uses the Octokit/GitHub API backend; when absent, the app falls back to the local filesystem. Leave unset or commented out for local development. An empty string `GITHUB_TOKEN=` will now correctly fall back to local filesystem. A fine-grained PAT with Contents read/write scoped to a single repository. |
| `GITHUB_REPO_OWNER` | When using GitHub backend | Yes | `local` | GitHub username or organization that owns the memory repository. Read at multiple modules including the chat route, flush endpoint, episodic manager, and identity/profile. |
| `GITHUB_REPO_NAME` | When using GitHub backend | Yes | `local` | The repository name for memory data. Same consumption points as `GITHUB_REPO_OWNER`. |
| `STORAGE` | No | Yes | Auto-detected | Selects the data source: `local` (filesystem), `github` (GitHub API), or `demo` (read-only pre-seeded persona). When unset, auto-detects: `GITHUB_TOKEN` present → `github`; `NODE_ENV=development` → `local`; otherwise → `demo`. In `demo` mode, `memory/` reads are served from a pre-seeded persona dataset (default: Caleb, `personal_14`) and writes are accepted but never persisted — the app returns a success response but discards the data. |
| `BENCHMARK_BASE_URL` | No | No | — | Base URL for the remote benchmark-data repo used in `demo` mode (e.g. `https://raw.githubusercontent.com/previously-lab/benchmark-data/main`). When unset in `demo` mode, reads fall back to a local `../benchmark-data` sibling directory on disk. |
| `ANTHROPIC_API_KEY` | No | Roadmap only | — | Appears in `README.md` and the `@ai-sdk/anthropic` dependency is installed, but **no shipped code reads `process.env.ANTHROPIC_API_KEY`** or instantiates an Anthropic provider. Multi-provider support is typed in the model registry (`provider: "deepseek" | "anthropic" | "openai"`) but `DEFAULT_MODELS` ships only DeepSeek entries. Setting this variable has zero runtime effect in v0.7. |

> **Note on `GITHUB_TOKEN`:** When `STORAGE` is unset, the data source is auto-detected in one place — `src/lib/data-source/resolve.ts`: `GITHUB_TOKEN` present → GitHub API; `NODE_ENV=development` → local filesystem; otherwise → demo. There is no dedicated `USE_GITHUB` environment variable. This is intentional: the simplest possible toggle, no config file, no extra surface area.

## Backend switch: GitHub API vs local filesystem vs demo

The storage backend is implicit by design. When `STORAGE` is unset it is auto-detected from `GITHUB_TOKEN` and `NODE_ENV`; you can also set it explicitly:

```typescript
resolveDataSource(); // "local" | "github" | "demo" — STORAGE override, else auto-detect
```

| Backend | When selected | How reads work | How writes work |
|---|---|---|---|
| **GitHub API** | `STORAGE=github`, or auto-detected when `GITHUB_TOKEN` is set | `octokit.rest.repos.getContent`, base64-decoded. Requires `GITHUB_REPO_OWNER` and `GITHUB_REPO_NAME`. | `createOrUpdateFileContents` on the same repo. |
| **Local filesystem** | `STORAGE=local`, or auto-detected in development | `fs.readFileSync` from `DATA_ROOT = join(process.cwd())`. Reads physical files from the project root. | `fs.writeFileSync` to the same root. |
| **Demo (read-only)** | `STORAGE=demo`, or auto-detected otherwise | Reads from a pre-seeded persona dataset — a local `../benchmark-data/{persona}/...` sibling or the `BENCHMARK_BASE_URL` remote. | No-op: returns success, discards data. |

The storage backends enforce the same security boundary:
- **Path whitelist**: only `memory/`, `tasks/`, and `sessions/` are read-write; `src/` is agent read-only
- **Size cap**: `MAX_FILE_SIZE_BYTES = 1_000_000` (1 MB) on all file reads

The local-filesystem backend is what you use during development (`pnpm dev`). It reads and writes real files on disk — no GitHub, no network, no rate limits. The GitHub backend is what you deploy to Vercel. The code paths diverge at the route handlers (see `src/app/api/chat/route.ts` lines ~434-475), but the interface is identical.

## Demo mode behavior

`STORAGE=demo` puts the entire memory layer into a read-only demonstration mode against a pre-seeded persona dataset. Here is exactly what changes:

### Where demo reads come from

In demo mode, every `memory/` read is served from a benchmark-data persona dataset, not from the repo's own `memory/` directory:

```
memory/episodic/slices/...  →  {persona}/episodic/slices/...     (from benchmark-data)
memory/nodes/some-node.md   →  {persona}/nodes/some-node.md     (from benchmark-data)
```

The default persona is `personal_14` (Caleb). Reads are served from a local sibling directory `../benchmark-data/{persona}/...` when `BENCHMARK_BASE_URL` is unset, or from the remote base URL (e.g. `https://raw.githubusercontent.com/previously-lab/benchmark-data/main/{persona}/...`) when set. Demo reads never touch the repo's real `memory/` directory.

### Writes: accepted, never persisted

Demo mode makes writes a no-op:

- `writeFileDemo` (`src/lib/demo/demo-fs.ts`) returns `{ path, created: false }` without writing anywhere — on both the local and remote demo backends.

The agent sees a successful write. The data is silently discarded.

### Remote demo data

When deploying a demo instance without a local benchmark-data checkout, set `BENCHMARK_BASE_URL` to the raw URL of the benchmark-data repo:

```bash
STORAGE=demo
BENCHMARK_BASE_URL=https://raw.githubusercontent.com/previously-lab/benchmark-data/main
```

With the variable set, demo reads fetch from that base URL; unset, they fall back to the local `../benchmark-data` sibling directory.

### Persona picker

In demo mode the hero becomes a persona picker (`hero-section.tsx` loads the persona list via `listDemoPersonas`), so you can switch between pre-seeded personas.

## Model registry and model routing

Previously ships with a models.dev-driven model registry. Two tiers, one catalog:

| Tier | Purpose | Model | Temperature | Tool mode |
|---|---|---|---|---|
| **Worker** | Unified intent classification + recall scanning + metadata maintenance | Resolved worker model (a cheap tier of the main provider) | Low | Structured, non-thinking |
| **Main** | Deep reasoning, full-slice reads, response generation | User-selected main model | SDK default | User choice |

### The worker is resolved, not hardcoded

The worker pass runs **before** the response stream opens. It makes one cheap call — the turn analyzer — that performs three jobs in a single round-trip: intent classification, recall scanning, and metadata maintenance. The worker model is resolved by `resolveWorkerModel()` (`src/lib/models/worker.ts`): a manual pin → a same-provider lightweight → the main model itself. Worker calls are always cheap, structured, and non-thinking.

### Main model selection

The main model is selected per-request from the client:

```typescript
const model = (body.model as string) ?? 'deepseek-chat';
```

The client default is `deepseek-chat` as well (`getClientSetting('PREVIOUSLY_MODEL', 'deepseek-chat')`). The model registry (`src/lib/models/registry.ts`) defines exactly two models:

| Model ID | Display name | Supports thinking | Vision | Max tokens |
|---|---|---|---|---|
| `deepseek-chat` | DeepSeek Chat | Yes | No | 65536 |
| `deepseek-reasoner` | DeepSeek Reasoner | Yes | No | 65536 |

`deepseek-reasoner` exists in the registry and is available as a user-selectable option, but it is **not the default** and is **not auto-selected** by the thinking toggle. The shipped path stays on `deepseek-chat`.

### Thinking toggle

The thinking toggle is a request-level boolean (`body.thinking`, default `true`) that is **not** a model switch. When enabled, the server adds provider options to the `deepseek-chat` call:

```typescript
providerOptions: {
  deepseek: {
    thinking: { type: 'enabled' },
    reasoningEffort: 'medium',
  },
}
```

When disabled, no `providerOptions` are sent. The thinking duration is measured server-side (wall-clock time between the first reasoning chunk and the first text chunk) and emitted as a `data-reasoning` event — not tracked client-side via timers.

> **Nuance:** `deepseek-reasoner` exists in the registry but the thinking toggle does not switch to it. Both the route code and the client default are `deepseek-chat`. The toggle is a **provider-level option on deepseek-chat**, not a model swap.

## Internationalization

i18n uses `next-intl` with exactly two locales:

| Locale | Code | Default |
|---|---|---|
| English | `en` | Yes |
| Chinese | `zh` | No |

Configuration lives in `src/i18n/routing.ts`:

```typescript
defineRouting({
  locales: ['en', 'zh'],
  defaultLocale: 'en',
});
```

Translation files:
- `messages/en.json`
- `messages/zh.json`

Navigation must use utilities from `@/i18n/navigation` instead of `next/navigation` (enforced by project convention). The locale layout wraps content in `NextIntlClientProvider`.

## The omitted vars

A few environment variables you might expect, and why they do not exist:

| You might expect | Reality |
|---|---|
| `USE_GITHUB` | Does not exist. The backend switch is the `STORAGE` env var with auto-detection in `src/lib/data-source/resolve.ts` — implicit, zero-config, intentional. |
| `LOG_LEVEL` | Not implemented. Logging is thin. |
| `DATABASE_URL` | There is no database. State lives in GitHub files. |
| `PORT` | Not read by the app; Next.js handles it. |
| `ANTHROPIC_API_KEY` | Installed dependency, README mentions it, **but no shipped code reads it**. Roadmap/aspirational. |

## Related

- [Deployment](/docs/en/deployment) — deployment walkthrough with the full `.env.local` template
- [Episodic Memory](/docs/en/episodic-memory) — how slices and strands work; the data that configuration makes accessible
- [Recall](/docs/en/recall) — how the worker and main models use the configured models
