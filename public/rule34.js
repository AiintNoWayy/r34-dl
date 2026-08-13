import { fetch } from "@tauri-apps/plugin-http";

const API_URL = "https://api.rule34.xxx/index.php";
export const RESULTS_PER_PAGE = 100;
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "avi"]);

export function fileExtensionOf(fileUrl) {
  const match = fileUrl.match(/\.([a-zA-Z0-9]+)(?:[?#]|$)/);
  return match ? match[1].toLowerCase() : "";
}

export function mediaTypeOf(fileUrl) {
  return VIDEO_EXTENSIONS.has(fileExtensionOf(fileUrl)) ? "video" : "image";
}

export function slugifyTags(tags) {
  return tags.trim().replace(/\s+/g, "_");
}

function buildQueryUrl(params) {
  const url = new URL(API_URL);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

async function fetchResultsPage(tags, pageIndex, credentials) {
  const url = buildQueryUrl({
    page: "dapi",
    s: "post",
    q: "index",
    json: 1,
    tags,
    limit: RESULTS_PER_PAGE,
    pid: pageIndex,
    user_id: credentials.userId,
    api_key: credentials.apiKey,
  });
  const response = await fetch(url, { method: "GET" });
  if (response.status === 429) {
    const err = new Error("rate limited");
    err.rateLimited = true;
    throw err;
  }
  const data = await response.json().catch(() => null);
  return Array.isArray(data) ? data : [];
}

/**
 * The dapi only exposes a total result count in its XML mode (no json param);
 * the json mode returns a bare array with no total. One cheap limit=1 XML
 * request up front is enough to size a progress bar.
 */
export async function fetchResultCount(tags, credentials) {
  const url = buildQueryUrl({
    page: "dapi",
    s: "post",
    q: "index",
    tags,
    limit: 1,
    user_id: credentials.userId,
    api_key: credentials.apiKey,
  });
  const response = await fetch(url, { method: "GET" });
  const text = await response.text();
  const match = text.match(/<posts count="(\d+)"/);
  return match ? parseInt(match[1], 10) : null;
}

export async function checkCredentials(credentials) {
  const url = buildQueryUrl({
    page: "dapi",
    s: "post",
    q: "index",
    json: 1,
    limit: 1,
    user_id: credentials.userId,
    api_key: credentials.apiKey,
  });
  const response = await fetch(url, { method: "GET" });
  const text = await response.text();
  try {
    const data = JSON.parse(text);
    return { ok: Array.isArray(data), message: Array.isArray(data) ? "" : text };
  } catch {
    return { ok: false, message: text || `HTTP ${response.status}` };
  }
}

function toRecord(post) {
  return {
    id: post.id,
    type: mediaTypeOf(post.file_url),
    src: post.file_url,
    sampleUrl: post.sample_url || "",
    previewUrl: post.preview_url || "",
    tags: post.tags || "",
    rating: post.rating || "",
    score: post.score ?? "",
    size: `${post.width || ""}x${post.height || ""}`,
    postedBy: post.owner || "",
    source: post.source || "",
  };
}

export async function downloadBinary(url) {
  const response = await fetch(url, { method: "GET" });
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Walks every results page for `tags` and invokes `onRecord` for each new post.
 * Stops when a page returns fewer than RESULTS_PER_PAGE results.
 */
export async function collectAllResults({ tags, credentials, alreadySeenIds, onRecord, onPageComplete }) {
  let pageIndex = 0;

  while (true) {
    let posts;
    try {
      posts = await fetchResultsPage(tags, pageIndex, credentials);
    } catch (err) {
      if (err.rateLimited) {
        await sleep(5000);
        continue;
      }
      throw err;
    }

    if (posts.length === 0) break;

    for (const post of posts) {
      if (!post.file_url || alreadySeenIds.has(post.id)) continue;
      alreadySeenIds.add(post.id);
      await onRecord(toRecord(post));
    }

    onPageComplete?.(pageIndex + 1, posts.length);

    if (posts.length < RESULTS_PER_PAGE) break;
    pageIndex++;
    await sleep(500);
  }
}
