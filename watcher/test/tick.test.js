import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { beforeEach, describe, test } from "node:test";
import { parseMarkers } from "../src/markers.js";
import { BOARD_ISSUE, createWorld, createdIssues, readState, api, testConfig, tick, writeState } from "./harness.js";

const T0 = "2026-10-20T15:00:00Z";
const T1 = "2026-10-20T15:10:00Z";
const T2 = "2026-10-20T15:20:00Z";
const T3 = "2026-10-20T15:30:00Z";
const DEVELOPER = "a0000000-0000-4000-8000-000000000001";
const REVIEWER = "a0000000-0000-4000-8000-000000000002";
const SERVER_PROJECT = "b0000000-0000-4000-8000-000000000001";
const ADMIN_PROJECT = "b0000000-0000-4000-8000-000000000003";

let world;
let config;

beforeEach(async () => {
  world = createWorld();
  config = testConfig();
  await tick(world, config, { at: T0 });
});

function causes() {
  return createdIssues(world).map((issue) => parseMarkers(issue.description)[0].cause);
}

function ownerComment(id, body, createdAt) {
  return { id, user: { login: "acme-owner", type: "User" }, body, created_at: createdAt, html_url: `https://github.com/c/${id}` };
}

describe("baseline", () => {
  test("the first tick records state, opens nothing, and seeds the ledger", async () => {
    assert.deepEqual(createdIssues(world), []);
    const state = await readState(config.stateFile);
    assert.equal(Object.keys(state.prs).length, 5);
    assert.ok(state.prs["api#14331"].seenKeys.includes(`conflict:${api(world, 14331).headRefOid}`));
    assert.ok(state.ledger["api#14374"]);
  });
});

