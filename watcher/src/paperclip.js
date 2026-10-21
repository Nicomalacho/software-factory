export class PaperclipError extends Error {
  constructor(method, path, status, body) {
    super(`Paperclip ${method} ${path} returned ${status}: ${String(body).slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }

  get code() {
    try {
      const parsed = JSON.parse(this.body);
      return parsed.code ?? parsed.details?.code ?? parsed.error ?? null;
    } catch {
      return null;
    }
  }
}

export function createPaperclip({ apiUrl, apiKey, companyId, runId, dryRun, fetchImpl = fetch, sleep }) {
  const plannedWrites = [];
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  async function request(method, path, body) {
    const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
    if (runId) headers["X-Paperclip-Run-Id"] = runId;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetchImpl(`${apiUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      if (response.status === 429 && attempt < 2) {
        await wait(Math.min(Number(response.headers.get("retry-after") ?? 2), 30) * 1000);
        continue;
      }
      if (!response.ok) throw new PaperclipError(method, path, response.status, text);
      return text ? JSON.parse(text) : null;
    }
  }

  function write(method, path, body, stub) {
    if (dryRun) {
      plannedWrites.push({ method, path, body });
      return Promise.resolve(stub);
    }
    return request(method, path, body);
  }

  const query = (params) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) search.set(key, String(value));
    }
    const text = search.toString();
    return text ? `?${text}` : "";
  };

  return {
    plannedWrites,
    listIssues: (params = {}) => request("GET", `/api/companies/${companyId}/issues${query({ limit: 1000, ...params })}`),
    getIssue: (id) => request("GET", `/api/issues/${id}`),
    listComments: (issueId, params = {}) =>
      request("GET", `/api/issues/${issueId}/comments${query({ order: "asc", ...params })}`),
    listAgents: () => request("GET", `/api/companies/${companyId}/agents`),
    listHeartbeatRuns: (params = {}) =>
      request("GET", `/api/companies/${companyId}/heartbeat-runs${query({ limit: 300, summary: true, ...params })}`),
    getDocument: async (issueId, key) => {
      try {
        return await request("GET", `/api/issues/${issueId}/documents/${key}`);
      } catch (error) {
        if (error instanceof PaperclipError && error.status === 404) return null;
        throw error;
      }
    },
    createIssue: (body) =>
      write("POST", `/api/companies/${companyId}/issues`, body, {
        id: `dry-run-${plannedWrites.length + 1}`,
        identifier: "(dry run)",
        ...body,
      }),
    putDocument: (issueId, key, body) =>
      write("PUT", `/api/issues/${issueId}/documents/${key}`, body, { key, latestRevisionId: null }),
    addComment: (issueId, body) => write("POST", `/api/issues/${issueId}/comments`, { body }, { id: "dry-run" }),
  };
}
