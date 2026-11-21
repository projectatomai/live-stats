// Builds github.json: recent public activity for one GitHub user.
// Public repos only. Runs in GitHub Actions on a schedule (see
// .github/workflows/github-activity.yml). Node 20+, no dependencies.
import { readFile, writeFile } from 'node:fs/promises';

const USER = process.env.GH_USER || 'protomota';
const OUT = process.env.OUT || 'github.json';
const MAX_ITEMS = 30;
// This repo commits on a schedule, so it never shows up in the feed.
const SKIP_REPOS = new Set(['live-stats']);
// Words we never show in public, even if they appear in a commit message.
const BLOCKED = [/daily[\s-]*brief/i];

const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': `${USER}-live-stats`,
  'X-GitHub-Api-Version': '2022-11-28',
};
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

const firstLine = (s = '') => s.split('\n')[0].trim().slice(0, 140);
const clean = (s) => (BLOCKED.some((re) => re.test(s)) ? null : s);

const repoCache = new Map();
async function repoInfo(full) {
  if (!repoCache.has(full)) {
    repoCache.set(full, gh(`/repos/${full}`).catch(() => null));
  }
  return repoCache.get(full);
}

async function main() {
  const events = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await gh(`/users/${USER}/events/public?per_page=100&page=${page}`);
    events.push(...batch);
    if (batch.length < 100) break;
  }

  const items = [];
  for (const e of events) {
    const full = e.repo?.name || '';
    const name = full.split('/')[1] || full;
    if (!full.startsWith(`${USER}/`) || SKIP_REPOS.has(name)) continue;
    const repo = await repoInfo(full);
    if (!repo || repo.private) continue;
    const site = repo.homepage ? repo.homepage.replace(/^https?:\/\//, '').replace(/\/$/, '') : null;
    const base = { id: e.id, repo: name, repoUrl: repo.html_url, site, at: e.created_at };

    if (e.type === 'PushEvent') {
      const ref = (e.payload?.ref || '').replace('refs/heads/', '');
      if (ref !== repo.default_branch) continue;
      const { head, before } = e.payload;
      let commits = e.payload.commits || [];
      if (!commits.length && head) {
        try {
          if (before && !/^0+$/.test(before)) {
            const cmp = await gh(`/repos/${full}/compare/${before}...${head}`);
            commits = cmp.commits.map((c) => ({ sha: c.sha, message: c.commit.message }));
          } else {
            const c = await gh(`/repos/${full}/commits/${head}`);
            commits = [{ sha: c.sha, message: c.commit.message }];
          }
        } catch {
          continue;
        }
      }
      if (!commits.length) continue;
      const last = commits[commits.length - 1];
      const title = clean(firstLine(last.message));
      if (!title || /^Merge (pull request|branch)/.test(title)) continue;
      items.push({
        ...base,
        kind: 'ship',
        title,
        count: commits.length,
        sha: last.sha.slice(0, 7),
        url: `${repo.html_url}/commit/${last.sha}`,
      });
    } else if (e.type === 'ReleaseEvent' && e.payload?.action === 'published') {
      const r = e.payload.release;
      const title = clean(firstLine(r.name || r.tag_name));
      if (title) items.push({ ...base, kind: 'release', title, tag: r.tag_name, url: r.html_url });
    } else if (e.type === 'PullRequestEvent' && e.payload?.action === 'closed' && e.payload.pull_request?.merged) {
      const pr = e.payload.pull_request;
      const title = clean(firstLine(pr.title));
      if (title) items.push({ ...base, kind: 'merge', title, url: pr.html_url });
    } else if (e.type === 'PublicEvent') {
      items.push({ ...base, kind: 'public', title: `Open-sourced ${name}`, url: repo.html_url });
    }
  }

  items.sort((a, b) => (a.at < b.at ? 1 : -1));
  const top = items.slice(0, MAX_ITEMS);

  let prev = null;
  try {
    prev = JSON.parse(await readFile(OUT, 'utf8'));
  } catch {}
  if (prev && JSON.stringify(prev.items) === JSON.stringify(top)) {
    console.log('No change.');
    return;
  }
  const out = { generated: new Date().toISOString(), user: USER, items: top };
  await writeFile(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`Wrote ${top.length} items.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
