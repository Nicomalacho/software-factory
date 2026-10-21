const FAILING_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED"]);
const NOT_RUN_CONCLUSIONS = new Set(["SKIPPED", "NEUTRAL", "CANCELLED", "STALE"]);
const FAILING_STATES = new Set(["FAILURE", "ERROR"]);

function checkName(item) {
  if (item.__typename === "StatusContext") return item.context ?? "";
  return item.workflowName ? `${item.workflowName} / ${item.name}` : item.name ?? "";
}

function checkTime(item) {
  return item.completedAt || item.startedAt || "";
}

function outcomeOf(item) {
  if (item.__typename === "StatusContext") {
    if (FAILING_STATES.has(item.state)) return "failing";
    if (item.state === "PENDING" || item.state === "EXPECTED") return "pending";
    return "passing";
  }
  if (item.status && item.status !== "COMPLETED") return "pending";
  if (FAILING_CONCLUSIONS.has(item.conclusion)) return "failing";
  if (NOT_RUN_CONCLUSIONS.has(item.conclusion)) return "not-run";
  return "passing";
}

function latestPerName(rollup) {
  const latest = new Map();
  for (const item of rollup ?? []) {
    const name = checkName(item);
    const current = latest.get(name);
    if (!current || checkTime(item) >= checkTime(current)) latest.set(name, item);
  }
  return latest;
}

export function summarizeChecks(rollup, ignoredChecks) {
  const ignored = ignoredChecks.map((pattern) => new RegExp(pattern, "i"));
  const counts = { failing: 0, pending: 0, passing: 0, "not-run": 0 };
  const failing = [];
  for (const [name, item] of latestPerName(rollup)) {
    if (ignored.some((pattern) => pattern.test(name))) continue;
    const outcome = outcomeOf(item);
    counts[outcome] += 1;
    if (outcome === "failing") failing.push({ name, url: item.detailsUrl ?? item.targetUrl ?? null });
  }
  const conclusion = counts.failing
    ? "failing"
    : counts.pending
      ? "pending"
      : counts.passing
        ? "passing"
        : "none";
  return { conclusion, failing };
}
