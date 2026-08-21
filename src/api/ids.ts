/**
 * Prefixed identifiers. A comment id sent to a post endpoint is refused at the
 * edge with a 400, instead of reaching a query and coming back as a 404.
 */
const PREFIXES = {
  channel: "chn",
  post: "pst",
  comment: "cmt",
  reply: "rpl",
} as const;

export type IdKind = keyof typeof PREFIXES;

export function encodeId(kind: IdKind, uuid: string): string {
  return `${PREFIXES[kind]}_${uuid.replaceAll("-", "")}`;
}

export function decodeId(kind: IdKind, value: string): string | null {
  const prefix = `${PREFIXES[kind]}_`;
  if (!value.startsWith(prefix)) {
    return null;
  }
  const raw = value.slice(prefix.length);
  if (!/^[0-9a-f]{32}$/i.test(raw)) {
    return null;
  }
  return [
    raw.slice(0, 8),
    raw.slice(8, 12),
    raw.slice(12, 16),
    raw.slice(16, 20),
    raw.slice(20),
  ].join("-");
}