describe("section A causes", () => {
  test("conflict: MERGEABLE → CONFLICTING opens one Developer task with the review policy", async () => {
    const pr = api(world, 14327);
    pr.mergeable = "CONFLICTING";
    await tick(world, config, { at: T1 });
    const [issue] = createdIssues(world);
    assert.equal(issue.title, "[ENG-4423] Resolve conflict: api#14327");
    assert.equal(issue.assigneeAgentId, DEVELOPER);
    assert.equal(issue.projectId, SERVER_PROJECT);
    assert.equal(issue.status, "todo");
    assert.deepEqual(issue.executionPolicy, {
      mode: "normal",
      commentRequired: true,
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: REVIEWER }] },
        { type: "approval", participants: [{ type: "user", userId: "local-board" }] },
      ],
    });
    assert.match(issue.description, /^<!-- factory-watcher:v1 cause=conflict repo=api pr=14327 key=43d5602b/);
    assert.match(issue.description, /Original task: ACME-98/);
    assert.match(issue.description, /old and new head SHAs/);
    assert.equal(issue.idempotencyKey, `factory-watcher:v1:conflict|api|14327|-|${pr.headRefOid}`);
  });

  test("conflict: UNKNOWN is not yet known and opens nothing", async () => {
    api(world, 14327).mergeable = "UNKNOWN";
    await tick(world, config, { at: T1 });
    assert.deepEqual(createdIssues(world), []);
  });

  test("a stacked PR's conflict task says to fix it against the parent branch", async () => {
    const pr = api(world, 14300);
    pr.mergeable = "CONFLICTING";
    await tick(world, config, { at: T1 });
    assert.match(createdIssues(world)[0].description, /stacked on `factory\/ACME-22-.*`\. Fix it against that parent branch/);
  });

  test("ci-failed: a failing real check on a new head opens a task; the same head doesn't again", async () => {
    const pr = api(world, 14327);
    pr.headRefOid = "1111111111111111111111111111111111111111";
    pr.statusCheckRollup = [
      ...pr.statusCheckRollup,
      { __typename: "CheckRun", workflowName: "Node CI", name: "checks (test:ts)", status: "COMPLETED", conclusion: "FAILURE", completedAt: T1, detailsUrl: "https://ci/run/1" },
    ];
    pr.updatedAt = T1;
    await tick(world, config, { at: T1 });
    assert.deepEqual(causes(), ["ci-failed"]);
    assert.match(createdIssues(world)[0].description, /\[Node CI \/ checks \(test:ts\)\]\(https:\/\/ci\/run\/1\)/);
    await tick(world, config, { at: T2 });
    assert.equal(createdIssues(world).length, 1);
  });

  test("ci-failed: a failing bot check (CodeRabbit, Vercel) opens nothing", async () => {
    const pr = api(world, 14327);
    pr.statusCheckRollup = [...pr.statusCheckRollup, { __typename: "StatusContext", context: "CodeRabbit", state: "FAILURE" }];
    await tick(world, config, { at: T1 });
    assert.deepEqual(createdIssues(world), []);
  });

  test("parent-merged: the parent PR merges and GitHub retargets the child to develop", async () => {
    const child = api(world, 14300);
    const parent = api(world, 14299);
    const parentBranch = child.baseRefName;
    assert.equal(parent.headRefName, parentBranch);
    world.open["acme/api"] = world.open["acme/api"].filter((pr) => pr.number !== 14299);
    world.mergedByHead[`acme/api|${parentBranch}`] = [
      { number: 14299, url: "https://github.com/acme/api/pull/14299", mergedAt: T1, headRefName: parentBranch },
    ];
    child.baseRefName = "develop";
    await tick(world, config, { at: T1 });
    const [issue] = createdIssues(world);
    assert.equal(issue.title, "[ENG-4392] Rebase after parent merged: api#14300");
    assert.match(issue.description, /key=14299/);
    assert.match(issue.description, /drop the parent's original commits/);
    assert.match(issue.description, /Remove the "Stacked on" line/);
    await tick(world, config, { at: T2 });
    assert.equal(createdIssues(world).length, 1);
  });

  test("behind-at-approval: admin (up to date required) BEHIND while its task waits on Alex's approval; api BEHIND opens nothing", async () => {
    world.issues.push({
      id: "admin-task",
      identifier: "ACME-300",
      title: "[ENG-5000] Admin change",
      description: "",
      status: "in_review",
      projectId: ADMIN_PROJECT,
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      lastActivityAt: T0,
      createdAt: T0,
    });
    const adminPr = {
      ...api(world, 14327),
      number: 2800,
      title: "[ENG-5000] Admin change",
      url: "https://github.com/acme/admin/pull/2800",
      headRefName: "factory/ACME-300-admin",
      mergeStateStatus: "CLEAN",
    };
    world.open["acme/admin"] = [adminPr];
    await tick(world, config, { at: T1 });
    adminPr.mergeStateStatus = "BEHIND";
    api(world, 14327).mergeStateStatus = "BEHIND";
    await tick(world, config, { at: T2 });
    assert.deepEqual(createdIssues(world).map((issue) => issue.title), ["[ENG-5000] Rebase before approval: admin#2800"]);
    assert.equal(createdIssues(world)[0].projectId, ADMIN_PROJECT);
  });
});

