# FAQ

Common questions about how Previously works, what it costs, and where the boundaries are.

## Is there a database?

No. All state is plain Markdown files with YAML frontmatter, stored in a GitHub repository. There is no database, no vector store, no ORM, and no proprietary format. Slices, strands, nodes — everything is a file.

The sole structural index is a single JSON file: `memory/episodic/strands.json` maps each strand keyword to its slice paths. Per-month slice indexes (`_index.json`) live in the month directory (`slices/YYYY/MM/`), one level above the slices themselves, which are stored as `MM/DD/HHMM.md`. That is the full extent of the "plumbing." No Postgres, no SQLite, no Pinecone.

> **Key takeaway: your memory is a directory tree of Markdown files in a git repo. That's it.**

## Can other tools read my memory?

Yes. Memory is plain Markdown with YAML frontmatter — no SDK, no API gateway, no vendor lock-in. Previously writes memories. Claude Code reads them. Codex extends them. Any tool that can parse Markdown and read a GitHub repo can read your memory.

This portability is a core design goal. You never need to export or migrate data; you just point a different tool at the same repo.

## Does it forget in a long conversation?

No — not the way a growing prompt window does. Previously has no chat threads that accumulate indefinitely. Context is assembled from scratch per request using the timeline and stays bounded.

The mechanism lives in `src/lib/context/assembler.ts`. Each request gets a fresh assembly with a default budget of 8,000 tokens. Blocks stop loading once the budget is exceeded (line 76: `budget - 500` reserve). This means the timeline can grow across months of conversation, but what gets loaded into any single request stays relevant and window-sized.

There is no point where the agent suddenly forgets the beginning of a long exchange, because there is no single long exchange — context is rebuilt every round.

## How is a slice closed?

One rule: 30 minutes of silence (inactivity). A slice opens when you start talking, stays active while you stay engaged, and closes automatically after 30 minutes of no activity.

The threshold is hardcoded in `src/lib/episodic/slicer.ts`:

```ts
export const TIME_SILENCE_THRESHOLD_MS = 30 * 60 * 1000;
```

The function `checkTimeSilence()` compares elapsed milliseconds against that threshold. There is no capacity limit, no topic-shift rule, and no worker continuity check. Capacity checks and worker continuity checks were removed during M8 — time-only slicing is the entire story.

## Is it production-ready?

No. Previously is experimental (v0.7). The README carries an "experimental" status badge and explicitly states it is "not yet ready for personal or production use."

It is a personal deployment, not a SaaS product. The author commits to long-term maintenance, but the project is in active early development. Expect rough edges, breaking changes, and features still on the roadmap.

## Do code and memory share a repo?

They can. They can also be separate. The deployed app reads and writes the GitHub repo identified by the environment variables `GITHUB_REPO_OWNER` and `GITHUB_REPO_NAME`. Those same env vars can point at a dedicated private memory repo that is distinct from the code repo.

The project's own convention (described in `CLAUDE.md`) co-locates code and data in one repo — with `src/` agent-read-only and data directories (`memory/`, `tasks/`, `sessions/`) agent-read-write. But the configuration gives you the choice. A separate memory repo is valid and documented in the Quick start.

## How much does it cost to run?

Two cost centers:

- **LLM API usage** — Previously runs on your own API keys (DeepSeek and/or Anthropic). The two-tier architecture (a worker model for fast recall scans, the main model for deep reasoning) is cost-motivated: cheap passes handle the common case, expensive reasoning is reserved for when it matters.
- **Hosting** — Vercel Pro (the deploy button targets Vercel). Vercel's free tier may cover light usage, but sustained use will likely need a paid plan. GitHub repo storage is effectively free.

Previously charges no subscription, no per-seat fee, and no usage markup. You supply the infrastructure and the keys; the project is the orchestration layer in between.

## Is my data private?

Yes, by design. Memory lives in a GitHub repository you own (the Quick start recommends a private repo). Access is controlled by a GitHub fine-grained personal access token scoped to contents read/write on a single repository. There is no platform database that holds your conversations. No third-party server stores your slices or strands.

You own the data outright. Clone it, back it up, move it to another provider — it is just files in a git repo.

## Related

- [Memory Model](/content/docs/en/memory-model) — how slices, strands, and context assembly work
- [Architecture Overview](/content/docs/en/architecture)
