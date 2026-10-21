import { conditionKeys, parentBranchToCheck, snapshotPullRequest, splitFeedback } from "./babysit.js";
import { renderBoard, renderDailySummary, renderLedger, workItemStage } from "./board.js";
import { isAgentMarked, normalizeGitHubFeedback } from "./comments.js";
import { deployPullRequests, matchDeploy } from "./deploys.js";
import { businessDate } from "./hours.js";
import { findOriginalTask, issueKeyOf } from "./linking.js";
import { eventOf, parseMarkers, subjectOf } from "./markers.js";
import { PaperclipError } from "./paperclip.js";
import { emptyState, loadState, saveState } from "./state.js";
import * as templates from "./tasks.js";

const CLOSED = new Set(["done", "cancelled"]);
const HOUR = 60 * 60 * 1000;
const SHIP_CHECKS = [
  { cause: "ship-check-1h", offset: HOUR, hours: 1, owner: "onCall" },
  { cause: "ship-check-24h", offset: 24 * HOUR, hours: 24, owner: "onCall" },
  { cause: "kr-7d", offset: 7 * 24 * HOUR, days: 7, owner: "headOfProduct" },
  { cause: "kr-30d", offset: 30 * 24 * HOUR, days: 30, owner: "headOfProduct" },
];
const RESULT_LINE = /^\s*`?Result:\s*(GREEN|RED)\b\s*(?:[–—-]\s*(.*?))?`?\s*$/im;

