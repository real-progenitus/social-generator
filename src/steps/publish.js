import path from "node:path";
import { config, requireConfig } from "../config.js";
import { getPost, updatePost } from "../db.js";

const GRAPH = "https://graph.facebook.com/v21.0";

async function graph(method, endpoint, params) {
  const url = new URL(`${GRAPH}/${endpoint}`);
  const search = new URLSearchParams({ ...params, access_token: config.metaAccessToken });
  let res;
  if (method === "GET") {
    url.search = search.toString();
    res = await fetch(url);
  } else {
    res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: search,
    });
  }
  const json = await res.json();
  if (json.error) throw new Error(`Graph API error: ${JSON.stringify(json.error)}`);
  return json;
}

function publicUrlFor(filePath) {
  const rel = path.relative(config.outputDir, filePath).split(path.sep).join("/");
  return `${config.publicMediaBaseUrl}/${rel}`;
}

async function waitForContainer(creationId, { timeoutMs = 120000 } = {}) {
  const start = Date.now();
  for (;;) {
    const { status_code } = await graph("GET", creationId, { fields: "status_code" });
    if (status_code === "FINISHED") return;
    if (status_code === "ERROR")
      throw new Error(`Container ${creationId} entered ERROR state`);
    if (Date.now() - start > timeoutMs)
      throw new Error(`Container ${creationId} not ready after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/**
 * Publish an approved post as an Instagram carousel:
 * per-image item containers -> carousel container -> media_publish.
 * Requires the rendered PNGs to be publicly reachable at PUBLIC_MEDIA_BASE_URL.
 */
export async function publishPost(postId) {
  requireConfig(["igUserId", "metaAccessToken", "publicMediaBaseUrl"]);

  const post = getPost(postId);
  if (!post) throw new Error(`Post #${postId} not found`);
  if (!["approved", "rendered"].includes(post.status))
    throw new Error(`Post #${postId} is '${post.status}' — expected approved/rendered`);

  const slidePaths = JSON.parse(post.slide_paths_json);
  console.log(`[publish] uploading ${slidePaths.length} carousel items for post #${postId}`);

  const children = [];
  for (const p of slidePaths) {
    const { id } = await graph("POST", `${config.igUserId}/media`, {
      image_url: publicUrlFor(p),
      is_carousel_item: "true",
    });
    children.push(id);
  }

  const { id: carouselId } = await graph("POST", `${config.igUserId}/media`, {
    media_type: "CAROUSEL",
    children: children.join(","),
    caption: post.caption ?? "",
  });

  await waitForContainer(carouselId);

  const { id: mediaId } = await graph("POST", `${config.igUserId}/media_publish`, {
    creation_id: carouselId,
  });

  updatePost(postId, { status: "published", ig_media_id: mediaId });
  console.log(`[publish] post #${postId} live as IG media ${mediaId}`);
  return mediaId;
}
