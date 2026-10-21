import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { summarizeChecks } from "../src/checks.js";
import { classifyAuthor, normalizeGitHubFeedback } from "../src/comments.js";
import { validateConfig } from "../src/config.js";
import { createGitHub } from "../src/github.js";
import { businessDate, isBusinessHours } from "../src/hours.js";
import { findOriginalTask, issueKeyOf } from "../src/linking.js";
import { formatMarker, parseMarkers } from "../src/markers.js";
import { createPaperclip } from "../src/paperclip.js";
import { fixture, testConfig } from "./harness.js";

const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "factory-watcher.js");

test("business hours are Mon-Fri 08:00-18:00 in Bogota", () => {
  const hours = testConfig().businessHours;
  assert.equal(isBusinessHours(new Date("2026-10-20T13:00:00Z"), hours), true);
  assert.equal(isBusinessHours(new Date("2026-10-20T12:59:00Z"), hours), false);
  assert.equal(isBusinessHours(new Date("2026-10-20T22:59:00Z"), hours), true);
  assert.equal(isBusinessHours(new Date("2026-10-20T23:00:00Z"), hours), false);
  assert.equal(isBusinessHours(new Date("2026-10-24T15:00:00Z"), hours), false);
  assert.equal(businessDate(new Date("2026-10-21T03:00:00Z"), hours), "2026-10-20");
});

test("outside business hours the CLI exits 0 before touching any API", () => {
  const config = testConfig();
  config.businessHours.days = [];
  const configPath = join(dirname(config.stateFile), "config.json");
  writeFileSync(configPath, JSON.stringify(config));
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  const result = spawnSync(process.execPath, [bin, "--config", configPath], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /outside business hours/);
});

test("inside business hours the CLI fails loudly when Paperclip env is missing", () => {
  const config = testConfig();
  config.businessHours.days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  config.businessHours.start = "00:00";
  config.businessHours.end = "24:00";
  const configPath = join(dirname(config.stateFile), "config.json");
  writeFileSync(configPath, JSON.stringify(config));
  const result = spawnSync(process.execPath, [bin, "--config", configPath], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PAPERCLIP_API_URL is not set/);
});

test("config validation names the missing fields", () => {
  assert.throws(() => validateConfig({ repos: [] }), /stateFile/);
  const config = testConfig();
  config.stateFile = "relative/state.json";
  assert.throws(() => validateConfig(config), /absolute/);
});

test("markers round-trip and identify one event", () => {
  const marker = formatMarker({ cause: "conflict", repo: "api", pr: 14373, key: "abc" });
  assert.equal(marker, "<!-- factory-watcher:v1 cause=conflict repo=api pr=14373 key=abc -->");
  assert.deepEqual(parseMarkers(`${marker}\n\nbody`), [{ cause: "conflict", repo: "api", pr: "14373", key: "abc" }]);
  assert.deepEqual(parseMarkers("no marker here"), []);
});

test("check rollup: recorded draft PR with skipped Node CI and green Worker CI checks is passing", () => {
  const pr = fixture("gh/open-prs-api.json").find((candidate) => candidate.number === 14327);
  assert.deepEqual(summarizeChecks(pr.statusCheckRollup, testConfig().github.ignoredChecks), {
    conclusion: "passing",
    failing: [],
  });
});

test("check rollup: a failing real check fails, bot checks and stale reruns don't", () => {
  const ignored = testConfig().github.ignoredChecks;
  const rollup = [
    { __typename: "StatusContext", context: "CodeRabbit", state: "FAILURE" },
    { __typename: "CheckRun", workflowName: "Node CI", name: "checks (test:ts)", status: "COMPLETED", conclusion: "FAILURE", completedAt: "2026-10-20T10:00:00Z", detailsUrl: "https://ci/1" },
    { __typename: "CheckRun", workflowName: "Node CI", name: "build (0)", status: "COMPLETED", conclusion: "FAILURE", completedAt: "2026-10-20T09:00:00Z" },
    { __typename: "CheckRun", workflowName: "Node CI", name: "build (0)", status: "COMPLETED", conclusion: "SUCCESS", completedAt: "2026-10-20T11:00:00Z" },
  ];
  assert.deepEqual(summarizeChecks(rollup, ignored), {
    conclusion: "failing",
    failing: [{ name: "Node CI / checks (test:ts)", url: "https://ci/1" }],
  });
  assert.equal(summarizeChecks(rollup.slice(0, 1), ignored).conclusion, "none");
});

