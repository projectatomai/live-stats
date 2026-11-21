# live-stats

Live numbers for [protomota.com](https://protomota.com): how many AI tokens our agents use, and what we ship on GitHub.

- `tokens.json`: daily token totals from Claude Code and Codex, counted on our Mac every hour by `mac/publish-tokens.mjs`. Only per-day numbers are published: no prompts, code, file or project names.
- `github.json`: recent activity in our public repos, refreshed every 15 minutes by a GitHub Action (`scripts/github-activity.mjs`).

The homepage reads both files server-side, so no keys are involved.

© Protomota
