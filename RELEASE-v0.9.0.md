## Previously v0.9.0 — the agent comes home

Until now, Previously lived on the edge: deploy to Vercel, memory in a GitHub repo. That is still the recommended way to run it. v0.9 adds the second form the project was always headed for — **the same kernel, running on your own machine**, with your memory in a plain local folder you own.

**This is an early preview of the client.** It is functional and tested, but the command surface and config format may still shift between preview releases.

### The client (new package: `@previously-lab/client`)

```bash
npm i -g @previously-lab/client@preview
previously
```

One install turns your machine into a full Previously instance — no Docker, no git installation, no build tools. A first-run wizard initializes your memory as a plain local git repository (default `~/Documents/Previously`) and commits on the same cadence the cloud version does. Push it to a private GitHub repo if you want a backup; a cloud deployment can read the same repo remotely. It's just files.

Two engines, your choice:

- **BYOK (recommended)** — bring your own API key. This is the exact cloud workflow running locally: same streaming, same colleagues, same evolution loop.
- **Subscription bridge** — drive the agent subscriptions you already have (Claude Code / Codex / Kimi Code) instead of an API key. It works, but behavior is bounded by the target CLI, so treat it as a compatibility path, not the main one.

Also in the box: a **scribe** that transcribes your existing Claude Code / Codex / Kimi Code / Gemini CLI sessions into time slices, a memory skill that lets those agents read your Previously memory back, and a small lifecycle CLI (`start` / `stop` / `status` / `open` / `logs`, `config doctor`). Requires Node.js ≥ 22.13.

### The kernel (new package: `@previously-lab/kernel`)

The agent app now builds into a relocatable, self-contained kernel package. The client pins it by **exact version** and installs it from npm with provenance — what we shipped is byte-for-byte what runs on your machine, and upgrading the client is an atomic flip to a new kernel version, never a half-applied state.

### The agent itself

- **Client mode in the app** — the web UI detects a local client, offers both engines in settings with hot switching, and shows where it's running.
- **Evolution v1.0** — direction-driven self-evolution with sub-agent refinement, interaction fitness signals, and the direction phase rendered live on the evolution card (failures included — no silent skips).
- **Real stop** — interrupting a turn now actually cancels the run, server-side.
- **Honest bridge rendering** — housekeeping narration, degradation surfacing, and one source of truth for phase contracts between kernel and client.
- Demo mode now reads the public [previously-lab/you](https://github.com/previously-lab/you) dataset, and the in-app mock stream is gone — every demo turn you see is a real one.

### The site

[previously.ldwid.com](https://previously.ldwid.com) — the docs were rebuilt around the two forms (cloud on Vercel, local via npm), and the playground is no longer a canned animation: it runs the real recall colleague against the demo dataset, streaming over SSE, with the same thinking/recall cards the app renders.

### Upgrade notes

- Publish order matters: **`@previously-lab/kernel` first, then `@previously-lab/client`** (the client pins the kernel's exact version).
- The client ships on the **`preview` npm dist-tag** for now — a bare `npm i -g @previously-lab/client` won't resolve until the first stable release.
- Bridge users: the client↔kernel handshake is now exact-version bound. Older clients will refuse newer kernels (and vice versa) rather than fail mysteriously.

---

### 中文摘要

v0.9 把 Previously 带回了本地：`npm i -g @previously-lab/client@preview` 之后裸跑 `previously`，向导会把记忆初始化成一个普通的本地 git 仓库（默认 `~/Documents/Previously`），边聊边提交；想备份就 push 成私有仓库。引擎二选一：**BYOK（推荐，与云端完全一致的 workflow）**，或者桥接你已有的 Claude Code / Codex / Kimi Code 订阅（兼容路径，表现受目标 CLI 限制）。本体侧：evolution v1.0（direction 驱动的自我进化、过程实时可见）、真实停止、demo 改用公开数据集并移除假流。文档站重建了文档（云端 / 本地两条路径），playground 换成了真实请求。发布顺序：先发 kernel，再发 client；client 目前在 `preview` dist-tag 上，需要 Node.js ≥ 22.13。

---

Ideas and bug reports welcome on [GitHub Issues](https://github.com/previously-lab/agent/issues).