describe("section B: comments from Alex", () => {
  test("GitHub: Alex's comments in one tick become one rework task with his words verbatim", async () => {
    const pr = api(world, 14327);
    world.feedback["acme/api#14327"] = {
      issueComments: [
        ownerComment(9001, "Can we drop the second retry?\nIt doubles the latency.", "2026-10-20T15:05:00Z"),
        ownerComment(9002, "Also rename `foo`.", "2026-10-20T15:06:00Z"),
      ],
    };
    pr.updatedAt = "2026-10-20T15:06:00Z";
    await tick(world, config, { at: T1 });
    const [issue] = createdIssues(world);
    assert.equal(createdIssues(world).length, 1);
    assert.equal(issue.title, "[ENG-4423] Rework from Alex's comments: api#14327");
    assert.match(issue.description, /> Can we drop the second retry\?\n> It doubles the latency\./);
    assert.match(issue.description, /> Also rename `foo`\./);
    assert.match(issue.description, /https:\/\/github.com\/c\/9001/);
    assert.match(issue.description, /answer it in this task and don't change code/);
    await tick(world, config, { at: T2 });
    assert.equal(createdIssues(world).length, 1);
  });

  test("GitHub: bot, other-human, agent-marked and bot-trigger comments open nothing; other humans go on the board", async () => {
    const pr = api(world, 14327);
    world.feedback["acme/api#14327"] = {
      issueComments: [
        { id: 1, user: { login: "coderabbitai[bot]", type: "Bot" }, body: "Walkthrough", created_at: T1 },
        { id: 2, user: { login: "teammate-1", type: "User" }, body: "Why this approach?", created_at: T1, html_url: "https://github.com/c/2" },
        ownerComment(3, "<!-- factory-agent:reviewer -->\nReviewer pass at abc", T1),
        ownerComment(4, "@claude @codex review this", T1),
      ],
    };
    pr.updatedAt = T1;
    const result = await tick(world, config, { at: T1 });
    assert.deepEqual(createdIssues(world), []);
    assert.match(result.boardMarkdown, /## Comments by other people \(1\)\n- api#14327: \[teammate-1\]\(https:\/\/github.com\/c\/2\)/);
  });

  test("GitHub: a new comment while the rework task is still open waits for it to close", async () => {
    const pr = api(world, 14327);
    world.feedback["acme/api#14327"] = { issueComments: [ownerComment(9001, "First", T1)] };
    pr.updatedAt = T1;
    await tick(world, config, { at: T1 });
    world.feedback["acme/api#14327"].issueComments.push(ownerComment(9003, "Second", T2));
    pr.updatedAt = T2;
    const deferred = await tick(world, config, { at: T2 });
    assert.equal(createdIssues(world).length, 1);
    assert.equal(deferred.report.deferred.length, 1);
    createdIssues(world)[0].status = "done";
    await tick(world, config, { at: T3 });
    assert.equal(createdIssues(world).length, 2);
    assert.match(createdIssues(world)[1].description, /> Second/);
    assert.doesNotMatch(createdIssues(world)[1].description, /> First/);
  });

  test("Paperclip: a local-board comment on a done task opens rework; approvals and agent-held tasks don't", async () => {
    const done = world.issues.find((issue) => issue.identifier === "ACME-17");
    const agentHeld = world.issues.find((issue) => issue.identifier === "ACME-182");
    world.comments[done.id] = [{ id: "c-old", authorType: "user", authorUserId: "local-board", body: "approved", createdAt: "2026-10-16T22:39:21Z" }];
    await tick(world, config, { at: T1 });
    world.comments[done.id].push(
      { id: "c-approve", authorType: "user", authorUserId: "local-board", body: "Approved by me&#x20;", createdAt: "2026-10-20T15:11:00Z" },
      { id: "c-new", authorType: "user", authorUserId: "local-board", body: "The footer is still in English.", createdAt: "2026-10-20T15:12:00Z" },
      { id: "c-agent", authorType: "agent", authorAgentId: DEVELOPER, body: "Done.", createdAt: "2026-10-20T15:13:00Z" },
    );
    done.lastActivityAt = "2026-10-20T15:13:00Z";
    world.comments[agentHeld.id] = [{ id: "c-held", authorType: "user", authorUserId: "local-board", body: "Fix this", createdAt: T1 }];
    agentHeld.lastActivityAt = T1;
    await tick(world, config, { at: T2 });
    const issues = createdIssues(world);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].title, "[ENG-4380] Rework from Alex's comments: ACME-17");
    assert.match(issues[0].description, /> The footer is still in English\./);
    assert.doesNotMatch(issues[0].description, /Approved by me/);
    assert.match(issues[0].description, /cause=board-comment repo=web task=ACME-17 key=c-new/);
  });

  test("Paperclip: the comment the cursor points at is not read again (the live after= is inclusive)", async () => {
    const done = world.issues.find((issue) => issue.identifier === "ACME-17");
    await rm(config.stateFile);
    world.comments[done.id] = [
      { id: "c-question", authorType: "user", authorUserId: "local-board", body: "Why is the footer in English?", createdAt: "2026-10-16T22:39:21Z" },
    ];
    done.lastActivityAt = "2026-10-16T22:39:21Z";
    await tick(world, config, { at: T0 });
    world.comments[done.id].push({ id: "c-approve", authorType: "user", authorUserId: "local-board", body: "approved", createdAt: T1 });
    done.lastActivityAt = T1;
    await tick(world, config, { at: T1 });
    assert.deepEqual(createdIssues(world), []);
    world.comments[done.id].push({ id: "c-agent", authorType: "agent", authorAgentId: DEVELOPER, body: "Merged.", createdAt: T2 });
    done.lastActivityAt = T2;
    await tick(world, config, { at: T2 });
    assert.deepEqual(createdIssues(world), []);
  });

  test("Paperclip: a comment while the rework task is still open waits for it to close", async () => {
    const done = world.issues.find((issue) => issue.identifier === "ACME-17");
    world.comments[done.id] = [{ id: "c-a", authorType: "user", authorUserId: "local-board", body: "First", createdAt: T1 }];
    done.lastActivityAt = T1;
    await tick(world, config, { at: T1 });
    assert.equal(createdIssues(world).length, 1);
    world.comments[done.id].push({ id: "c-b", authorType: "user", authorUserId: "local-board", body: "Second", createdAt: T2 });
    done.lastActivityAt = T2;
    const deferred = await tick(world, config, { at: T2 });
    assert.equal(createdIssues(world).length, 1);
    assert.equal(deferred.report.deferred.length, 1);
    await tick(world, config, { at: T3 });
    assert.equal(createdIssues(world).length, 1);
    createdIssues(world)[0].status = "done";
    await tick(world, config, { at: "2026-10-20T15:40:00Z" });
    await tick(world, config, { at: "2026-10-20T15:50:00Z" });
    const issues = createdIssues(world);
    assert.equal(issues.length, 2);
    assert.match(issues[1].description, /> Second/);
    assert.doesNotMatch(issues[1].description, /> First/);
    assert.match(issues[1].description, /task=ACME-17 key=c-b/);
  });

  test("GitHub: acme-owner comments read as agent by phrase are listed on the board; marked ones are not", async () => {
    const pr = api(world, 14327);
    world.feedback["acme/api#14327"] = {
      issueComments: [
        ownerComment(9101, "QA missed this: the banner still shows.", T1),
        ownerComment(9102, "<!-- factory-agent:reviewer -->\nReviewer pass: fine.", T1),
      ],
    };
    pr.updatedAt = T1;
    const result = await tick(world, config, { at: T1 });
    assert.deepEqual(createdIssues(world), []);
    assert.match(
      result.boardMarkdown,
      /## acme-owner comments read as agent \(1\)\n- api#14327: \[QA missed this: the banner still shows\.\]\(https:\/\/github.com\/c\/9101\)/,
    );
  });
});

