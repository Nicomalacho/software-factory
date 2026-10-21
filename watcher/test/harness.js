import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGitHub } from "../src/github.js";
import { createPaperclip } from "../src/paperclip.js";
import { loadState, saveState } from "../src/state.js";
import { runTick } from "../src/tick.js";

const here = dirname(fileURLToPath(import.meta.url));
export const COMPANY = "company-1";
export const BOARD_ISSUE = "board-issue-1";

export function fixture(name) {
  return JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));
}

export function testConfig(overrides = {}) {
  const config = JSON.parse(readFileSync(join(here, "..", "config.example.json"), "utf8"));
  config.stateFile = join(mkdtempSync(join(tmpdir(), "factory-watcher-")), "state.json");
  config.paperclip.boardIssueId = BOARD_ISSUE;
  return { ...config, ...overrides };
}

function withUrl(repo, pr) {
  return { url: `https://github.com/${repo}/pull/${pr.number}`, ...pr };
}

export function createWorld() {
  const apiRepo = "acme/api";
  const web = "acme/web";
  const admin = "acme/admin";
  const issues = fixture("paperclip/issues.json").map((issue) => ({ ...issue }));
  return {
    open: {
      [apiRepo]: fixture("gh/open-prs-api.json").map((pr) => withUrl(apiRepo, pr)),
      [web]: fixture("gh/open-prs-web.json").map((pr) => withUrl(web, pr)),
      [admin]: [],
    },
    merged: {
      [`${apiRepo}|develop`]: fixture("gh/merged-into-develop-api.json").map((pr) => withUrl(apiRepo, pr)),
      [`${apiRepo}|master`]: fixture("gh/merged-into-master-api.json").map((pr) => withUrl(apiRepo, pr)),
    },
    mergedByHead: {},
    feedback: {},
    compare: fixture("gh/compare-api.json"),
    files: {},
    issues,
    comments: {},
    documents: {},
    postedComments: [],
    agents: fixture("paperclip/agents.json"),
    runs: fixture("paperclip/heartbeat-runs.json"),
    commentForbidden: false,
    ghCalls: [],
    httpCalls: [],
    nextIssueNumber: 900,
  };
}

export function fakeGh(world) {
  return async (args) => {
    world.ghCalls.push(args);
    const flag = (name) => args[args.indexOf(name) + 1];
    if (args[0] === "pr" && args[1] === "list") {
      const repo = flag("-R");
      const state = flag("--state");
      if (state === "open") return JSON.stringify(world.open[repo] ?? []);
      if (args.includes("--head")) return JSON.stringify(world.mergedByHead[`${repo}|${flag("--head")}`] ?? []);
      return JSON.stringify(world.merged[`${repo}|${flag("--base")}`] ?? []);
    }
    if (args[0] === "pr" && args[1] === "view") {
      return JSON.stringify({ files: (world.files[`${flag("-R")}#${args[2]}`] ?? []).map((path) => ({ path })) });
    }
    if (args[0] === "api") {
      const path = args[1];
      const feedback = path.match(/^repos\/([^/]+\/[^/]+)\/(issues|pulls)\/(\d+)\/(comments|reviews)/);
      if (feedback) {
        const [, repo, scope, number, kind] = feedback;
        const bucket = world.feedback[`${repo}#${number}`] ?? {};
        const key = kind === "reviews" ? "reviews" : scope === "issues" ? "issueComments" : "reviewComments";
        return JSON.stringify([bucket[key] ?? []]);
      }
      const compare = path.match(/^repos\/([^/]+\/[^/]+)\/compare\/([^.]+)\.\.\.([^?]+)/);
      if (compare) {
        return JSON.stringify({ status: world.compare[`${compare[2]}...${compare[3]}`] ?? "diverged" });
      }
    }
    throw new Error(`fake gh: unexpected call ${args.join(" ")}`);
  };
}

function respond(status, body) {
  const text = body === undefined ? "" : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text, headers: { get: () => null } };
}

