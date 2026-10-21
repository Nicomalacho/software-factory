import { deployLink } from "./deploys.js";
import { formatMarker } from "./markers.js";

export function causeLabel(cause, config) {
  const labels = {
    conflict: "Resolve conflict",
    "ci-failed": "Fix CI",
    "parent-merged": "Rebase after parent merged",
    "behind-at-approval": "Rebase before approval",
    "board-comment": `Rework from ${config.paperclip.boardUserName}'s comments`,
    "ship-red": "Fix after RED ship check",
    "ship-check-1h": "Ship check +1 h",
    "ship-check-24h": "Ship check +24 h",
    "kr-7d": "KR check +7 days",
    "kr-30d": "KR check +30 days",
  };
  return labels[cause] ?? cause;
}

function quote(text) {
  return text
    .trimEnd()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function taskLine(original) {
  if (!original) {
    return "Original task: **none found.** No Paperclip issue has this PR's issue-key title prefix, and the PR body has no Paperclip link. Find the owner from the PR and post your results on the PR's tracker issue instead.";
  }
  return `Original task: ${original.identifier} (${original.title})`;
}

function prLine(pr) {
  return `PR: [${pr.repo}#${pr.number}](${pr.url}), branch \`${pr.headRef}\` → \`${pr.baseRef}\`, head \`${pr.headSha.slice(0, 9)}\``;
}

const REPORT_BACK =
  "When you're done, post on the original task: the old and new head SHAs, the type check and test results, and GitHub's merge status (`gh pr view <n> -R <repo> --json mergeable,mergeStateStatus`).";

const SAME_PR = "Push to the same branch and PR. Don't open a new PR, don't mark it ready, don't merge.";

export function codeTaskTitle({ issueKey, cause, subject, config }) {
  return `${issueKey ? `[${issueKey}] ` : ""}${causeLabel(cause, config)}: ${subject}`;
}

export function conflictTask({ pr, original, repo, config }) {
  const parentNote = pr.baseRef.startsWith(config.github.factoryBranchPrefix)
    ? `This PR is stacked on \`${pr.baseRef}\`. Fix it against that parent branch, not \`${repo.baseBranch}\`.`
    : `Rebase onto (or merge) \`${pr.baseRef}\`.`;
  return [
    `GitHub reports a merge conflict on this PR.`,
    "",
    prLine(pr),
    taskLine(original),
    "",
    "What to do:",
    `1. ${parentNote} Resolve the conflicts.`,
    "2. Rerun the type check and the tests touching the change.",
    `3. ${SAME_PR}`,
    `4. ${REPORT_BACK}`,
  ].join("\n");
}

export function ciFailedTask({ pr, original }) {
  const checks = pr.failingChecks.map((check) => `- ${check.url ? `[${check.name}](${check.url})` : check.name}`);
  return [
    `CI is failing on the latest head of this PR.`,
    "",
    prLine(pr),
    taskLine(original),
    "",
    "Failing checks:",
    ...checks,
    "",
    "What to do:",
    "1. Find out why each check fails. If it's a known flaky job, rerun the whole workflow (`gh run rerun <id>`) and say so.",
    "2. Fix it on the same branch and rerun the checks locally.",
    `3. ${SAME_PR}`,
    "4. On the original task, post the failing check, the cause and the fix (old and new heads).",
  ].join("\n");
}

export function parentMergedTask({ pr, original, parentPr, previousBase, repo }) {
  const base = repo.baseBranch;
  return [
    `The parent of this stacked PR is merged: [#${parentPr.number}](${parentPr.url}) (\`${previousBase}\`).`,
    "",
    prLine(pr),
    taskLine(original),
    "",
    "What to do:",
    `1. Rebase onto \`${base}\` and drop the parent's original commits (\`git rebase --onto origin/${base} <last parent commit> <branch>\`).`,
    `2. If the PR still targets \`${previousBase}\`, retarget it to \`${base}\`.`,
    '3. Remove the "Stacked on" line from the PR body.',
    "4. Rerun the type check and the tests touching the change.",
    `5. ${SAME_PR}`,
    `6. ${REPORT_BACK}`,
  ].join("\n");
}

export function behindAtApprovalTask({ pr, original, repo, config }) {
  return [
    `This ${repo.name} PR is behind \`${pr.baseRef}\` and its task is waiting on ${config.paperclip.boardUserName}'s approval. ${repo.name} needs the branch up to date before it can merge.`,
    "",
    prLine(pr),
    taskLine(original),
    "",
    "What to do:",
    `1. One clean rebase onto \`${pr.baseRef}\`. No other changes.`,
    "2. Rerun the repo's type check and tests.",
    `3. ${SAME_PR}`,
    `4. ${REPORT_BACK}`,
  ].join("\n");
}

function feedbackBlock(item) {
  const where = item.path ? ` on \`${item.path}${item.line ? `:${item.line}` : ""}\`` : "";
  const kind = { comment: "Comment", review: `Review (${item.reviewState ?? "COMMENTED"})`, inline: "Inline comment" }[item.kind] ?? "Comment";
  return [`**${kind}${where}**, ${item.createdAt}: ${item.url}`, "", quote(item.body)].join("\n");
}

export function reworkTask({ pr, original, items, source, config }) {
  const name = config.paperclip.boardUserName;
  const intro =
    source === "github"
      ? `${name} commented on this PR on GitHub. The comments, verbatim:`
      : `${name} commented on ${original.identifier} while no agent had it. The comments, verbatim:`;
  return [
    intro,
    "",
    ...items.flatMap((item) => [feedbackBlock(item), ""]),
    pr ? prLine(pr) : "PR: none found for this task.",
    taskLine(original),
    "",
    "What to do:",
    "1. If a comment is a question, answer it in this task and don't change code for it.",
    "2. Otherwise make the change, then rerun the type check and the tests touching it.",
    `3. ${SAME_PR}`,
    `4. ${REPORT_BACK}`,
  ].join("\n");
}

export function shipRedTask({ row, check, reason, repo, config }) {
  return [
    `The ${causeLabel(check, config)} for [${row.repo}#${row.number}](${row.url}) came back RED: ${reason || "no reason given"}.`,
    "",
    `Merged ${row.mergedAt} as \`${row.mergeCommit.slice(0, 9)}\`; in prod via ${row.deploy ? `${deployLink(row, config)} at ${row.deploy.mergedAt}` : "an unknown deploy"}.`,
    `On Call task: ${row.checks[check]?.identifier ?? "?"}`,
    row.originalIdentifier ? `Original task: ${row.originalIdentifier}` : "Original task: none found.",
    "",
    "What to do:",
    "1. Read the On Call task, reproduce the problem, and find the cause.",
    `2. Fix it on a new \`${config.github.factoryBranchPrefix}\` branch off \`${repo.baseBranch}\` and open a draft PR, or explain on this task why no code change is needed.`,
    "3. Post the PR, the cause and the test results here and on the original task.",
  ].join("\n");
}

export function shipCheckTask({ row, hours, config }) {
  const tracker = config.ledger.errorTracker ?? "the error tracker";
  const manual = row.manualDeploy?.length
    ? `\n**Deploy caveat:** this PR changes ${row.manualDeploy.join(", ")}, which ships by hand, not with the deploy PR. First check whether that part is live with this change. If it isn't, end with \`Result: GREEN – not deployed yet\` and say so.\n`
    : "";
  return [
    `Ship check ${hours} h after deploy for [${row.repo}#${row.number}](${row.url}) (${row.title}).`,
    "",
    `- Merged: ${row.mergedAt}, commit \`${row.mergeCommit.slice(0, 9)}\``,
    `- In prod: ${deployLink(row, config)} merged ${row.deploy.mergedAt}`,
    row.originalIdentifier ? `- Original task: ${row.originalIdentifier}` : "- Original task: none found",
    manual,
    "What to check:",
    `1. ${tracker}: new issues since the deploy and the event rate for the affected service, against the same window the week before.`,
    "2. A live check of the changed behaviour in production. Read only: no writes to production data.",
    "",
    "End your last comment with exactly one line:",
    "`Result: GREEN` or `Result: RED – <reason>`",
    "A RED result opens a Developer fix task automatically.",
  ].join("\n");
}

export function krTask({ row, days, config }) {
  return [
    `KR check ${days} days after deploy for [${row.repo}#${row.number}](${row.url}) (${row.title}).`,
    "",
    `- Issue key: ${row.issueKey ?? "none"}`,
    row.originalIdentifier ? `- Original task: ${row.originalIdentifier}` : "- Original task: none found",
    `- Goal of the original task: ${row.goalTitle ?? "none set"}`,
    `- Deployed: ${deployLink(row, config)} at ${row.deploy.mergedAt}`,
    "",
    "What to do: measure the KR this change serves (query its source, don't reuse a number you didn't query), then comment the before/after on the tracker issue and the original Paperclip task.",
  ].join("\n");
}

export function withMarker(fields, body) {
  return `${formatMarker(fields)}\n\n${body}`;
}
