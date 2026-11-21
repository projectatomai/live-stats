#!/usr/bin/env node
// Counts the AI tokens our agents used on this Mac and publishes daily
// totals to tokens.json in this repo. Only per-day numbers leave the
// machine: no prompts, code, file names or project names.
//
// Sources (read-only):
//   Claude Code: ~/.claude/projects/**/*.jsonl  (assistant message usage)
//   Codex:       ~/.codex/sessions/**/*.jsonl   (token_count events)
//
// Usage: node mac/publish-tokens.mjs [--dry-run] [--no-push]
// No dependencies. Node 18+.
import { createReadStream } from 'node:fs';
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, 'tokens.json');
const DRY = process.argv.includes('--dry-run');
const NO_PUSH = process.argv.includes('--no-push');
const HOME = homedir();
const CLAUDE_DIRS = [
  ...(process.env.CLAUDE_CONFIG_DIR || '').split(',').filter(Boolean).map((d) => join(d, 'projects')),
  join(HOME, '.claude', 'projects'),
  join(HOME, '.config', 'claude', 'projects'),
];
const CODEX_DIR = join(process.env.CODEX_HOME || join(HOME, '.codex'), 'sessions');

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (ts) => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; // local day
};

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
  }
}

async function eachLine(file, fn) {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || line[0] !== '{') continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    fn(obj);
  }
}

const days = new Map(); // day -> { claude, codex }
const add = (day, key, n) => {
  if (!day || !(n > 0)) return;
  const row = days.get(day) || { claude: 0, codex: 0 };
  row[key] += n;
  days.set(day, row);
};

async function countClaude() {
  const seen = new Set();
  const seenDirs = new Set();
  let files = 0;
  for (const dir of CLAUDE_DIRS) {
    try {
      const real = (await stat(dir)).ino;
      if (seenDirs.has(real)) continue;
      seenDirs.add(real);
    } catch {
      continue;
    }
    for await (const file of walk(dir)) {
      files++;
      await eachLine(file, (o) => {
        const u = o?.message?.usage;
        if (!u || o.type !== 'assistant') return;
        // streamed replies repeat the same usage on several lines
        const key = `${o.message.id || ''}:${o.requestId || ''}`;
        if (key !== ':') {
          if (seen.has(key)) return;
          seen.add(key);
        }
        const n =
          (u.input_tokens || 0) +
          (u.output_tokens || 0) +
          (u.cache_creation_input_tokens || 0) +
          (u.cache_read_input_tokens || 0);
        add(dayOf(o.timestamp), 'claude', n);
      });
    }
  }
  return files;
}

async function countCodex() {
  let files = 0;
  for await (const file of walk(CODEX_DIR)) {
    files++;
    let prevTotal = 0;
    await eachLine(file, (o) => {
      const p = o?.payload;
      if (o.type !== 'event_msg' || p?.type !== 'token_count' || !p.info) return;
      const total = p.info.total_token_usage?.total_tokens;
      let n = 0;
      if (typeof total === 'number') {
        // cumulative per session: count only the growth
        n = total - prevTotal;
        if (n < 0) n = total; // counter reset
        prevTotal = total;
      } else {
        n = p.info.last_token_usage?.total_tokens || 0;
      }
      add(dayOf(o.timestamp), 'codex', n);
    });
  }
  return files;
}

const git = (...args) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' }).trim();

async function main() {
  if (!DRY && !NO_PUSH) git('pull', '--rebase', '-q');
  const claudeFiles = await countClaude();
  const codexFiles = await countCodex();
  const list = [...days.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([d, r]) => ({ d, t: r.claude + r.codex, c: r.claude, x: r.codex }));
  const total = list.reduce((s, r) => s + r.t, 0);
  console.error(`Claude files ${claudeFiles}, Codex files ${codexFiles}, ${list.length} days, ${total.toLocaleString()} tokens`);
  if (!list.length) throw new Error('No usage found; not publishing.');

  let prev = null;
  try {
    prev = JSON.parse(await readFile(OUT, 'utf8'));
  } catch {}
  // never publish a smaller all-time total than before (logs get pruned)
  if (prev?.total && total < prev.total * 0.98) {
    const keep = new Map(prev.days.map((r) => [r.d, r]));
    for (const r of list) {
      const old = keep.get(r.d);
      if (!old || r.t >= old.t) keep.set(r.d, r);
    }
    list.splice(0, list.length, ...[...keep.values()].sort((a, b) => (a.d < b.d ? -1 : 1)));
  }
  const out = {
    generated: new Date().toISOString(),
    sources: ['Claude Code', 'Codex'],
    since: list[0].d,
    total: list.reduce((s, r) => s + r.t, 0),
    days: list,
  };
  if (DRY) {
    console.log(JSON.stringify({ ...out, days: out.days.slice(-5) }, null, 2));
    return;
  }
  if (prev && JSON.stringify(prev.days) === JSON.stringify(out.days)) {
    console.error('No change.');
    return;
  }
  await writeFile(OUT, JSON.stringify(out) + '\n');
  if (NO_PUSH) return;
  git('add', 'tokens.json');
  git('-c', 'user.name=live-stats bot', '-c', 'user.email=live-stats@users.noreply.github.com', 'commit', '-q', '-m', 'Update token totals');
  for (let i = 0; ; i++) {
    try {
      git('push', '-q');
      break;
    } catch (err) {
      if (i >= 2) throw err;
      git('pull', '--rebase', '-q'); // the GitHub feed job may have pushed meanwhile
    }
  }
  console.error('Published.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
