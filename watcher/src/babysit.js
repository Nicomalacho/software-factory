import { summarizeChecks } from "./checks.js";
import { classifyAuthor } from "./comments.js";

export function isStackedBase(baseRef, config) {
  return Boolean(baseRef?.startsWith(config.github.factoryBranchPrefix));
}

export function parentBranchToCheck(pr, previous, config) {
  if (isStackedBase(pr.baseRefName, config)) return pr.baseRefName;
  if (previous && previous.baseRef !== pr.baseRefName && isStackedBase(previous.baseRef, config)) return previous.baseRef;
  return null;
}

export function snapshotPullRequest(pr, repo, config) {
  const checks = summarizeChecks(pr.statusCheckRollup, config.github.ignoredChecks);
  return {
    repo: repo.name,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    headRef: pr.headRefName,
    headSha: pr.headRefOid,
    baseRef: pr.baseRefName,
    isDraft: pr.isDraft,
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    ci: checks.conclusion,
    failingChecks: checks.failing,
    updatedAt: pr.updatedAt,
    createdAt: pr.createdAt,
  };
}

export function conditionKeys({ snapshot, repo, parentPr, awaitingApproval }) {
  const keys = [];
  if (snapshot.mergeable === "CONFLICTING") {
    keys.push({ cause: "conflict", key: snapshot.headSha });
  }
  if (snapshot.ci === "failing") {
    keys.push({ cause: "ci-failed", key: snapshot.headSha });
  }
  if (parentPr) {
    keys.push({ cause: "parent-merged", key: String(parentPr.number), parentPr });
  }
  if (repo.requireUpToDateBeforeApproval && snapshot.mergeStateStatus === "BEHIND" && awaitingApproval) {
    keys.push({ cause: "behind-at-approval", key: snapshot.headSha });
  }
  return keys;
}

export function splitFeedback(items, seenIds, config) {
  const seen = new Set(seenIds);
  const fresh = items.filter((item) => !seen.has(item.id));
  const byClass = { board: [], agent: [], bot: [], ignored: [], "other-human": [] };
  for (const item of fresh) byClass[classifyAuthor(item, config.github)].push(item);
  return byClass;
}