function excerptOf(body) {
  return (body ?? "").replace(/<!--[\s\S]*?-->/g, "").replace(/[[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
}

function prId(repo, number) {
  return `${repo}#${number}`;
}

function reviewPolicy(config) {
  return {
    mode: "normal",
    commentRequired: true,
    stages: [
      { type: "review", participants: [{ type: "agent", agentId: config.paperclip.agents.reviewer }] },
      { type: "approval", participants: [{ type: "user", userId: config.paperclip.boardUserId }] },
    ],
  };
}

function isApprovalComment(body, config) {
  const text = (body ?? "").replace(/&#x20;/g, " ").trim();
  return !text || config.paperclip.approvalPatterns.some((pattern) => new RegExp(pattern, "i").test(text));
}

async function listAll(paperclip, projectIds) {
  const lists = await Promise.all(projectIds.map((projectId) => paperclip.listIssues({ projectId })));
  return lists.flat();
}

export async function runTick({ config, github, paperclip, now, dryRun, log, load = loadState, save = saveState }) {
  const previous = await load(config.stateFile);
  const baseline = !previous;
  const state = previous ? structuredClone(previous) : emptyState(now);
  const lastTickAt = previous?.lastTickAt ?? null;
  const report = { created: [], skipped: [], deferred: [], notes: [] };
  const persistMarkers = async () => {
    if (!dryRun && !baseline) await save(config.stateFile, { ...(previous ?? state), markers: state.markers });
  };

  const codeProjectIds = config.repos.map((repo) => repo.projectId);
  const [codeIssues, monitoringIssues, discoveryIssues, agents, runs] = await Promise.all([
    listAll(paperclip, codeProjectIds),
    paperclip.listIssues({ projectId: config.paperclip.projects.productionMonitoring }),
    paperclip.listIssues({ projectId: config.paperclip.projects.discovery }),
    paperclip.listAgents(),
    paperclip.listHeartbeatRuns(),
  ]);
  const allIssues = [...codeIssues, ...monitoringIssues, ...discoveryIssues];
  const openBySubject = new Map();
  const openByEvent = new Map();
  for (const issue of allIssues) {
    if (CLOSED.has(issue.status)) continue;
    for (const fields of parseMarkers(issue.description)) {
      openBySubject.set(subjectOf(fields), issue);
      openByEvent.set(eventOf(fields), issue);
    }
  }
  const agentsById = new Map((Array.isArray(agents) ? agents : agents.items ?? []).map((agent) => [agent.id, agent]));
  const issueById = new Map(allIssues.map((issue) => [issue.id, issue]));

  const events = [];
  const openPrs = [];
  const nextPrs = {};

  for (const repo of config.repos) {
    const prs = (await github.listOpenPullRequests(repo.github, config.github.factoryBranchPrefix)).filter((pr) =>
      pr.headRefName.startsWith(config.github.factoryBranchPrefix),
    );
    const openHeads = new Set(prs.map((pr) => pr.headRefName));
    for (const pr of prs) {
      const id = prId(repo.name, pr.number);
      const before = state.prs[id];
      const snapshot = snapshotPullRequest(pr, repo, config);
      const { issue: original, via } = findOriginalTask(pr, repo.projectId, codeIssues, config.issueKeyPattern);
      snapshot.originalId = original?.id ?? null;
      snapshot.originalIdentifier = original?.identifier ?? null;
      snapshot.linkedVia = via;
      snapshot.issueKey = issueKeyOf(pr.title, config.issueKeyPattern);

      let parentPr = null;
      const parentBranch = parentBranchToCheck(pr, before, config);
      if (parentBranch && !openHeads.has(parentBranch)) {
        const merged = await github.listMergedPullRequestsByHead(repo.github, parentBranch);
        parentPr = merged.find((candidate) => candidate.mergedAt) ?? null;
      }
      const stage = original ? workItemStage(original, config, agentsById) : null;
      const awaitingApproval = Boolean(original && original.status === "in_review" && stage.waitingOnBoard);
      const keys = conditionKeys({ snapshot, repo, parentPr, awaitingApproval });

      const seenKeys = new Set(before?.seenKeys ?? []);
      let seenFeedback = before?.seenFeedbackIds ?? [];
      let otherHumans = before?.otherHumanComments ?? [];
      let agentRead = before?.agentReadComments ?? [];
      let feedback = { board: [] };
      if (!before || before.updatedAt !== pr.updatedAt || before.pendingBoard?.length) {
        const [issueComments, reviews, reviewComments] = await Promise.all([
          github.listIssueComments(repo.github, pr.number),
          github.listReviews(repo.github, pr.number),
          github.listReviewComments(repo.github, pr.number),
        ]);
        const items = normalizeGitHubFeedback({ issueComments, reviews, reviewComments });
        feedback = splitFeedback(items, seenFeedback, config);
        const settled = [...feedback.agent, ...feedback.bot, ...feedback.ignored, ...feedback["other-human"]];
        seenFeedback = [...seenFeedback, ...settled.map((item) => item.id)];
        otherHumans = [
          ...otherHumans,
          ...feedback["other-human"].map((item) => ({ login: item.login, url: item.url, createdAt: item.createdAt })),
        ].slice(-5);
        agentRead = [
          ...agentRead,
          ...feedback.agent
            .filter((item) => !isAgentMarked(item, config.github))
            .map((item) => ({ url: item.url, createdAt: item.createdAt, excerpt: excerptOf(item.body) })),
        ].slice(-5);
        if (baseline || !before) {
          const older = feedback.board.filter((item) => baseline || !lastTickAt || item.createdAt <= lastTickAt);
          seenFeedback = [...seenFeedback, ...older.map((item) => item.id)];
          feedback.board = feedback.board.filter((item) => !older.includes(item));
        }
      }

      const record = {
        ...snapshot,
        seenKeys: [...seenKeys],
        seenFeedbackIds: seenFeedback,
        otherHumanComments: otherHumans,
        agentReadComments: agentRead,
      };
      nextPrs[id] = record;
      openPrs.push(record);

      for (const condition of keys) {
        const keyId = `${condition.cause}:${condition.key}`;
        if (seenKeys.has(keyId)) continue;
        if (baseline) {
          record.seenKeys.push(keyId);
          continue;
        }
        const context = { pr: snapshot, original, repo, config };
        const description = {
          conflict: () => templates.conflictTask(context),
          "ci-failed": () => templates.ciFailedTask(context),
          "parent-merged": () =>
            templates.parentMergedTask({ ...context, parentPr: condition.parentPr, previousBase: parentBranch }),
          "behind-at-approval": () => templates.behindAtApprovalTask(context),
        }[condition.cause]();
        events.push({
          fields: { cause: condition.cause, repo: repo.name, pr: pr.number, key: condition.key },
          title: templates.codeTaskTitle({ issueKey: snapshot.issueKey, cause: condition.cause, subject: id, config }),
          description,
          projectId: repo.projectId,
          assignee: config.paperclip.agents.developer,
          policy: reviewPolicy(config),
          priority: "high",
          onSettled: () => record.seenKeys.push(keyId),
        });
      }

      if (feedback.board.length) {
        const last = feedback.board[feedback.board.length - 1];
        events.push({
          fields: { cause: "board-comment", repo: repo.name, pr: pr.number, key: last.id.replace(":", "-") },
          title: templates.codeTaskTitle({ issueKey: snapshot.issueKey, cause: "board-comment", subject: id, config }),
          description: templates.reworkTask({ pr: snapshot, original, items: feedback.board, source: "github", config }),
          projectId: repo.projectId,
          assignee: config.paperclip.agents.developer,
          policy: reviewPolicy(config),
          priority: "high",
          deferWhileOpen: true,
          onSettled: () => {
            record.seenFeedbackIds = [...record.seenFeedbackIds, ...feedback.board.map((item) => item.id)];
            record.pendingBoard = [];
          },
          onDeferred: () => {
            record.pendingBoard = feedback.board.map((item) => item.id);
          },
        });
      }
    }
  }

  const boardUser = config.paperclip.boardUserId;
  const nextComments = {};
  for (const issue of codeIssues) {
    if (issue.assigneeAgentId || issue.status === "cancelled") continue;
    const tracked = state.paperclipComments[issue.id];
    const waitingOnBoard = issue.status === "in_review" && issue.assigneeUserId === boardUser;
    if (!tracked && issue.status !== "done" && !waitingOnBoard) continue;
    if (parseMarkers(issue.description).some((fields) => fields.cause)) continue;
    if (tracked && tracked.lastActivityAt === issue.lastActivityAt && !tracked.pendingCommentIds?.length) {
      nextComments[issue.id] = tracked;
      continue;
    }
    const cursor = tracked?.lastCommentId ?? null;
    const comments = (await paperclip.listComments(issue.id, cursor ? { after: cursor } : {})).filter(
      (comment) => comment.id !== cursor,
    );
    const lastComment = comments[comments.length - 1];
    const commentRecord = {
      lastActivityAt: issue.lastActivityAt,
      lastCommentId: lastComment?.id ?? cursor,
      pendingCommentIds: [],
    };
    nextComments[issue.id] = commentRecord;
    if (baseline) continue;
    const cutoff = tracked ? null : lastTickAt;
    const fresh = comments.filter(
      (comment) =>
        comment.authorType === "user" &&
        comment.authorUserId === boardUser &&
        !comment.deletedAt &&
        (!cutoff || comment.createdAt > cutoff) &&
        !isApprovalComment(comment.body, config),
    );
    if (!fresh.length) continue;
    const firstFresh = comments.indexOf(fresh[0]);
    const cursorBeforeFresh = firstFresh > 0 ? comments[firstFresh - 1].id : cursor;
    const repo = config.repos.find((candidate) => candidate.projectId === issue.projectId);
    const issueKey = issueKeyOf(issue.title, config.issueKeyPattern);
    const pr = openPrs.find((candidate) => candidate.originalId === issue.id) ?? null;
    const items = fresh.map((comment) => ({
      kind: "comment",
      body: comment.body,
      createdAt: comment.createdAt,
      url: `${config.paperclip.uiBaseUrl}/issues/${issue.identifier}#comment-${comment.id}`,
    }));
    events.push({
      fields: {
        cause: "board-comment",
        repo: repo.name,
        pr: pr?.number,
        task: issue.identifier,
        key: fresh[fresh.length - 1].id,
      },
      title: templates.codeTaskTitle({ issueKey, cause: "board-comment", subject: issue.identifier, config }),
      description: templates.reworkTask({ pr, original: issue, items, source: "paperclip", config }),
      projectId: issue.projectId,
      assignee: config.paperclip.agents.developer,
      policy: reviewPolicy(config),
      priority: "high",
      deferWhileOpen: true,
      onSettled: () => {},
      onDeferred: () => {
        commentRecord.lastCommentId = cursorBeforeFresh;
        commentRecord.pendingCommentIds = fresh.map((comment) => comment.id);
      },
    });
  }

  const ledgerChanged = await updateLedger({ config, github, paperclip, state, baseline, now, events, issueById, codeIssues, report });

  for (const event of events) {
    const subject = subjectOf(event.fields);
    const eventKey = eventOf(event.fields);
    const openSame = openBySubject.get(subject);
    if (openSame || state.markers[eventKey]) {
      const holder = openSame ?? state.markers[eventKey];
      if (event.deferWhileOpen && openSame && !openByEvent.has(eventKey)) {
        event.onDeferred?.();
        report.deferred.push(`${event.title} (waiting for ${holder.identifier} to close)`);
      } else {
        event.onSettled();
        report.skipped.push(`${event.title} (already ${holder.identifier})`);
      }
      continue;
    }
    const created = await paperclip.createIssue({
      title: event.title,
      description: templates.withMarker(event.fields, event.description),
      status: "todo",
      priority: event.priority,
      projectId: event.projectId,
      assigneeAgentId: event.assignee,
      executionPolicy: event.policy,
      idempotencyKey: `factory-watcher:v1:${eventKey}`.slice(0, 240),
    });
    state.markers[eventKey] = { id: created.id, identifier: created.identifier, createdAt: now.toISOString() };
    openBySubject.set(subject, created);
    event.onSettled(created);
    report.created.push({ title: event.title, identifier: created.identifier, marker: eventKey, description: event.description });
    await persistMarkers();
  }

  state.prs = nextPrs;
  state.paperclipComments = nextComments;

  const failedRuns = (Array.isArray(runs) ? runs : runs.items ?? []).filter(
    (run) =>
      ["failed", "timed_out"].includes(run.status) &&
      new Date(run.finishedAt ?? run.startedAt).getTime() > now.getTime() - 24 * HOUR,
  );
  const boardInput = { now, config, openPrs, codeIssues, agentsById, failedRuns, ledger: state.ledger };
  const boardMarkdown = renderBoard(boardInput);
  const ledgerMarkdown = renderLedger({ now, ledger: state.ledger, config });
  const boardIssueId = config.paperclip.boardIssueId;
  const documents = [];
  if (!boardIssueId) {
    report.notes.push("board issue not configured: board, ledger and daily summary not written");
  } else {
    const writtenAt = state.board.writtenAt ? new Date(state.board.writtenAt).getTime() : 0;
    if (now.getTime() - writtenAt >= config.board.rewriteMinutes * 60 * 1000) {
      documents.push({ key: "board", title: "Factory board", body: boardMarkdown });
      state.board.writtenAt = now.toISOString();
    }
    if (ledgerChanged || !state.board.ledgerWrittenAt) {
      documents.push({ key: "shipped-ledger", title: "Shipped ledger", body: ledgerMarkdown });
      state.board.ledgerWrittenAt = now.toISOString();
    }
    for (const document of documents) await writeDocument(paperclip, boardIssueId, document);

    const today = businessDate(now, config.businessHours);
    if (state.board.dailySummaryDate !== today) {
      const summary = renderDailySummary({ ...boardInput, snapshot: state.board.dailySnapshot });
      if (!baseline) await postDailySummary(paperclip, boardIssueId, today, summary, report);
      state.board.dailySummaryDate = today;
      state.board.dailySnapshot = {
        takenAt: now.toISOString(),
        statuses: Object.fromEntries(codeIssues.map((issue) => [issue.id, issue.status])),
      };
    }
  }

  state.lastTickAt = now.toISOString();
  if (!dryRun) await save(config.stateFile, state);

  printSummary({ log, dryRun, baseline, openPrs, report, paperclip, boardMarkdown, ledgerMarkdown, documents });
  return { ok: true, report, state, boardMarkdown, ledgerMarkdown };
}

async function writeDocument(paperclip, issueId, { key, title, body }) {
  const existing = await paperclip.getDocument(issueId, key);
  await paperclip.putDocument(issueId, key, {
    title,
    format: "markdown",
    body,
    changeSummary: "factory-watcher tick",
    ...(existing ? { baseRevisionId: existing.latestRevisionId } : {}),
  });
}

async function postDailySummary(paperclip, issueId, today, summary, report) {
  try {
    await paperclip.addComment(issueId, summary);
  } catch (error) {
    if (!(error instanceof PaperclipError) || error.status !== 403) throw error;
    await writeDocument(paperclip, issueId, { key: "daily-summary", title: `Daily summary ${today}`, body: summary });
    report.notes.push("daily summary comment refused (run has no issue context); wrote document daily-summary instead");
  }
}

async function updateLedger({ config, github, paperclip, state, baseline, now, events, issueById, codeIssues, report }) {
  let changed = false;
  const baselineAt = new Date(state.baselineAt).getTime();
  for (const repo of config.repos) {
    const merged = (
      await github.listMergedPullRequests(repo.github, repo.baseBranch, config.ledger.seedMergedSince, config.github.factoryBranchPrefix)
    ).filter((pr) => pr.headRefName.startsWith(config.github.factoryBranchPrefix) && pr.mergeCommit?.oid);
    for (const pr of merged) {
      const id = prId(repo.name, pr.number);
      if (state.ledger[id]) continue;
      const original = findOriginalTask({ title: pr.title, body: "" }, repo.projectId, codeIssues, config.issueKeyPattern).issue;
      const files = repo.manualDeployPaths?.length ? await github.listPullRequestFiles(repo.github, pr.number) : [];
      state.ledger[id] = {
        repo: repo.name,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        issueKey: issueKeyOf(pr.title, config.issueKeyPattern),
        originalId: original?.id ?? null,
        originalIdentifier: original?.identifier ?? null,
        goalTitle: null,
        mergedAt: pr.mergedAt,
        mergeCommit: pr.mergeCommit.oid,
        manualDeploy: (repo.manualDeployPaths ?? [])
          .filter((entry) => files.some((file) => file.startsWith(entry.path)))
          .map((entry) => entry.label),
        deploy: null,
        deployChecked: [],
        checks: {},
      };
      changed = true;
    }

    const rows = Object.values(state.ledger).filter((row) => row.repo === repo.name && !row.deploy);
    for (const row of rows) row.deployUnknown = repo.deploy.type !== "deploy-pr";
    if (!rows.length || repo.deploy.type !== "deploy-pr") continue;
    const deploys = deployPullRequests(
      await github.listMergedPullRequests(repo.github, repo.deploy.base, config.ledger.seedMergedSince),
      repo.deploy,
    );
    state.deploys[repo.name] = deploys.map((deploy) => deploy.number);
    for (const row of rows) {
      const { deploy, checked } = await matchDeploy(row, deploys, (base, head) =>
        github.compareStatus(repo.github, base, head),
      );
      if (deploy) {
        row.deploy = deploy;
        changed = true;
      }
      if (checked.length !== row.deployChecked.length) row.deployChecked = checked;
    }
  }

  for (const row of Object.values(state.ledger)) {
    const repo = config.repos.find((candidate) => candidate.name === row.repo);
    if (!row.deploy) continue;
    const deployedAt = new Date(row.deploy.mergedAt).getTime();
    for (const check of SHIP_CHECKS) {
      if (row.checks[check.cause]) continue;
      const due = deployedAt + check.offset;
      if (due > now.getTime()) continue;
      if (baseline || due <= baselineAt) {
        row.checks[check.cause] = { skipped: "due before the watcher started" };
        changed = true;
        continue;
      }
      const isKr = check.owner === "headOfProduct";
      if (isKr && row.originalId && !row.goalTitle) {
        row.goalTitle = (await paperclip.getIssue(row.originalId)).goal?.title ?? null;
      }
      events.push({
        fields: { cause: check.cause, repo: row.repo, pr: row.number, key: row.deploy.number },
        title: templates.codeTaskTitle({ issueKey: row.issueKey, cause: check.cause, subject: prId(row.repo, row.number), config }),
        description: isKr ? templates.krTask({ row, days: check.days, config }) : templates.shipCheckTask({ row, hours: check.hours, config }),
        projectId: isKr ? config.paperclip.projects.discovery : config.paperclip.projects.productionMonitoring,
        assignee: config.paperclip.agents[check.owner],
        policy: undefined,
        priority: "medium",
        onSettled: (created) => {
          row.checks[check.cause] = created
            ? { id: created.id, identifier: created.identifier, openedAt: now.toISOString() }
            : { identifier: "existing task" };
        },
      });
    }

    for (const cause of ["ship-check-1h", "ship-check-24h"]) {
      const check = row.checks[cause];
      if (!check?.id || check.result) continue;
      const issue = issueById.get(check.id);
      if (!issue || issue.lastActivityAt === check.seenActivityAt) continue;
      check.seenActivityAt = issue.lastActivityAt;
      const comments = await paperclip.listComments(check.id, { order: "desc", limit: 20 });
      const match = comments
        .filter((comment) => comment.authorType === "agent")
        .map((comment) => comment.body?.match(RESULT_LINE))
        .find(Boolean);
      if (!match) continue;
      check.result = match[1].toUpperCase();
      check.reason = match[2]?.trim() || null;
      changed = true;
      if (check.result === "RED") {
        events.push({
          fields: { cause: "ship-red", repo: row.repo, pr: row.number, key: cause },
          title: templates.codeTaskTitle({ issueKey: row.issueKey, cause: "ship-red", subject: prId(row.repo, row.number), config }),
          description: templates.shipRedTask({ row, check: cause, reason: check.reason, repo, config }),
          projectId: repo.projectId,
          assignee: config.paperclip.agents.developer,
          policy: reviewPolicy(config),
          priority: "high",
          onSettled: () => {},
        });
      }
    }
  }
  if (baseline) report.notes.push(`baseline tick: ${Object.keys(state.ledger).length} ledger rows seeded, no tasks opened`);
  return changed;
}

function printSummary({ log, dryRun, baseline, openPrs, report, paperclip, boardMarkdown, ledgerMarkdown, documents }) {
  const prefix = dryRun ? "[dry run] " : "";
  log(`${prefix}factory-watcher tick${baseline ? " (baseline: recording state, opening nothing)" : ""}`);
  log(`${prefix}open factory PRs: ${openPrs.length}`);
  log(`${prefix}tasks ${dryRun ? "that would be created" : "created"}: ${report.created.length}`);
  for (const item of report.created) log(`  + ${item.identifier} ${item.title}  [${item.marker}]`);
  log(`${prefix}events already covered by a task: ${report.skipped.length}`);
  for (const line of report.skipped) log(`  = ${line}`);
  if (report.deferred.length) {
    log(`${prefix}deferred until the open task closes: ${report.deferred.length}`);
    for (const line of report.deferred) log(`  ~ ${line}`);
  }
  for (const note of report.notes) log(`${prefix}note: ${note}`);
  log(`${prefix}documents ${dryRun ? "that would be written" : "written"}: ${documents.map((d) => d.key).join(", ") || "none"}`);
  if (dryRun) {
    log(`${prefix}planned Paperclip writes: ${paperclip.plannedWrites.length}`);
    for (const write of paperclip.plannedWrites) log(`  ${write.method} ${write.path}${write.body?.title ? `  "${write.body.title}"` : ""}`);
    for (const item of report.created) log(`\n----- task: ${item.title}\n${item.description}`);
    for (const write of paperclip.plannedWrites.filter((planned) => planned.path.endsWith("/comments"))) {
      log(`\n----- comment on the board issue\n${write.body.body}`);
    }
    log(`\n----- document: board\n${boardMarkdown}`);
    log(`\n----- document: shipped-ledger\n${ledgerMarkdown}`);
  }
}
