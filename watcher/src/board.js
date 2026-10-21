import { deployLink } from "./deploys.js";
import { issueKeyOf, withoutIssueKey } from "./linking.js";
import { parseMarkers } from "./markers.js";

const CLOSED = new Set(["done", "cancelled"]);
const HOUR = 60 * 60 * 1000;

export function formatTime(iso) {
  return iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "?";
}

export function formatAge(fromIso, now) {
  if (!fromIso) return "?";
  const hours = Math.max(0, (now.getTime() - new Date(fromIso).getTime()) / HOUR);
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} d`;
}

function cell(text) {
  return String(text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

const ROLE_NAMES = {
  developer: "Developer",
  reviewer: "Reviewer",
  qa: "QA",
  onCall: "On Call",
  headOfProduct: "Head of Product",
};

function roleName(role, config, agentsById) {
  return agentsById.get(config.paperclip.agents[role])?.name ?? ROLE_NAMES[role];
}

function agentName(agentId, config, agentsById) {
  const role = Object.keys(ROLE_NAMES).find((candidate) => config.paperclip.agents[candidate] === agentId);
  if (role) return roleName(role, config, agentsById);
  return agentsById.get(agentId)?.name ?? "agent";
}

export function workItemStage(issue, config, agentsById) {
  const waitingOnBoard = !issue.assigneeAgentId && issue.assigneeUserId === config.paperclip.boardUserId;
  let stage = "unassigned";
  if (issue.assigneeAgentId) stage = agentName(issue.assigneeAgentId, config, agentsById);
  else if (waitingOnBoard) stage = config.paperclip.boardUserName;
  else if (issue.assigneeUserId) stage = issue.assigneeUserId;
  return { stage, waitingOnBoard: waitingOnBoard && ["in_review", "blocked"].includes(issue.status) };
}

function repoLabel(name, config) {
  return config.repos.find((repo) => repo.name === name)?.displayName ?? name;
}

function prLabel(pr, config) {
  if (!pr) return "–";
  const flags = [pr.isDraft ? "draft" : "ready"];
  if (pr.mergeable === "CONFLICTING") flags.push("conflict");
  if (pr.ci === "failing") flags.push("CI failing");
  else if (pr.ci === "passing") flags.push("CI green");
  else if (pr.ci === "pending") flags.push("CI running");
  return `[${repoLabel(pr.repo, config)}#${pr.number}](${pr.url}) ${flags.join(", ")}`;
}

function nextAction(item, config, agentsById) {
  const { issue, pr, stage } = item;
  const developer = roleName("developer", config, agentsById);
  if (stage.waitingOnBoard) return `${config.paperclip.boardUserName}: approve, or comment to send it back`;
  if (pr?.mergeable === "CONFLICTING") return `${developer}: resolve the conflict`;
  if (pr?.ci === "failing") return `${developer}: fix CI`;
  if (issue.status === "blocked") return "Unblock: see the last comment";
  if (issue.status === "backlog") return `${roleName("headOfProduct", config, agentsById)}: schedule or drop`;
  if (issue.status === "in_review") return `${stage.stage}: review`;
  if (issue.status === "todo") return `${stage.stage}: start`;
  return `${stage.stage}: finish`;
}

function prForIssue(issue, openPrs) {
  const direct = openPrs.find((pr) => pr.originalId === issue.id);
  if (direct) return direct;
  const marker = parseMarkers(issue.description).find((fields) => fields.pr);
  return marker ? openPrs.find((pr) => pr.repo === marker.repo && String(pr.number) === marker.pr) ?? null : null;
}

