const MARKER_PATTERN = /<!-- factory-watcher:v1 ([^>]*?) -->/g;
const FIELD_ORDER = ["cause", "repo", "pr", "task", "key"];

export function formatMarker(fields) {
  const pairs = FIELD_ORDER.filter((name) => fields[name] !== undefined && fields[name] !== null).map(
    (name) => `${name}=${String(fields[name]).replace(/\s+/g, "_")}`,
  );
  return `<!-- factory-watcher:v1 ${pairs.join(" ")} -->`;
}

export function parseMarkers(text) {
  if (!text) return [];
  return [...text.matchAll(MARKER_PATTERN)].map((match) =>
    Object.fromEntries(
      match[1]
        .split(/\s+/)
        .filter(Boolean)
        .map((pair) => {
          const separator = pair.indexOf("=");
          return [pair.slice(0, separator), pair.slice(separator + 1)];
        }),
    ),
  );
}

export function subjectOf(fields) {
  return [fields.cause, fields.repo ?? "-", fields.pr ?? "-", fields.task ?? "-"].join("|");
}

export function eventOf(fields) {
  return `${subjectOf(fields)}|${fields.key ?? "-"}`;
}