export function fakeFetch(world, now) {
  return async (url, init = {}) => {
    const method = init.method ?? "GET";
    const parsed = new URL(url);
    const path = parsed.pathname;
    const params = parsed.searchParams;
    world.httpCalls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
    let match;
    if (method === "GET" && (match = path.match(/^\/api\/companies\/[^/]+\/issues$/))) {
      const projectId = params.get("projectId");
      return respond(200, world.issues.filter((issue) => !projectId || issue.projectId === projectId));
    }
    if (method === "POST" && path === `/api/companies/${COMPANY}/issues`) {
      const body = JSON.parse(init.body);
      world.nextIssueNumber += 1;
      const issue = {
        id: `issue-${world.nextIssueNumber}`,
        identifier: `ACME-${world.nextIssueNumber}`,
        createdAt: now().toISOString(),
        updatedAt: now().toISOString(),
        lastActivityAt: now().toISOString(),
        assigneeUserId: null,
        ...body,
      };
      world.issues.push(issue);
      return respond(201, issue);
    }
    if (method === "GET" && path.endsWith("/agents")) return respond(200, world.agents);
    if (method === "GET" && path.endsWith("/heartbeat-runs")) return respond(200, world.runs);
    if ((match = path.match(/^\/api\/issues\/([^/]+)\/documents\/([^/]+)$/))) {
      const key = `${match[1]}/${match[2]}`;
      if (method === "GET") return world.documents[key] ? respond(200, world.documents[key]) : respond(404, { error: "not found" });
      const body = JSON.parse(init.body);
      const existing = world.documents[key];
      if (existing && body.baseRevisionId !== existing.latestRevisionId) return respond(409, { error: "stale" });
      const revision = (existing?.revision ?? 0) + 1;
      world.documents[key] = { key: match[2], ...body, revision, latestRevisionId: `rev-${revision}` };
      return respond(existing ? 200 : 201, world.documents[key]);
    }
    if ((match = path.match(/^\/api\/issues\/([^/]+)\/comments$/))) {
      if (method === "POST") {
        if (world.commentForbidden) return respond(403, { error: "cross_issue_influence_run_context_required" });
        world.postedComments.push({ issueId: match[1], ...JSON.parse(init.body) });
        return respond(201, { id: `comment-${world.postedComments.length}` });
      }
      let list = [...(world.comments[match[1]] ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const after = params.get("after");
      if (after) {
        list = list.slice(list.findIndex((comment) => comment.id === after));
      }
      if (params.get("order") === "desc") list.reverse();
      if (params.get("limit")) list = list.slice(0, Number(params.get("limit")));
      return respond(200, list);
    }
    if (method === "GET" && (match = path.match(/^\/api\/issues\/([^/]+)$/))) {
      const issue = world.issues.find((candidate) => candidate.id === match[1] || candidate.identifier === match[1]);
      return issue ? respond(200, { ...issue, goal: issue.goalId ? { title: "Goal title" } : null }) : respond(404, {});
    }
    throw new Error(`fake fetch: unexpected ${method} ${path}`);
  };
}

export function tick(world, config, { at, dryRun = false } = {}) {
  const now = new Date(at);
  const lines = [];
  const paperclip = createPaperclip({
    apiUrl: "http://paperclip.test",
    apiKey: "test-key",
    companyId: COMPANY,
    runId: "run-1",
    dryRun,
    fetchImpl: fakeFetch(world, () => now),
  });
  return runTick({
    config,
    github: createGitHub(fakeGh(world)),
    paperclip,
    now,
    dryRun,
    log: (line) => lines.push(line),
  }).then((result) => ({ ...result, lines, paperclip }));
}

export const readState = loadState;
export const writeState = saveState;

export function createdIssues(world) {
  return world.issues.filter((issue) => issue.id.startsWith("issue-"));
}

export function api(world, number) {
  return world.open["acme/api"].find((pr) => pr.number === number);
}
