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

export function combineTags(tags, excludeTags) {
  const excluded = excludeTags
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((tag) => `-${tag}`)
    .join(" ");
  return excluded ? `${tags} ${excluded}` : tags;
}

export function slugifyTags(tags) {
  return tags
    .trim()
    .replace(/^user:/i, "")
    .replace(/\s+/g, "_")
    .replace(/[<>:"/\\|?*]/g, "_");
}

function buildQueryUrl(params) {
  const url = new URL(API_URL);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * Races `fetch` against `signal` directly, so a cancelled job stops waiting
 * immediately even if the underlying HTTP client ignores AbortSignal itself.
 */
function abortableFetch(url, options, signal) {
  const promise = fetch(url, { ...options, signal });
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

async function fetchResultsPage(tags, pageIndex, credentials, signal) {
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
  const response = await abortableFetch(url, { method: "GET" }, signal);
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
export async function fetchResultCount(tags, credentials, signal) {
  const url = buildQueryUrl({
    page: "dapi",
    s: "post",
    q: "index",
    tags,
    limit: 1,
    user_id: credentials.userId,
    api_key: credentials.apiKey,
  });
  const response = await abortableFetch(url, { method: "GET" }, signal);
  const text = await response.text();
  const match = text.match(/<posts count="(\d+)"/);
  return match ? parseInt(match[1], 10) : null;
}

export function extractPostId(input) {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const match = trimmed.match(/[?&]id=(\d+)/);
  return match ? match[1] : null;
}

export async function fetchPostById(id, credentials) {
  const url = buildQueryUrl({
    page: "dapi",
    s: "post",
    q: "index",
    json: 1,
    tags: `id:${id}`,
    user_id: credentials.userId,
    api_key: credentials.apiKey,
  });
  const response = await fetch(url, { method: "GET" });
  const data = await response.json().catch(() => null);
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
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

/**
 * Fetches just the total count and the first page of results, without
 * downloading anything, so the UI can show what a search would return.
 */
export async function searchPreview(tags, credentials, signal) {
  const [totalCount, posts] = await Promise.all([
    fetchResultCount(tags, credentials, signal),
    fetchResultsPage(tags, 0, credentials, signal),
  ]);
  return {
    totalCount,
    records: posts.filter((post) => post.file_url).map(toRecord),
  };
}

export async function downloadBinary(url, signal) {
  const response = await abortableFetch(url, { method: "GET" }, signal);
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

/**
 * Walks every results page for `tags` and invokes `onRecord` for each new post.
 * Stops when a page returns fewer than RESULTS_PER_PAGE results, or when `signal` aborts.
 */
export async function collectAllResults({ tags, credentials, alreadySeenIds, onRecord, onPageComplete, onRateLimited, signal }) {
  let pageIndex = 0;

  while (true) {
    let posts;
    try {
      posts = await fetchResultsPage(tags, pageIndex, credentials, signal);
    } catch (err) {
      if (err.rateLimited) {
        onRateLimited?.();
        await sleep(5000, signal);
        continue;
      }
      throw err;
    }

    if (posts.length === 0) break;

    for (const post of posts) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      if (!post.file_url || alreadySeenIds.has(post.id)) continue;
      alreadySeenIds.add(post.id);
      await onRecord(toRecord(post));
    }

    onPageComplete?.(pageIndex + 1, posts.length);

    if (posts.length < RESULTS_PER_PAGE) break;
    pageIndex++;
    await sleep(500, signal);
  }
}