describe("de-duplication", () => {
  test("the same event seen twice opens one task", async () => {
    api(world, 14327).mergeable = "CONFLICTING";
    await tick(world, config, { at: T1 });
    await tick(world, config, { at: T2 });
    assert.equal(createdIssues(world).length, 1);
  });

  test("state saved before the task was created (crash after create): the open Paperclip marker prevents a duplicate", async () => {
    const before = await readState(config.stateFile);
    api(world, 14327).mergeable = "CONFLICTING";
    await tick(world, config, { at: T1 });
    await writeState(config.stateFile, before);
    const result = await tick(world, config, { at: T2 });
    assert.equal(createdIssues(world).length, 1);
    assert.match(result.report.skipped[0], /already ACME-901/);
  });

  test("lost state file: the next tick is a new baseline and opens nothing, then events resume", async () => {
    api(world, 14327).mergeable = "CONFLICTING";
    await tick(world, config, { at: T1 });
    await rm(config.stateFile);
    const rebaseline = await tick(world, config, { at: T2 });
    assert.match(rebaseline.lines[0], /baseline/);
    await tick(world, config, { at: T3 });
    assert.equal(createdIssues(world).length, 1);
    api(world, 14300).mergeable = "CONFLICTING";
    await tick(world, config, { at: "2026-10-20T15:40:00Z" });
    assert.equal(createdIssues(world).length, 2);
  });

  test("one open task per PR and cause: a conflict on a new head while the first task is open is skipped", async () => {
    const pr = api(world, 14327);
    pr.mergeable = "CONFLICTING";
    await tick(world, config, { at: T1 });
    pr.headRefOid = "2222222222222222222222222222222222222222";
    await tick(world, config, { at: T2 });
    assert.equal(createdIssues(world).length, 1);
  });

  test("dry run reads live but writes nothing and leaves the state file alone", async () => {
    const before = await readState(config.stateFile);
    api(world, 14327).mergeable = "CONFLICTING";
    const result = await tick(world, config, { at: T1, dryRun: true });
    assert.deepEqual(createdIssues(world), []);
    assert.equal(world.httpCalls.filter((call) => call.method !== "GET").length, 2);
    assert.deepEqual(await readState(config.stateFile), before);
    assert.equal(result.paperclip.plannedWrites[0].body.title, "[ENG-4423] Resolve conflict: api#14327");
    assert.ok(result.lines.some((line) => line.includes("tasks that would be created: 1")));
  });
});

