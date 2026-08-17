/**
 * One-time engineering migration for the agent repo's existing memories.
 *
 *  - DRY slices (empty focus+summary): fill a DETERMINISTIC focus/summary from
 *    the slice's own content (first user turn opening + tags + turn count).
 *    No LLM — faithful to the real memory, zero hallucination risk.
 *  - ORPHANED ACTIVE slices (status active, last turn > 30 min old): close them
 *    (status=closed, end = last turn timestamp). The app never closed them
 *    because the close fires on the NEXT turn.
 *
 * Safe by construction: git is the backup (memory/ is committed in agent repo).
 * `--dry` previews every change without writing.
 */
import matter from "gray-matter";
import { promises as fsp } from "fs";
import path from "path";

const ROOT = "C:/Users/Dream/Documents/GitHub/agent/memory/episodic/slices";
const OPENING_MAX = 60;
const DRY = process.argv.includes("--dry");

const exists = async (p) => { try { await fsp.access(p); return true; } catch { return false; } };

async function collectSliceDirs(root) {
  const out = [];
  const years = await fsp.readdir(root, { withFileTypes: true });
  for (const y of years) {
    if (!y.isDirectory() || !/^\d{4}$/.test(y.name)) continue;
    const months = await fsp.readdir(path.join(root, y.name), { withFileTypes: true });
    for (const mo of months) {
      if (!mo.isDirectory() || !/^\d{2}$/.test(mo.name)) continue;
      const days = await fsp.readdir(path.join(root, y.name, mo.name), { withFileTypes: true });
      for (const d of days) {
        if (!d.isDirectory() || !/^\d{2}$/.test(d.name)) continue;
        const slices = await fsp.readdir(path.join(root, y.name, mo.name, d.name), { withFileTypes: true });
        for (const s of slices) {
          if (s.isDirectory() && /^\d{4}$/.test(s.name)) out.push(path.join(root, y.name, mo.name, d.name, s.name));
        }
      }
    }
  }
  return out;
}

function parseTurns(body) {
  // Split on the turn-header marker. JS has no \Z anchor (a literal in regex),
  // so a lazy body capture + end-of-string lookahead truncates the last turn —
  // split avoids that entirely and tolerates CRLF.
  const turns = [];
  const parts = body.split(/^## Turn /m);
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const m = part.match(/^(\S+) — (\S+) \((\w+)\)\r?\n\r?\n([\s\S]*)$/m);
    if (!m) continue;
    turns.push({ role: m[3], content: m[4].trim(), ts: m[2] });
  }
  return turns;
}

function deterministicMark(turns, tags) {
  const firstUser = turns.find((t) => t.role === "user");
  const opening = firstUser
    ? firstUser.content.trim().split(/\n/)[0].replace(/\s+/g, " ").slice(0, OPENING_MAX)
    : "";
  const tagStr = tags.length ? tags.join("、") : "未标记话题";
  const focus = opening ? `用户提到：${opening}${opening.length >= OPENING_MAX ? "…" : ""}` : `会话（${tagStr}）`;
  const summary = `共 ${turns.length} 轮，涉及 ${tagStr}。`;
  return { focus, summary };
}

const now = Date.now();
const dirs = await collectSliceDirs(ROOT);
let filled = 0, closed = 0, changed = 0;

for (const dir of dirs) {
  const corePath = path.join(dir, "timeline", "core.md");
  if (!(await exists(corePath))) continue;
  const raw = await fsp.readFile(corePath, "utf8");
  const { data, content } = matter(raw);
  const turns = parseTurns(content);
  const tags = Array.isArray(data.tags) ? data.tags.filter((t) => typeof t === "string") : [];
  const lastTs = turns.length ? turns[turns.length - 1].ts : "";
  const lastMs = lastTs ? Date.parse(lastTs) : 0;

  const plan = [];
  const newData = { ...data };
  if (!data.focus && !data.summary) {
    const mark = deterministicMark(turns, tags);
    newData.focus = mark.focus;
    newData.summary = mark.summary;
    plan.push(`fill focus="${mark.focus}"`);
    plan.push(`      summary="${mark.summary}"`);
    filled++;
  }
  if (data.status === "active" && lastMs && now - lastMs > 30 * 60 * 1000) {
    newData.status = "closed";
    newData.end = lastTs;
    plan.push(`close (was active) end="${lastTs}"`);
    closed++;
  }
  if (plan.length) {
    changed++;
    if (DRY) {
      console.log(`[DRY] ${path.relative(ROOT, dir)}`);
      plan.forEach((p) => console.log(`   ${p}`));
    } else {
      // Preserve the file's CRLF line endings — matter.stringify emits LF, and
      // rewriting a real memory's whole line-ending style is needless churn.
      const out = matter.stringify(content, newData).replace(/\r?\n/g, "\r\n");
      await fsp.writeFile(corePath, out, "utf8");
    }
  }
}

console.log(`\n${DRY ? "[DRY-RUN] would change" : "[APPLIED] changed"} ${changed} slices (${filled} dry filled, ${closed} orphan closed) of ${dirs.length}`);