test("comment classes on recorded PR feedback: Alex, agent, bot, other human, bot trigger", () => {
  const github = testConfig().github;
  const classes = {};
  for (const key of ["web-8283", "api-14373", "api-14322"]) {
    const items = normalizeGitHubFeedback({
      issueComments: fixture(`gh/${key}-issue-comments.json`),
      reviews: fixture(`gh/${key}-reviews.json`),
      reviewComments: fixture(`gh/${key}-review-comments.json`),
    });
    for (const item of items) classes[item.id] = classifyAuthor(item, github);
  }
  assert.equal(classes["inline:7300001"], "board");
  assert.equal(classes["inline:7300002"], "agent");
  assert.equal(classes["inline:7600002"], "agent");
  assert.equal(classes["review:7500001"], "agent");
  assert.equal(classes["review:7500003"], "agent");
  assert.equal(classes["comment:7100005"], "agent");
  assert.equal(classes["comment:7100002"], "bot");
  assert.equal(classes["review:7800003"], "bot");
  assert.equal(classes["inline:7900002"], "bot");
  assert.equal(classes["review:7200003"], "other-human");
  assert.equal(classes["comment:7400002"], "ignored");
});

test("a factory-agent marker overrides the acme-owner login", () => {
  const github = testConfig().github;
  const item = { login: "acme-owner", userType: "User", body: "<!-- factory-agent:reviewer -->\nLooks fine to me" };
  assert.equal(classifyAuthor(item, github), "agent");
  assert.equal(classifyAuthor({ ...item, body: "Looks fine to me" }, github), "board");
});

test("empty-body reviews are containers and are skipped; CHANGES_REQUESTED is kept", () => {
  const items = normalizeGitHubFeedback({
    issueComments: [],
    reviewComments: [],
    reviews: [
      { id: 1, user: { login: "acme-owner", type: "User" }, body: "", state: "COMMENTED", submitted_at: "2026-10-20T10:00:00Z" },
      { id: 2, user: { login: "acme-owner", type: "User" }, body: "", state: "CHANGES_REQUESTED", submitted_at: "2026-10-20T10:01:00Z" },
    ],
  });
  assert.deepEqual(items.map((item) => item.id), ["review:2"]);
});

test("PRs map to their task by issue-key prefix, skipping watcher-created tasks, else by Paperclip link", () => {
  const issues = fixture("paperclip/issues.json");
  const rework = { ...issues.find((issue) => issue.identifier === "ACME-98"), id: "w", identifier: "ACME-950", description: "<!-- factory-watcher:v1 cause=conflict -->" };
  const pr = fixture("gh/open-prs-api.json").find((candidate) => candidate.number === 14327);
  const pattern = testConfig().issueKeyPattern;
  assert.equal(issueKeyOf(pr.title, pattern), "ENG-4423");
  assert.equal(findOriginalTask(pr, "b0000000-0000-4000-8000-000000000001", [rework, ...issues], pattern).issue.identifier, "ACME-98");
  const linked = { title: "No prefix", body: "Paperclip: http://127.0.0.1:3100/ACME/issues/ACME-17" };
  assert.deepEqual(
    [findOriginalTask(linked, null, issues, pattern).issue.identifier, findOriginalTask(linked, null, issues, pattern).via],
    ["ACME-17", "body-link"],
  );
  assert.equal(findOriginalTask({ title: "x", body: "" }, null, issues, pattern).issue, null);
  assert.equal(issueKeyOf(pr.title, null), null);
});

test("gh wrapper asks GitHub for factory heads only and flattens paginated pages", async () => {
  const calls = [];
  const github = createGitHub(async (args) => {
    calls.push(args);
    return args[0] === "api" ? JSON.stringify([[{ id: 1 }], [{ id: 2 }]]) : "[]";
  });
  await github.listOpenPullRequests("acme/api", "factory/");
  assert.ok(calls[0].includes("head:factory/"));
  assert.deepEqual(await github.listIssueComments("acme/api", 1), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(calls[1].slice(2), ["--paginate", "--slurp"]);
});

test("Paperclip client: dry run never sends writes; 429 is retried; errors don't carry the key", async () => {
  const sent = [];
  let first = true;
  const fetchImpl = async (url, init) => {
    sent.push({ url, method: init.method });
    if (first) {
      first = false;
      return { ok: false, status: 429, text: async () => "", headers: { get: () => "0" } };
    }
    return { ok: false, status: 500, text: async () => '{"error":"boom"}', headers: { get: () => null } };
  };
  const dry = createPaperclip({ apiUrl: "http://p", apiKey: "secret-key", companyId: "c", dryRun: true, fetchImpl, sleep: async () => {} });
  await dry.createIssue({ title: "x" });
  await dry.putDocument("i", "board", { body: "b" });
  await dry.addComment("i", "hello");
  assert.equal(sent.length, 0);
  assert.equal(dry.plannedWrites.length, 3);
  const error = await dry.listIssues().catch((caught) => caught);
  assert.equal(sent.length, 2);
  assert.match(error.message, /returned 500/);
  assert.doesNotMatch(error.message, /secret-key/);
});