export function collectWork({ now, config, openPrs, codeIssues, agentsById, failedRuns, ledger }) {
  const items = codeIssues
    .filter((issue) => !CLOSED.has(issue.status))
    .map((issue) => {
      const pr = prForIssue(issue, openPrs);
      const lastMoved = [issue.lastActivityAt ?? issue.updatedAt, pr?.updatedAt].filter(Boolean).sort().pop();
      return { issue, pr, stage: workItemStage(issue, config, agentsById), lastMoved };
    })
    .sort((a, b) => String(a.lastMoved).localeCompare(String(b.lastMoved)));
  const needsBoard = items.filter((item) => item.stage.waitingOnBoard);
  const waitingPrs = new Set(needsBoard.filter((item) => item.pr).map((item) => `${item.pr.repo}#${item.pr.number}`));
  const stuckBefore = now.getTime() - config.board.stuckHours * HOUR;
  const stuck = items.filter(
    (item) => item.issue.status !== "backlog" && new Date(item.lastMoved).getTime() < stuckBefore,
  );
  const issueLabel = (id) => codeIssues.find((issue) => issue.id === id)?.identifier;
  const broken = [
    ...openPrs
      .filter((pr) => pr.mergeable === "CONFLICTING")
      .map((pr) => `${prLabel(pr, config)}: merge conflict${pr.originalIdentifier ? ` (${pr.originalIdentifier})` : ""}`),
    ...openPrs
      .filter((pr) => pr.ci === "failing")
      .map(
        (pr) =>
          `${prLabel(pr, config)}: failing ${pr.failingChecks.map((check) => check.name).join(", ")}${pr.originalIdentifier ? ` (${pr.originalIdentifier})` : ""}`,
      ),
    ...groupFailedRuns(failedRuns).map((group) => {
      const agent = agentsById.get(group.agentId)?.name ?? group.agentId;
      const issues = [...new Set(group.runs.map((run) => issueLabel(run.contextSnapshot?.issueId)).filter(Boolean))];
      const last = group.runs[0];
      const error = last.error ? `: ${String(last.error).replace(/\s+/g, " ").slice(0, 80)}` : "";
      return `${group.runs.length} failed run${group.runs.length > 1 ? "s" : ""}: ${agent}${issues.length ? ` on ${issues.join(", ")}` : ""}, last at ${formatTime(last.finishedAt ?? last.startedAt)} (${group.errorCode}${error})`;
    }),
    ...Object.values(ledger).flatMap((row) =>
      Object.entries(row.checks)
        .filter(([, check]) => check.result === "RED")
        .map(([cause, check]) => `RED ship check: [${row.repo}#${row.number}](${row.url}) ${cause}: ${check.reason ?? "no reason given"}`),
    ),
  ];
  const otherComments = openPrs.flatMap((pr) =>
    (pr.otherHumanComments ?? []).map((comment) => ({ pr, comment })),
  );
  const agentReadComments = openPrs.flatMap((pr) =>
    (pr.agentReadComments ?? []).map((comment) => ({ pr, comment })),
  );
  return { items, needsBoard, waitingPrs, stuck, broken, otherComments, agentReadComments };
}

function groupFailedRuns(runs) {
  const groups = new Map();
  const ordered = [...runs].sort((a, b) =>
    String(b.finishedAt ?? b.startedAt).localeCompare(String(a.finishedAt ?? a.startedAt)),
  );
  for (const run of ordered) {
    const errorCode = run.errorCode ?? run.status;
    const key = `${run.agentId}|${errorCode}`;
    if (!groups.has(key)) groups.set(key, { agentId: run.agentId, errorCode, runs: [] });
    groups.get(key).runs.push(run);
  }
  return [...groups.values()];
}

function itemLine(item, now, config) {
  const issueKey = issueKeyOf(item.issue.title, config.issueKeyPattern);
  const title = withoutIssueKey(item.issue.title, config.issueKeyPattern);
  return `${item.issue.identifier}${issueKey ? ` (${issueKey})` : ""} ${title}: ${item.pr ? `${prLabel(item.pr, config)}, ` : ""}${item.stage.stage}, ${formatAge(item.lastMoved, now)} since last move`;
}

function list(lines) {
  return lines.length ? lines.map((line) => `- ${line}`) : ["- none"];
}

export function renderBoard(input) {
  const { now, config, agentsById } = input;
  const work = collectWork(input);
  const boardName = config.paperclip.boardUserName;
  const cap = config.board.approvalCap;
  const count = work.waitingPrs.size;
  const lines = [
    "# Factory board",
    "",
    `Written by factory-watcher at ${formatTime(now.toISOString())}. Rewritten at most once an hour.`,
    "",
    `**PRs waiting on ${boardName}: ${count} of ${cap}${count > cap ? " (over cap)" : ""}**`,
    "",
    `## Needs ${boardName} (${work.needsBoard.length})`,
    ...list(work.needsBoard.map((item) => itemLine(item, now, config))),
    "",
    `## Stuck > ${config.board.stuckHours} h (${work.stuck.length})`,
    ...list(work.stuck.map((item) => itemLine(item, now, config))),
    "",
    `## Broken (${work.broken.length})`,
    ...list(work.broken),
    "",
    `## Comments by other people (${work.otherComments.length})`,
    ...list(
      work.otherComments.map(
        ({ pr, comment }) => `${pr.repo}#${pr.number}: [${comment.login}](${comment.url}) at ${formatTime(comment.createdAt)}`,
      ),
    ),
    "",
    `## ${config.github.boardLogin} comments read as agent (${work.agentReadComments.length})`,
    ...list(
      work.agentReadComments.map(
        ({ pr, comment }) => `${pr.repo}#${pr.number}: [${comment.excerpt || "(no text)"}](${comment.url}) at ${formatTime(comment.createdAt)}`,
      ),
    ),
    "",
    `## Open work (${work.items.length})`,
    "",
    "| Task | Key | PR | Status | Stage, waiting on | For | Next action |",
    "|---|---|---|---|---|---|---|",
    ...work.items.map((item) => {
      const issueKey = issueKeyOf(item.issue.title, config.issueKeyPattern) ?? "–";
      const title = withoutIssueKey(item.issue.title, config.issueKeyPattern).slice(0, 60);
      return `| ${cell(`${item.issue.identifier} ${title}`)} | ${issueKey} | ${cell(prLabel(item.pr, config))} | ${item.issue.status} | ${cell(item.stage.stage)} | ${formatAge(item.lastMoved, now)} | ${cell(nextAction(item, config, agentsById))} |`;
    }),
  ];
  return `${lines.join("\n")}\n`;
}

