import { execFile } from "node:child_process";

const PR_FIELDS = [
  "number",
  "title",
  "url",
  "headRefName",
  "baseRefName",
  "headRefOid",
  "isDraft",
  "mergeable",
  "mergeStateStatus",
  "statusCheckRollup",
  "body",
  "createdAt",
  "updatedAt",
].join(",");

const MERGED_FIELDS = ["number", "title", "url", "headRefName", "baseRefName", "mergedAt", "mergeCommit"].join(",");

const TRANSIENT = /HTTP 5\d\d|timed out|connection reset/i;

function runGhOnce(args) {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { maxBuffer: 256 * 1024 * 1024, env: process.env }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`gh ${args.slice(0, 4).join(" ")} failed: ${String(stderr).trim() || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

export async function runGh(args, { attempts = 3, delayMs = 3000 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await runGhOnce(args);
    } catch (error) {
      if (attempt >= attempts || !TRANSIENT.test(error.message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}

export function createGitHub(run = runGh) {
  const json = async (args) => JSON.parse(await run(args));
  const paginated = async (path) => (await json(["api", path, "--paginate", "--slurp"])).flat();

  return {
    listOpenPullRequests: (repo, headPrefix) =>
      json(["pr", "list", "-R", repo, "--state", "open", "--search", `head:${headPrefix}`, "--limit", "100", "--json", PR_FIELDS]),
    listMergedPullRequests: (repo, base, sinceDate, headPrefix) =>
      json([
        "pr",
        "list",
        "-R",
        repo,
        "--state",
        "merged",
        "--base",
        base,
        "--search",
        `merged:>=${sinceDate}${headPrefix ? ` head:${headPrefix}` : ""}`,
        "--limit",
        "300",
        "--json",
        MERGED_FIELDS,
      ]),
    listMergedPullRequestsByHead: (repo, head) =>
      json(["pr", "list", "-R", repo, "--state", "merged", "--head", head, "--limit", "5", "--json", MERGED_FIELDS]),
    listIssueComments: (repo, number) => paginated(`repos/${repo}/issues/${number}/comments?per_page=100`),
    listReviews: (repo, number) => paginated(`repos/${repo}/pulls/${number}/reviews?per_page=100`),
    listReviewComments: (repo, number) => paginated(`repos/${repo}/pulls/${number}/comments?per_page=100`),
    compareStatus: async (repo, base, head) =>
      (await json(["api", `repos/${repo}/compare/${base}...${head}?per_page=1`, "--jq", "{status: .status}"])).status,
    listPullRequestFiles: async (repo, number) =>
      (await json(["pr", "view", String(number), "-R", repo, "--json", "files"])).files.map((file) => file.path),
  };
}
