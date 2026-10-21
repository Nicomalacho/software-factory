import { parseMarkers } from "./markers.js";

const PAPERCLIP_LINK = /https?:\/\/[^\s)>\]]*\/issues\/([A-Z][A-Z0-9]*-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;

function keyPrefix(pattern) {
  return pattern ? new RegExp(`^\\s*\\[(${pattern})\\]\\s*`, "i") : null;
}

export function issueKeyOf(title, pattern) {
  const prefix = keyPrefix(pattern);
  return (prefix && title?.match(prefix)?.[1]?.toUpperCase()) ?? null;
}

export function withoutIssueKey(title, pattern) {
  const prefix = keyPrefix(pattern);
  return prefix ? title.replace(prefix, "") : title;
}

export function paperclipRefsIn(body) {
  return [...(body ?? "").matchAll(PAPERCLIP_LINK)].map((match) => match[1]);
}

function isWatcherIssue(issue) {
  return parseMarkers(issue.description).length > 0;
}

export function findOriginalTask(pr, repoProjectId, issues, pattern) {
  const issueKey = issueKeyOf(pr.title, pattern);
  const candidates = issues.filter((issue) => !isWatcherIssue(issue));
  if (issueKey) {
    const matches = candidates
      .filter((issue) => issueKeyOf(issue.title, pattern) === issueKey)
      .sort(
        (a, b) =>
          Number(b.projectId === repoProjectId) - Number(a.projectId === repoProjectId) ||
          String(a.createdAt).localeCompare(String(b.createdAt)),
      );
    if (matches.length) return { issue: matches[0], via: "title" };
  }
  for (const ref of paperclipRefsIn(pr.body)) {
    const match = candidates.find((issue) => issue.identifier === ref || issue.id === ref);
    if (match) return { issue: match, via: "body-link" };
  }
  return { issue: null, via: null };
}
