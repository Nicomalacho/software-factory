# factory-watcher

A plain Node script, with no AI model and no npm dependencies, that watches a software factory's draft PRs and opens a [Paperclip](https://github.com/paperclipai/paperclip) task only when an agent has real work to do. Checking GitHub costs nothing, so agents run only when there is something to fix, answer or check. It works with any set of GitHub repos: the repos, branch prefix, issue-key pattern, people and agents all come from the config.

Each tick (for example every 10 minutes during business hours):

| Section | What it watches | What it opens |
|---|---|---|
| A. Babysit | Open PRs whose head branch starts with `github.factoryBranchPrefix`, in every configured repo | A Developer task when a PR becomes `CONFLICTING`, a real CI check fails on a new head, a stacked PR's parent merges, or a repo with `requireUpToDateBeforeApproval` is `BEHIND` while its task waits on the board's approval |
| B. Board comments | GitHub comments, reviews and inline comments by `github.boardLogin`; Paperclip comments by `paperclip.boardUserId` on code tasks no agent holds (done, or waiting on the board's approval) | One Developer rework task per PR (or task) per tick, quoting the comments verbatim |
| C. Shipped ledger | Factory PRs merged into each repo's `baseBranch` since `ledger.seedMergedSince`, and the deploy PRs that carry them to production | On Call tasks at deploy +1 h and +24 h (error tracker and a live check, ending in `Result: GREEN` / `Result: RED – <reason>`), Head of Product tasks at +7 and +30 days (KR), and a Developer fix task on RED |
| D. Board | All open issues in the repos' Paperclip projects, their PRs, failed agent runs in the last 24 h | Documents `board` (at most hourly) and `shipped-ledger` on the board issue, and a daily summary comment on the first tick of each business day |

Rework and fix tasks get a review policy: review by the Reviewer agent, then approval by the board user, `commentRequired: true`.

## Hard limits

- Never comments on GitHub, never changes draft/ready state, never pushes or merges. It only reads GitHub through `gh`.
- Never changes an existing Paperclip issue (status, assignee, policy). It only creates issues, writes documents on the board issue, and posts the daily summary on the board issue.
- One open task per PR and cause. Every task description starts with a marker such as `<!-- factory-watcher:v1 cause=conflict repo=api pr=14373 key=<head-sha> -->`. Before creating, the script looks for an open issue with the same cause, repo and PR (or task) in Paperclip, and for the same event in the state file. It also sends the marker as Paperclip's `idempotencyKey`, so a retried create returns the existing issue.
- A board comment, on GitHub or on a Paperclip task, that arrives while the previous rework task for that PR or task is still open waits until that task closes, then gets its own task.
- Never prints secrets. Errors carry the HTTP status and the first 300 characters of the response body, never the request headers.

Task causes, as they appear in the marker: `conflict`, `ci-failed`, `parent-merged`, `behind-at-approval`, `board-comment`, `ship-check-1h`, `ship-check-24h`, `kr-7d`, `kr-30d`, `ship-red`.

## Run it

Keep your real config outside the repo, for example in `~/.paperclip/factory-watcher/config.json`:

```bash
mkdir -p ~/.paperclip/factory-watcher
cp watcher/config.example.json ~/.paperclip/factory-watcher/config.json   # then fill in your repos, IDs and people
export PAPERCLIP_API_URL=http://127.0.0.1:3100 PAPERCLIP_API_KEY=... PAPERCLIP_COMPANY_ID=...
node watcher/bin/factory-watcher.js --config ~/.paperclip/factory-watcher/config.json --dry-run
```

| Flag | Meaning |
|---|---|
| `--config <path>` | Config file. Defaults to `$FACTORY_WATCHER_CONFIG`. |
| `--state <path>` | State file, overrides `stateFile` in the config. |
| `--dry-run` | Reads GitHub and Paperclip live, prints every write it would make plus the board and ledger it would write. Writes nothing to Paperclip and doesn't touch the state file. |
| `--ignore-hours` | Run outside business hours (manual runs only). |

Outside business hours the script prints one line and exits 0 before any API call. It exits 1 on a real failure (GitHub or Paperclip unreachable, bad config, corrupt state file), so a broken watcher shows up as a failed run. `gh` calls are retried on 5xx; Paperclip calls are retried on 429.

Tests use recorded-shape `gh` and Paperclip output in `test/fixtures` (made-up `acme/*` repos and text) and need no network:

```bash
cd watcher && node --test test/*.test.js
```

## State file

`stateFile` must be an absolute path outside the repo. It's JSON, written atomically (temp file and rename) at the end of each tick, and after each created task. It holds, per open PR, the head SHA, base branch, mergeable state, CI conclusion, the condition keys already handled and the GitHub comment IDs already seen; per tracked Paperclip task, the last comment seen; the ledger rows and their checks; the deploy PRs seen; the markers of tasks created; and when the board and the daily summary were last written.

If the file is missing, the tick is a **baseline**: it records what it sees and opens nothing. Conditions that already exist at baseline (today's conflicts, for example) show on the board but don't get a task until they change. Ledger checks that fell due before the baseline are marked "not run (before watcher)". Delete the file to re-baseline; the Paperclip marker check means a lost file never causes duplicates.

## Config

See `config.example.json`. Its repos, IDs and people are placeholders.

| Key | Meaning |
|---|---|
| `stateFile` | Absolute path of the state file. |
| `businessHours` | `timeZone`, `days` (`Mon`…`Sun`), `start`, `end` (`HH:MM`, end exclusive). |
| `issueKeyPattern` | Regex for the tracker key a PR title and its Paperclip task title both start with, in square brackets: `ENG-\\d+` matches `[ENG-123] Title`. PRs are matched to their task by this key, then by a Paperclip issue link in the PR body. `null` turns key matching off. |
| `github.boardLogin` | The GitHub login of the person who approves the factory's PRs. |
| `github.factoryBranchPrefix` | Head-branch prefix of the PRs to watch, for example `factory/`. A PR whose base starts with it is treated as stacked. |
| `github.botLogins` | Logins treated as bots, besides any `[bot]` login or `user.type` `Bot`. |
| `github.agentMarkers` | Text that marks a comment an agent posted through the board's `gh` login, for example `<!-- factory-agent`. |
| `github.agentPhrasePatterns` | Regexes for agent-only wording ("Reviewer agent", "Fixed in `<sha>`", the board's name in the third person). A stopgap for agent comments posted before the marker rule. Comments by `boardLogin` that match only a phrase (no marker) are listed on the board under "<login> comments read as agent", so a misread comment is still visible. |
| `github.ignoredBodyPatterns` | Comments that are only bot triggers, such as `@claude @codex review this`. |
| `github.ignoredChecks` | Regexes for checks that don't count as CI (review bots, preview deploys, deploy jobs). Skipped checks count as not run. |
| `paperclip.boardUserId` | The Paperclip user who approves (`local-board` on a local instance). |
| `paperclip.boardUserName` | That person's display name, used in task titles and on the board ("Rework from Alex's comments", "PRs waiting on Alex"). |
| `paperclip.boardIssueId` | The board issue. `null` means no board, ledger or daily summary is written; everything else still runs. |
| `paperclip.uiBaseUrl` | Base for links to Paperclip comments in rework tasks, including the company prefix. |
| `paperclip.approvalPatterns` | Comments by the board user that are approvals ("approve", "approved", "lgtm"…), not rework. Empty comments are ignored too. |
| `paperclip.agents` | `developer`, `reviewer`, `qa`, `onCall` and `headOfProduct` agent IDs. The board shows each agent's Paperclip name. |
| `paperclip.projects` | `productionMonitoring` (On Call tasks) and `discovery` (KR tasks). |
| `repos[]` | `name` (used in markers, titles and the ledger), optional `displayName` (shorter label on the board), `github` (`owner/repo`), `projectId` (Paperclip project), `baseBranch`, `deploy`, optional `manualDeployPaths` and `requireUpToDateBeforeApproval`. |
| `repos[].deploy` | `type: "deploy-pr"` with `base` (production branch), `head` (usually the base branch), `titlePattern` and an optional `label` (default "deploy PR"). Any other `type` shows "deploy: unknown" in the ledger and opens no ship checks. |
| `repos[].manualDeployPaths` | `[{ "path", "label" }]`: paths that ship by hand, not with the deploy PR. Ledger rows for PRs touching them say "<label>: manual deploy, unknown", and their On Call task asks to check that part is live first. |
| `repos[].requireUpToDateBeforeApproval` | `true` for repos that need a branch up to date with its base before merging: a `BEHIND` PR whose task waits on the board's approval gets one rebase task per head. |
| `ledger.seedMergedSince` | Date of the earliest merged PR to seed the ledger with. |
| `ledger.errorTracker` | Name of the error tracker in On Call task text (default "the error tracker"). |
| `board` | `approvalCap` (PRs waiting on the board before it reads "over cap"), `rewriteMinutes` (60), `stuckHours` (24). |

### How "in prod" is decided

For `deploy.type: "deploy-pr"`, a factory PR is in prod once the first deploy PR (head `deploy.head`, base `deploy.base`, title matching `deploy.titlePattern`) merged after it contains its merge commit: `gh api repos/<repo>/compare/<merge>...<deploy merge>` returns `ahead` or `identical`. Negative answers are cached, so each pair is compared once. Repos that ship another way can use any other `type`, and the ledger says "deploy: unknown" rather than guessing.

## Process adapter settings

Point a Paperclip agent at the built-in `process` adapter with a timer (10 minutes works):

| Setting | Value |
|---|---|
| `command` | `node` (Node 20 or later on the server's `PATH`) |
| `args` | `["<checkout>/watcher/bin/factory-watcher.js", "--config", "<config path>"]` |
| `cwd` | `<checkout>/watcher` |
| `env` | `GH_TOKEN`, bound as a secret. Nothing else: the adapter injects `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_AGENT_ID` and `PAPERCLIP_RUN_ID`. |
| `timeoutSec` | `300`. A baseline tick on about 15 open PRs takes 30–40 s; later ticks fetch comments only for PRs that changed. |
| `graceSec` | `15` (default). |

`<checkout>` should be a checkout of this repo's `main` that no agent works in, not a worktree that moves between branches.

Before switching it on:

1. **Create the board issue unassigned** (or assigned to the watcher agent) and put its ID in `paperclip.boardIssueId`. Paperclip refuses document writes by an agent on an issue another agent holds.
2. **Daily summary comment.** Paperclip only lets an agent comment when its run is tied to an issue (`cross_issue_influence_run_context_required`). A plain timer run has no issue, so the comment is refused; the script then writes the summary to the document `daily-summary` on the board issue instead and notes it in the run output. If the summary should be a comment, wake the agent from a routine whose runs carry the board issue.
3. **Agents must mark what they post on GitHub.** If agents post through the board's `gh` login, their comments look like the board's. Tell agents not to post on GitHub, or to start every post with `<!-- factory-agent:<role> -->`, before the watcher goes live. Otherwise agent reviews open rework tasks.
4. **Tell the Developer agent about the task causes** listed under "Hard limits", so it knows what each watcher task asks for.
5. The first tick is a baseline and opens nothing.
