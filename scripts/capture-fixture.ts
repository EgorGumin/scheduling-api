/**
 * Records a real Bluesky thread into a fixture, so the adapter tests run against
 * genuine platform output without a network call. Re-run when the shape changes:
 *
 *   npx tsx scripts/capture-fixture.ts <at-uri> <name> [repliesPerLevel]
 *
 * Popular threads run to megabytes, so each level is truncated to the first few
 * replies. Every retained node is verbatim platform output; only the breadth of
 * the tree is reduced, which keeps nesting, embeds and blocked nodes intact.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { openAppView } from "../src/platform/bluesky/appview.js";

const [uri, name, perLevelRaw] = process.argv.slice(2);
if (uri === undefined || name === undefined) {
  console.error("usage: capture-fixture.ts <at-uri> <name> [repliesPerLevel]");
  process.exit(1);
}
const perLevel = perLevelRaw === undefined ? 3 : Number.parseInt(perLevelRaw, 10);

const response = await openAppView().app.bsky.feed.getPostThread({
  uri,
  depth: 10,
  parentHeight: 0,
});

function prune(node: unknown): unknown {
  if (typeof node !== "object" || node === null) {
    return node;
  }
  const copy = { ...(node as Record<string, unknown>) };
  const replies = copy["replies"];
  if (Array.isArray(replies)) {
    copy["replies"] = replies.slice(0, perLevel).map(prune);
  }
  return copy;
}

await mkdir("src/platform/bluesky/__fixtures__", { recursive: true });
const path = `src/platform/bluesky/__fixtures__/${name}.json`;
await writeFile(path, `${JSON.stringify({ thread: prune(response.data.thread) }, null, 2)}\n`, "utf8");

console.log(`captured ${path}`);
