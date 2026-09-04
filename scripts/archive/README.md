# scripts/archive

One-off migration and repair scripts from earlier iterations, kept for
reference only. None of these are wired into `package.json`, CI, or the
app — do not run them against current data without reading them first.

Caveats:

- Several scripts hardcode stale paths. `fix-agent-memory.mjs` points at a
  different repo checkout; `update-demo-metadata.mjs` and
  `fix-rotated-metadata.mjs` reference `memory/demo/personal_14/...` trees
  that no longer exist (demo data moved to `benchmark-data/`).
- `migrate-slices-to-time.mjs`, `shift-all-dates.mjs`,
  `shift-demo-dates.mjs`, and `apply-enrichment.mjs` were single-use
  migrations whose transforms have already been applied.
- `convert-worldmemarena.mjs` (originally `benchmark-data/convert.mjs`) was
  the one-off WorldMemArena → slice converter; its input data lives in the
  gitignored `benchmark-data/` dir, and its `__dirname`-relative paths still
  point there. `smoke-search.mjs` was the one-off DeepSeek web-search smoke
  test referenced from `src/lib/search/flash-search.ts`.