function checkCell(check) {
  if (!check) return "–";
  if (check.skipped) return "not run (before watcher)";
  if (check.result) return check.result === "RED" ? `RED: ${check.reason ?? "?"}` : "GREEN";
  return `${check.identifier ?? "task"} open`;
}

export function renderLedger({ now, ledger, config }) {
  const rows = Object.values(ledger).sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
  const lines = [
    "# Shipped ledger",
    "",
    `Factory PRs merged since the watcher's seed date. Written by factory-watcher at ${formatTime(now.toISOString())}.`,
    "",
    "| PR | Task | Merged | In prod | Ship check +1 h | Ship check +24 h | Checked live | KR +7 d | KR +30 d |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows.map((row) => {
      const inProd = row.deployUnknown
        ? "deploy: unknown"
        : row.deploy
          ? `${deployLink(row, config)} ${formatTime(row.deploy.mergedAt)}`
          : "not yet";
      const manual = row.manualDeploy?.length ? `; ${row.manualDeploy.join(", ")}: manual deploy, unknown` : "";
      return `| ${cell(`[${row.repo}#${row.number}](${row.url}) ${row.title.slice(0, 50)}`)} | ${row.originalIdentifier ?? "–"} | ${formatTime(row.mergedAt)} \`${row.mergeCommit.slice(0, 9)}\` | ${cell(inProd + manual)} | ${cell(checkCell(row.checks["ship-check-1h"]))} | ${cell(checkCell(row.checks["ship-check-24h"]))} | ${cell(checkCell(row.checks["ship-check-1h"]))} | ${cell(checkCell(row.checks["kr-7d"]))} | ${cell(checkCell(row.checks["kr-30d"]))} |`;
    }),
  ];
  return `${lines.join("\n")}\n`;
}

export function renderDailySummary(input) {
  const { now, codeIssues, ledger, snapshot } = input;
  const work = collectWork(input);
  const since = snapshot?.takenAt ?? null;
  const moved = snapshot
    ? codeIssues
        .filter((issue) => snapshot.statuses[issue.id] && snapshot.statuses[issue.id] !== issue.status)
        .map((issue) => `${issue.identifier} ${issue.title}: ${snapshot.statuses[issue.id]} → ${issue.status}`)
    : [];
  const created = snapshot
    ? codeIssues.filter((issue) => !snapshot.statuses[issue.id]).map((issue) => `${issue.identifier} ${issue.title}: new (${issue.status})`)
    : [];
  const merged = Object.values(ledger)
    .filter((row) => !since || row.mergedAt > since)
    .map((row) => `[${row.repo}#${row.number}](${row.url}) ${row.title}`);
  const lines = [
    `## Daily summary, ${now.toISOString().slice(0, 10)}`,
    "",
    `**What moved${since ? ` since ${formatTime(since)}` : ""}**`,
    ...list([...moved, ...created]),
    "",
    "**Merged**",
    ...list(merged),
    "",
    `**Stuck > ${input.config.board.stuckHours} h (${work.stuck.length})**`,
    ...list(work.stuck.map((item) => itemLine(item, now, input.config))),
    "",
    `**Needs ${input.config.paperclip.boardUserName} (${work.needsBoard.length})**`,
    ...list(work.needsBoard.map((item) => itemLine(item, now, input.config))),
    "",
    `**Broken (${work.broken.length})**`,
    ...list(work.broken),
  ];
  return `${lines.join("\n")}\n`;
}
