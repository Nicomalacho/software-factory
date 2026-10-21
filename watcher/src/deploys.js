const CONTAINS = new Set(["ahead", "identical"]);

export function deployPullRequests(mergedIntoProduction, deployConfig) {
  return mergedIntoProduction
    .filter(
      (pr) =>
        pr.headRefName === deployConfig.head &&
        new RegExp(deployConfig.titlePattern, "i").test(pr.title) &&
        pr.mergeCommit?.oid,
    )
    .map((pr) => ({ number: pr.number, url: pr.url, mergedAt: pr.mergedAt, mergeCommit: pr.mergeCommit.oid }))
    .sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
}

export function deployLabel(repoName, config) {
  return config.repos.find((repo) => repo.name === repoName)?.deploy?.label ?? "deploy PR";
}

export function deployLink(row, config) {
  return `[${deployLabel(row.repo, config)} #${row.deploy.number}](${row.deploy.url})`;
}

export async function matchDeploy(row, deploys, compareStatus) {
  const checked = new Set(row.deployChecked ?? []);
  for (const deploy of deploys) {
    if (deploy.mergedAt < row.mergedAt || checked.has(deploy.number)) continue;
    const status = await compareStatus(row.mergeCommit, deploy.mergeCommit);
    if (CONTAINS.has(status)) return { deploy, checked: [...checked] };
    checked.add(deploy.number);
  }
  return { deploy: null, checked: [...checked] };
}
