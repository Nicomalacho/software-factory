export function normalizeGitHubFeedback({ issueComments, reviews, reviewComments }) {
  const items = [];
  for (const comment of issueComments) {
    items.push({
      kind: "comment",
      id: `comment:${comment.id}`,
      login: comment.user?.login ?? "",
      userType: comment.user?.type ?? "",
      body: comment.body ?? "",
      createdAt: comment.created_at,
      url: comment.html_url,
    });
  }
  for (const review of reviews) {
    const body = (review.body ?? "").trim();
    if (!body && review.state !== "CHANGES_REQUESTED") continue;
    items.push({
      kind: "review",
      id: `review:${review.id}`,
      login: review.user?.login ?? "",
      userType: review.user?.type ?? "",
      body: review.body ?? "",
      reviewState: review.state,
      createdAt: review.submitted_at,
      url: review.html_url,
    });
  }
  for (const comment of reviewComments) {
    items.push({
      kind: "inline",
      id: `inline:${comment.id}`,
      login: comment.user?.login ?? "",
      userType: comment.user?.type ?? "",
      body: comment.body ?? "",
      createdAt: comment.created_at,
      url: comment.html_url,
      path: comment.path,
      line: comment.line ?? comment.original_line ?? null,
    });
  }
  return items.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

export function isAgentMarked(item, github) {
  return github.agentMarkers.some((marker) => item.body.includes(marker));
}

export function classifyAuthor(item, github) {
  const login = item.login.toLowerCase();
  if (item.userType === "Bot" || login.endsWith("[bot]") || github.botLogins.some((bot) => bot.toLowerCase() === login)) {
    return "bot";
  }
  if (github.ignoredBodyPatterns.some((pattern) => new RegExp(pattern, "i").test(item.body))) {
    return "ignored";
  }
  if (login === github.boardLogin.toLowerCase()) {
    const marked = isAgentMarked(item, github);
    const agentLike = github.agentPhrasePatterns.some((pattern) => new RegExp(pattern, "i").test(item.body));
    return marked || agentLike ? "agent" : "board";
  }
  return "other-human";
}