describe("section C: shipped ledger", () => {
  test("deploy match: #14374 is in prod via Deploy #14394; #14395 merged after the 20:01 deploy is not", async () => {
    const result = await tick(createWorld(), testConfig(), { at: "2026-10-20T21:00:00Z" });
    const ledger = result.state.ledger;
    assert.equal(ledger["api#14374"].deploy.number, 14394);
    assert.equal(ledger["api#14395"].deploy, null);
    assert.deepEqual(ledger["api#14395"].deployChecked, []);
    assert.deepEqual(ledger["api#14374"].deployChecked, []);
    assert.match(result.ledgerMarkdown, /api#14395.*\| not yet \|/);
    assert.match(result.ledgerMarkdown, /\[Deploy #14394\]/);
  });

  test("a repo with no deploy signal shows deploy: unknown instead of not yet", async () => {
    const unknownConfig = testConfig();
    unknownConfig.repos.find((repo) => repo.name === "api").deploy = { type: "unknown" };
    const result = await tick(createWorld(), unknownConfig, { at: "2026-10-20T21:00:00Z" });
    assert.equal(result.state.ledger["api#14374"].deploy, null);
    assert.match(result.ledgerMarkdown, /api#14374.*\| deploy: unknown \|/);
    assert.doesNotMatch(result.ledgerMarkdown, /api#\d+.*\| not yet \|/);
  });

  test("ship check +1 h opens an On Call task once, reads Result: RED and opens a Developer fix task", async () => {
    const deployCommit = "dddd000000000000000000000000000000000000";
    world.merged["acme/api|develop"].push({
      number: 14400,
      title: "[ENG-4460] New thing",
      url: "https://github.com/acme/api/pull/14400",
      headRefName: "factory/ACME-400-new",
      baseRefName: "develop",
      mergedAt: "2026-10-20T15:05:00Z",
      mergeCommit: { oid: "aaaa000000000000000000000000000000000000" },
    });
    world.merged["acme/api|master"].push({
      number: 14401,
      title: "Deploy",
      url: "https://github.com/acme/api/pull/14401",
      headRefName: "develop",
      baseRefName: "master",
      mergedAt: "2026-10-20T15:15:00Z",
      mergeCommit: { oid: deployCommit },
    });
    world.compare[`aaaa000000000000000000000000000000000000...${deployCommit}`] = "ahead";
    await tick(world, config, { at: "2026-10-20T15:20:00Z" });
    assert.equal(createdIssues(world).length, 0);
    await tick(world, config, { at: "2026-10-20T16:20:00Z" });
    const [onCall] = createdIssues(world);
    assert.equal(onCall.title, "[ENG-4460] Ship check +1 h: api#14400");
    assert.equal(onCall.assigneeAgentId, "a0000000-0000-4000-8000-000000000004");
    assert.equal(onCall.projectId, "b0000000-0000-4000-8000-000000000004");
    assert.match(onCall.description, /Result: GREEN` or `Result: RED – <reason>`/);
    await tick(world, config, { at: "2026-10-20T16:30:00Z" });
    assert.equal(createdIssues(world).length, 1);

    world.comments[onCall.id] = [
      { id: "oc-1", authorType: "agent", body: "The error tracker shows a new TypeError.\n\nResult: RED – new TypeError in chat handler", createdAt: "2026-10-20T16:35:00Z" },
    ];
    onCall.lastActivityAt = "2026-10-20T16:35:00Z";
    const result = await tick(world, config, { at: "2026-10-20T16:40:00Z" });
    const fix = createdIssues(world)[1];
    assert.equal(fix.title, "[ENG-4460] Fix after RED ship check: api#14400");
    assert.equal(fix.assigneeAgentId, DEVELOPER);
    assert.equal(fix.projectId, SERVER_PROJECT);
    assert.match(result.ledgerMarkdown, /RED: new TypeError in chat handler/);
  });

  test("KR +7 days opens a Head of Product task in Discovery & Planning with the goal", async () => {
    const deployCommit = "5555000000000000000000000000000000000000";
    world.merged["acme/api|develop"].push({
      number: 14402,
      title: "[ENG-4461] KR thing",
      url: "https://github.com/acme/api/pull/14402",
      headRefName: "factory/ACME-402",
      baseRefName: "develop",
      mergedAt: "2026-10-20T15:01:00Z",
      mergeCommit: { oid: "bbbb000000000000000000000000000000000000" },
    });
    world.merged["acme/api|master"].push({
      number: 14403, title: "Deploy", url: "https://github.com/acme/api/pull/14403", headRefName: "develop",
      baseRefName: "master", mergedAt: "2026-10-20T15:02:00Z", mergeCommit: { oid: deployCommit },
    });
    world.compare[`bbbb000000000000000000000000000000000000...${deployCommit}`] = "ahead";
    await tick(world, config, { at: "2026-10-27T15:05:00Z" });
    const kr = createdIssues(world).find((issue) => issue.title.includes("KR check +7 days"));
    assert.equal(kr.assigneeAgentId, "a0000000-0000-4000-8000-000000000005");
    assert.equal(kr.projectId, "b0000000-0000-4000-8000-000000000005");
    assert.match(kr.description, /Issue key: ENG-4461/);
  });
});

describe("section D: board and daily summary", () => {
  test("board shows the Alex count, needs-Alex, stuck and broken lists and a row per open task", async () => {
    const state = await readState(config.stateFile);
    const board = world.documents[`${BOARD_ISSUE}/board`].body;
    assert.match(board, /\*\*PRs waiting on Alex: 1 of 5\*\*/);
    assert.match(board, /## Needs Alex \(3\)/);
    assert.match(board, /ACME-99 \(ENG-4424\).*\[api#14331\].*conflict/);
    assert.match(board, /## Broken \(\d+\)\n- \[api#14331\].*merge conflict \(ACME-99\)/);
    assert.match(board, /failed run.*: Reviewer/);
    assert.match(board, /\| ACME-98 .* \| ENG-4423 \| \[api#14327\].* \| in_review \| Reviewer \|/);
    assert.match(board, /Stuck > 24 h/);
    assert.ok(state.board.writtenAt);
  });

  test("over cap is called out when more than five PRs wait on Alex", async () => {
    for (const number of [14327, 14300, 14299]) {
      const pr = api(world, number);
      const task = world.issues.find((issue) => issue.title.startsWith(pr.title.slice(0, 10)));
      if (task) Object.assign(task, { status: "in_review", assigneeAgentId: null, assigneeUserId: "local-board" });
    }
    for (let n = 0; n < 4; n += 1) {
      world.issues.push({ id: `extra-${n}`, identifier: `ACME-80${n}`, title: `[ENG-90${n}] Extra`, description: "", status: "in_review", projectId: SERVER_PROJECT, assigneeAgentId: null, assigneeUserId: "local-board", lastActivityAt: T0, createdAt: T0 });
      world.open["acme/api"].push({ ...api(world, 14327), number: 15000 + n, title: `[ENG-90${n}] Extra`, url: `https://github.com/acme/api/pull/${15000 + n}` });
    }
    const result = await tick(world, config, { at: "2026-10-20T16:30:00Z" });
    assert.match(result.boardMarkdown, /PRs waiting on Alex: \d+ of 5 \(over cap\)/);
  });

  test("the board is rewritten at most once an hour", async () => {
    const first = world.documents[`${BOARD_ISSUE}/board`].revision;
    await tick(world, config, { at: T1 });
    assert.equal(world.documents[`${BOARD_ISSUE}/board`].revision, first);
    await tick(world, config, { at: "2026-10-20T16:01:00Z" });
    assert.equal(world.documents[`${BOARD_ISSUE}/board`].revision, first + 1);
  });

  test("daily summary: one comment on the first tick of the next business day, with what moved", async () => {
    await tick(world, config, { at: T1 });
    assert.equal(world.postedComments.length, 0);
    world.issues.find((issue) => issue.identifier === "ACME-98").status = "done";
    await tick(world, config, { at: "2026-10-21T13:05:00Z" });
    await tick(world, config, { at: "2026-10-21T13:15:00Z" });
    assert.equal(world.postedComments.length, 1);
    assert.equal(world.postedComments[0].issueId, BOARD_ISSUE);
    assert.match(world.postedComments[0].body, /## Daily summary, 2026-10-21/);
    assert.match(world.postedComments[0].body, /ACME-98 .*: in_review → done/);
  });

  test("daily summary falls back to a document when the run can't comment", async () => {
    world.commentForbidden = true;
    const result = await tick(world, config, { at: "2026-10-21T13:05:00Z" });
    assert.match(world.documents[`${BOARD_ISSUE}/daily-summary`].body, /Daily summary, 2026-10-21/);
    assert.ok(result.report.notes.some((note) => note.includes("wrote document daily-summary")));
  });
});

describe("any repo, not only the example ones", () => {
  test("a different base branch, issue-key pattern, branch prefix, board name and deploy label drive tasks, board and ledger", async () => {
    const other = createWorld();
    const project = "b0000000-0000-4000-8000-0000000000f1";
    const github = "example/widgets";
    const otherConfig = testConfig({
      issueKeyPattern: "WID-\\d+",
      repos: [
        {
          name: "widgets",
          displayName: "wdg",
          github,
          projectId: project,
          baseBranch: "main",
          deploy: { type: "deploy-pr", base: "production", head: "main", titlePattern: "^Release\\b", label: "Release" },
        },
      ],
    });
    otherConfig.github = { ...otherConfig.github, factoryBranchPrefix: "bot/" };
    otherConfig.paperclip = { ...otherConfig.paperclip, boardUserName: "Sam" };
    const base = { isDraft: true, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", statusCheckRollup: [], body: "", createdAt: T0, updatedAt: T0 };
    const parent = { ...base, number: 7, title: "[WID-7] Parent change", url: `https://github.com/${github}/pull/7`, headRefName: "bot/wid-7-parent", baseRefName: "main", headRefOid: "7".repeat(40) };
    const child = { ...base, number: 8, title: "[WID-8] Child change", url: `https://github.com/${github}/pull/8`, headRefName: "bot/wid-8-child", baseRefName: "bot/wid-7-parent", headRefOid: "8".repeat(40) };
    const unrelated = { ...base, number: 9, title: "[WID-9] Not the factory's", url: `https://github.com/${github}/pull/9`, headRefName: "factory/wid-9", baseRefName: "main", headRefOid: "9".repeat(40), mergeable: "CONFLICTING" };
    other.open = { [github]: [parent, child, unrelated] };
    other.merged = {
      [`${github}|main`]: [
        { number: 5, title: "[WID-5] Shipped change", url: `https://github.com/${github}/pull/5`, headRefName: "bot/wid-5", baseRefName: "main", mergedAt: "2026-10-20T14:00:00Z", mergeCommit: { oid: "5".repeat(40) } },
      ],
      [`${github}|production`]: [
        { number: 6, title: "Release 2026-10-20", url: `https://github.com/${github}/pull/6`, headRefName: "main", baseRefName: "production", mergedAt: "2026-10-20T14:30:00Z", mergeCommit: { oid: "6".repeat(40) } },
      ],
    };
    other.compare = { [`${"5".repeat(40)}...${"6".repeat(40)}`]: "ahead" };
    const task = (id, identifier, title, extra = {}) => ({
      id, identifier, title, description: "", status: "in_progress", projectId: project, assigneeAgentId: DEVELOPER, assigneeUserId: null, lastActivityAt: T0, createdAt: T0, ...extra,
    });
    other.issues = [
      task("wid-7", "WID-T7", "[WID-7] Parent change", { status: "in_review", assigneeAgentId: null, assigneeUserId: "local-board" }),
      task("wid-8", "WID-T8", "[WID-8] Child change"),
    ];

    const baselineRun = await tick(other, otherConfig, { at: T0 });
    assert.deepEqual(Object.keys(baselineRun.state.prs).sort(), ["widgets#7", "widgets#8"]);
    assert.ok(other.ghCalls.some((args) => args.includes("head:bot/")));
    assert.match(baselineRun.ledgerMarkdown, /\[widgets#5\].*\| \[Release #6\]\(https:\/\/github.com\/example\/widgets\/pull\/6\)/);
    assert.match(baselineRun.boardMarkdown, /\*\*PRs waiting on Sam: 1 of 5\*\*/);
    assert.match(baselineRun.boardMarkdown, /WID-T7 \(WID-7\) Parent change: \[wdg#7\]/);
    assert.match(baselineRun.boardMarkdown, /\| WID-T7 Parent change \| WID-7 \| \[wdg#7\].* \| Sam: approve, or comment to send it back \|/);

    parent.mergeable = "CONFLICTING";
    child.mergeable = "CONFLICTING";
    await tick(other, otherConfig, { at: T1 });
    const [parentConflict, childConflict] = createdIssues(other);
    assert.equal(parentConflict.title, "[WID-7] Resolve conflict: widgets#7");
    assert.equal(parentConflict.projectId, project);
    assert.match(parentConflict.description, /Rebase onto \(or merge\) `main`/);
    assert.match(parentConflict.description, /Original task: WID-T7/);
    assert.equal(childConflict.title, "[WID-8] Resolve conflict: widgets#8");
    assert.match(childConflict.description, /stacked on `bot\/wid-7-parent`\. Fix it against that parent branch, not `main`\./);
    assert.equal(createdIssues(other).length, 2);

    other.open[github] = [child, unrelated];
    other.mergedByHead[`${github}|bot/wid-7-parent`] = [{ number: 7, url: parent.url, mergedAt: T2, headRefName: "bot/wid-7-parent" }];
    child.baseRefName = "main";
    await tick(other, otherConfig, { at: T2 });
    const rebase = createdIssues(other)[2];
    assert.equal(rebase.title, "[WID-8] Rebase after parent merged: widgets#8");
    assert.match(rebase.description, /Rebase onto `main` .*git rebase --onto origin\/main/);
    assert.match(rebase.description, /retarget it to `main`/);
  });
});
