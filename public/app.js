import { Store } from "@tauri-apps/plugin-store";
import { open } from "@tauri-apps/plugin-dialog";
import { mkdir, writeFile, writeTextFile, readTextFile, exists, copyFile, readDir } from "@tauri-apps/plugin-fs";
import { join, downloadDir } from "@tauri-apps/api/path";
import { getVersion } from "@tauri-apps/api/app";
import { check as checkForUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  slugifyTags,
  combineTags,
  fileExtensionOf,
  checkCredentials,
  downloadBinary,
  collectAllResults,
  fetchResultCount,
  extractPostId,
  fetchPostById,
  searchPreview,
  RESULTS_PER_PAGE,
} from "./rule34.js";

const store = await Store.load("config.json");

const setupView = document.getElementById("setup-view");
const mainView = document.getElementById("main-view");
const setupForm = document.getElementById("setup-form");
const setupError = document.getElementById("setup-error");
const setupSubmit = document.getElementById("setup-submit");

const findUploaderForm = document.getElementById("find-uploader-form");
const postLookupInput = document.getElementById("postLookup");
const findUploaderBtn = document.getElementById("find-uploader-btn");
const downloadPostBtn = document.getElementById("download-post-btn");
const uploaderResultEl = document.getElementById("uploader-result");

const jobForm = document.getElementById("job-form");
const tagsInput = document.getElementById("tags");
const excludeTagsInput = document.getElementById("excludeTags");
const filterAiPostsInput = document.getElementById("filterAiPosts");
const batchLimitInput = document.getElementById("batchLimit");
const moreOptionsToggle = document.getElementById("moreOptionsToggle");
const moreOptions = document.getElementById("moreOptions");
const searchBtn = document.getElementById("search-btn");
const searchResultEl = document.getElementById("search-result");
const submitBtn = document.getElementById("submit-btn");
const cancelBtn = document.getElementById("cancel-btn");
const queueAddBtn = document.getElementById("queue-add-btn");
const queueSection = document.getElementById("queue-section");
const queueList = document.getElementById("queue-list");
const queueStartBtn = document.getElementById("queue-start-btn");
const queuePauseBtn = document.getElementById("queue-pause-btn");
const queueClearBtn = document.getElementById("queue-clear-btn");
const statusEl = document.getElementById("status");
const previewEl = document.getElementById("preview");
const failuresEl = document.getElementById("failures");
const progressTrack = document.getElementById("progress-track");
const progressFill = document.getElementById("progress-fill");
const folderLabel = document.getElementById("folder-label");
const changeFolderBtn = document.getElementById("change-folder");
const openFolderBtn = document.getElementById("open-folder-btn");
const scanBtn = document.getElementById("scan-btn");
const scanResultEl = document.getElementById("scan-result");
const editKeyLink = document.getElementById("edit-key");
const updateBanner = document.getElementById("update-banner");
const updateMessage = document.getElementById("update-message");
const updateBtn = document.getElementById("update-btn");
const appVersionEl = document.getElementById("app-version");

let downloadRoot = null;
let currentAbortController = null;
let queue = [];
let queueIdCounter = 0;
let queueRunning = false;
let queuePaused = false;
let globalIndex = new Map();
let globalIndexPath = null;

async function getDefaultDownloadRoot() {
  const saved = await store.get("downloadRoot");
  if (saved) return saved;
  return join(await downloadDir(), "r34-dl");
}

/**
 * A per-download-root index of post id -> file path, so the same post found
 * under two different searches (e.g. a tag and its uploader) is copied
 * locally instead of downloaded twice.
 */
async function loadGlobalIndex() {
  globalIndexPath = await join(downloadRoot, "downloaded_index.json");
  try {
    const data = (await exists(globalIndexPath)) ? JSON.parse(await readTextFile(globalIndexPath)) : {};
    globalIndex = new Map(Object.entries(data));
  } catch {
    globalIndex = new Map();
  }
}

async function saveGlobalIndex() {
  await writeTextFile(globalIndexPath, JSON.stringify(Object.fromEntries(globalIndex), null, 2));
}

/**
 * Writes `filePath` from `url` unless it's already there, copying it locally
 * from an earlier download of the same post id when possible instead of
 * re-fetching the bytes over the network.
 */
async function fetchOrCopy(id, url, filePath, signal) {
  if (await exists(filePath)) return;

  const key = String(id);
  const indexedPath = globalIndex.get(key);
  if (indexedPath && indexedPath !== filePath && (await exists(indexedPath))) {
    await copyFile(indexedPath, filePath);
    return;
  }

  await writeFile(filePath, await downloadBinary(url, signal));
  globalIndex.set(key, filePath);
  await saveGlobalIndex();
}

/**
 * Rebuilds the global index from whatever's actually on disk under
 * `downloadRoot`: every subfolder's `images`/`videos` files (named by post
 * id, so no metadata is needed to identify them) plus loose files saved by
 * "Download this image". Lets dedup catch files downloaded before the index
 * existed, after the whole folder was moved somewhere else, or after the
 * per-tag metadata JSON was deleted (it's optional; the files on disk are
 * always the source of truth).
 */
async function scanDownloadRoot() {
  const entries = await readDir(downloadRoot);
  let foldersScanned = 0;
  let newlyIndexed = 0;

  for (const entry of entries) {
    if (!entry.isDirectory) {
      const match = entry.name.match(/^(\d+)\.[a-zA-Z0-9]+$/);
      if (match && !globalIndex.has(match[1])) {
        globalIndex.set(match[1], await join(downloadRoot, entry.name));
        newlyIndexed++;
      }
      continue;
    }

    foldersScanned++;
    const folderPath = await join(downloadRoot, entry.name);

    for (const subdir of ["images", "videos"]) {
      const subdirPath = await join(folderPath, subdir);
      if (!(await exists(subdirPath))) continue;

      for (const file of await readDir(subdirPath)) {
        if (file.isDirectory) continue;
        const match = file.name.match(/^(\d+)\.[a-zA-Z0-9]+$/);
        if (!match || globalIndex.has(match[1])) continue;
        globalIndex.set(match[1], await join(subdirPath, file.name));
        newlyIndexed++;
      }
    }
  }

  await saveGlobalIndex();
  return { foldersScanned, newlyIndexed };
}

/**
 * How many items are already down for `tags`: the metadata JSON's record
 * count when it exists, otherwise a direct count of files in that folder's
 * images/videos subfolders, so this stays accurate even without the
 * (optional) JSON.
 */
async function getExistingCount(tags) {
  try {
    const slug = slugifyTags(tags);
    const folderPath = await join(downloadRoot, slug);
    const jsonPath = await join(folderPath, `${slug}_data.json`);

    let jsonCount = 0;
    if (await exists(jsonPath)) {
      const records = JSON.parse(await readTextFile(jsonPath));
      if (Array.isArray(records)) jsonCount = records.length;
    }

    let diskCount = 0;
    for (const subdir of ["images", "videos"]) {
      const subdirPath = await join(folderPath, subdir);
      if (!(await exists(subdirPath))) continue;
      diskCount += (await readDir(subdirPath)).filter((f) => !f.isDirectory).length;
    }

    // The JSON can under-report (missing entirely, or rewritten from
    // scratch after being deleted mid-history) but the files on disk never
    // lie, so never show fewer than what's actually there.
    return Math.max(jsonCount, diskCount);
  } catch {
    return 0;
  }
}

async function saveQueue() {
  await store.set("queue", queue);
  await store.save();
}

async function loadQueue() {
  const saved = await store.get("queue");
  if (!Array.isArray(saved)) return;
  queue = saved.map((item) => (item.status === "running" ? { ...item, status: "pending" } : item));
  queueIdCounter = queue.reduce((max, item) => Math.max(max, item.id + 1), 0);
  renderQueue();
}

async function showMainView() {
  setupView.hidden = true;
  mainView.hidden = false;
  downloadRoot = await getDefaultDownloadRoot();
  folderLabel.textContent = downloadRoot;
  await loadGlobalIndex();
  await loadQueue();
}

function showSetupView() {
  mainView.hidden = true;
  setupView.hidden = false;
}

const credentials = await store.get("credentials");
if (credentials?.userId && credentials?.apiKey) {
  await showMainView();
} else {
  showSetupView();
}

async function checkForAppUpdate() {
  try {
    const update = await checkForUpdate();
    if (!update?.available) return;

    updateMessage.textContent = `A new version (${update.version}) is available.`;
    updateBanner.hidden = false;

    updateBtn.addEventListener("click", async () => {
      updateBtn.disabled = true;
      updateBtn.textContent = "Updating...";
      updateMessage.textContent = `Downloading v${update.version}...`;
      try {
        await update.downloadAndInstall();
        await relaunch();
      } catch (err) {
        updateBtn.disabled = false;
        updateBtn.textContent = "Update now";
        updateMessage.textContent = `Update failed: ${errorMessage(err)}`;
      }
    });
  } catch (err) {
    console.error("Update check failed:", err);
  }
}

checkForAppUpdate();
getVersion().then((version) => {
  appVersionEl.textContent = `v${version}`;
});

setupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setupError.textContent = "";
  setupSubmit.disabled = true;
  setupSubmit.textContent = "Checking...";

  const raw = document.getElementById("credentialsPaste").value.trim().replace(/^[?&]/, "");
  const params = new URLSearchParams(raw);
  const userId = params.get("user_id")?.trim();
  const apiKey = params.get("api_key")?.trim();

  if (!userId || !apiKey) {
    setupSubmit.disabled = false;
    setupSubmit.textContent = "Save & Continue";
    setupError.textContent = "Couldn't find both user_id and api_key in what you pasted.";
    return;
  }

  const result = await checkCredentials({ userId, apiKey });
  setupSubmit.disabled = false;
  setupSubmit.textContent = "Save & Continue";

  if (!result.ok) {
    setupError.textContent = `Couldn't validate these credentials: ${result.message}`;
    return;
  }

  await store.set("credentials", { userId, apiKey });
  await store.save();
  await showMainView();
});

editKeyLink.addEventListener("click", (event) => {
  event.preventDefault();
  showSetupView();
});

findUploaderForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  uploaderResultEl.classList.remove("error");
  uploaderResultEl.textContent = "";

  const id = extractPostId(postLookupInput.value);
  if (!id) {
    uploaderResultEl.classList.add("error");
    uploaderResultEl.textContent = "Couldn't find a post ID in that link.";
    return;
  }

  findUploaderBtn.disabled = true;
  findUploaderBtn.textContent = "Looking up...";

  try {
    const credentials = await store.get("credentials");
    const post = await fetchPostById(id, credentials);
    if (!post || !post.owner) {
      uploaderResultEl.classList.add("error");
      uploaderResultEl.textContent = `No post found for id ${id}.`;
      return;
    }

    const label = document.createElement("span");
    label.append("Posted by ");
    const strong = document.createElement("strong");
    strong.textContent = post.owner;
    label.append(strong);

    const useBtn = document.createElement("button");
    useBtn.type = "button";
    useBtn.className = "secondary";
    useBtn.textContent = "Use as search";
    useBtn.addEventListener("click", () => {
      tagsInput.value = `user:${post.owner}`;
      tagsInput.focus();
    });

    uploaderResultEl.append(label, useBtn);
  } catch (err) {
    uploaderResultEl.classList.add("error");
    uploaderResultEl.textContent = `Lookup failed: ${errorMessage(err)}`;
  } finally {
    findUploaderBtn.disabled = false;
    findUploaderBtn.textContent = "Find uploader";
  }
});

downloadPostBtn.addEventListener("click", async () => {
  uploaderResultEl.classList.remove("error");
  uploaderResultEl.textContent = "";

  const id = extractPostId(postLookupInput.value);
  if (!id) {
    uploaderResultEl.classList.add("error");
    uploaderResultEl.textContent = "Couldn't find a post ID in that link.";
    return;
  }

  downloadPostBtn.disabled = true;
  downloadPostBtn.textContent = "Downloading...";

  try {
    const credentials = await store.get("credentials");
    const post = await fetchPostById(id, credentials);
    if (!post || !post.file_url) {
      uploaderResultEl.classList.add("error");
      uploaderResultEl.textContent = `No downloadable file found for id ${id}.`;
      return;
    }

    const extension = fileExtensionOf(post.file_url);
    const filePath = await join(downloadRoot, `${id}.${extension}`);
    await mkdir(downloadRoot, { recursive: true });
    await fetchOrCopy(id, post.file_url, filePath);
    uploaderResultEl.textContent = `Saved to ${filePath}`;
  } catch (err) {
    uploaderResultEl.classList.add("error");
    uploaderResultEl.textContent = `Download failed: ${errorMessage(err)}`;
  } finally {
    downloadPostBtn.disabled = false;
    downloadPostBtn.textContent = "Download this image";
  }
});

moreOptionsToggle.addEventListener("click", (event) => {
  event.preventDefault();
  const showing = !moreOptions.hidden;
  moreOptions.hidden = showing;
  moreOptionsToggle.textContent = showing ? "+ More options" : "- More options";
  if (!showing) excludeTagsInput.focus();
});

openFolderBtn.addEventListener("click", async () => {
  try {
    await openPath(downloadRoot);
  } catch (err) {
    scanResultEl.classList.add("error");
    scanResultEl.textContent = `Couldn't open folder: ${errorMessage(err)}`;
  }
});

changeFolderBtn.addEventListener("click", async () => {
  const picked = await open({ directory: true, multiple: false, title: "Choose download folder" });
  if (!picked) return;
  downloadRoot = picked;
  folderLabel.textContent = downloadRoot;
  await store.set("downloadRoot", downloadRoot);
  await store.save();
  await loadGlobalIndex();
  scanResultEl.textContent = "";
});

scanBtn.addEventListener("click", async () => {
  scanBtn.disabled = true;
  scanBtn.textContent = "Scanning...";
  scanResultEl.classList.remove("error");
  scanResultEl.textContent = "";

  try {
    const { foldersScanned, newlyIndexed } = await scanDownloadRoot();
    scanResultEl.textContent = `Scanned ${foldersScanned} folder(s), indexed ${newlyIndexed} previously-downloaded item(s).`;
  } catch (err) {
    scanResultEl.classList.add("error");
    scanResultEl.textContent = `Scan failed: ${errorMessage(err)}`;
  } finally {
    scanBtn.disabled = false;
    scanBtn.textContent = "Scan folder";
  }
});

function getEffectiveExcludeTags() {
  const manual = excludeTagsInput.value.trim();
  const tags = manual ? manual.split(/\s+/) : [];
  if (filterAiPostsInput.checked && !tags.includes("ai_generated")) {
    tags.push("ai_generated");
  }
  return tags.join(" ");
}

function errorMessage(err) {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

searchBtn.addEventListener("click", async () => {
  const tags = tagsInput.value.trim();
  if (!tags) return;
  const queryTags = combineTags(tags, getEffectiveExcludeTags());

  searchBtn.disabled = true;
  submitBtn.disabled = true;
  searchBtn.textContent = "Searching...";
  searchResultEl.classList.remove("error");
  searchResultEl.textContent = "";
  previewEl.innerHTML = "";

  try {
    const credentials = await store.get("credentials");
    const { totalCount, records } = await searchPreview(queryTags, credentials);
    renderPreview(records);
    searchResultEl.textContent =
      totalCount != null
        ? `${totalCount} result(s) for "${tags}". Showing the first ${records.length}. Hit Download to fetch everything.`
        : `Found results for "${tags}" (exact count unavailable). Hit Download to fetch everything.`;
  } catch (err) {
    searchResultEl.classList.add("error");
    searchResultEl.textContent = `Search failed: ${errorMessage(err)}`;
  } finally {
    searchBtn.disabled = false;
    submitBtn.disabled = false;
    searchBtn.textContent = "Search";
  }
});

/**
 * Runs one full search-and-download job for `tags`. Drives the shared status
 * area, progress bar, and preview grid. Returns "done", "cancelled", or
 * "error" instead of throwing, so callers (the Download button, the queue
 * runner) don't need their own try/catch around it.
 */
async function runJob(tags, { excludeTags, batchLimit, includeImages, includeVideos, includeJson }, onProgress, absoluteTarget) {
  const queryTags = combineTags(tags, excludeTags || "");
  previewEl.innerHTML = "";
  failuresEl.innerHTML = "";
  progressTrack.classList.add("visible");
  progressFill.classList.add("indeterminate");
  progressFill.style.width = "";

  const { userId, apiKey } = await store.get("credentials");

  currentAbortController = new AbortController();
  const { signal } = currentAbortController;

  submitBtn.disabled = true;
  searchBtn.disabled = true;
  queueStartBtn.disabled = true;
  cancelBtn.hidden = false;
  statusEl.textContent = "Starting...";

  let jobFolder = "";
  let itemCount = 0;
  let newItemsThisRun = 0;
  let batchLimitReached = false;

  try {
    const slug = slugifyTags(tags);
    jobFolder = await join(downloadRoot, slug);
    await mkdir(jobFolder, { recursive: true });

    const jsonPath = await join(jobFolder, `${slug}_data.json`);
    const existingRecords = (await exists(jsonPath)) ? JSON.parse(await readTextFile(jsonPath)) : [];
    const seenIds = new Set(existingRecords.map((r) => r.id));
    // Files on disk are the real source of truth, whether or not the JSON
    // has a record for them (it might be missing entirely, or just
    // incomplete because it was deleted and is being rebuilt from scratch).
    // Without this, a folder without its JSON would look empty and
    // re-paginate the whole search from page one on every run.
    for (const subdir of ["images", "videos"]) {
      const subdirPath = await join(jobFolder, subdir);
      if (!(await exists(subdirPath))) continue;
      for (const file of await readDir(subdirPath)) {
        if (file.isDirectory) continue;
        const match = file.name.match(/^(\d+)\./);
        if (match) seenIds.add(Number(match[1]));
      }
    }
    const allRecords = [...existingRecords];
    const startCount = seenIds.size;
    itemCount = startCount;
    // Results come back newest-first, so whatever's already on disk lines up
    // with the earliest pages: jump close to where we left off instead of
    // re-walking every already-downloaded page one by one. A 2-page margin
    // covers any new posts that landed since the last run.
    const startPage = Math.max(0, Math.floor(startCount / RESULTS_PER_PAGE) - 2);
    if (startCount > 0) {
      statusEl.textContent = `Starting... (${startCount} item(s) already downloaded, resuming...)`;
    }
    const previewRecords = [];
    const failures = [];

    const totalCount = await fetchResultCount(queryTags, { userId, apiKey }, signal).catch(() => null);
    const totalPages = totalCount ? Math.ceil(totalCount / RESULTS_PER_PAGE) : null;
    // The target for this run's progress bar/ETA, and where a batched run
    // stops. `absoluteTarget` (a queue entry's fixed plan boundary from
    // buildBatchPlan) takes priority so a batch stops at the same line every
    // time regardless of how many times this run got interrupted and
    // restarted; without one (a plain one-off Download), it's relative to
    // wherever this run is starting from, same as before.
    const target = absoluteTarget ?? (batchLimit ? Math.min(totalCount ?? Infinity, startCount + batchLimit) : totalCount);
    const jobStart = Date.now();

    if (target) {
      progressFill.classList.remove("indeterminate");
      progressFill.style.width = "0%";
    }

    await collectAllResults({
      tags: queryTags,
      credentials: { userId, apiKey },
      alreadySeenIds: seenIds,
      startPage,
      signal,
      onRateLimited: () => {
        statusEl.textContent = `Rate limited by rule34.xxx, retrying in 5s... (${itemCount} items so far)`;
      },
      onRecord: async (record) => {
        allRecords.push(record);
        newItemsThisRun++;
        // Not allRecords.length: when the JSON was missing or incomplete,
        // allRecords only holds newly-found records, while startCount
        // already accounts for what's on disk from before this run.
        itemCount = startCount + newItemsThisRun;
        onProgress?.(itemCount);
        if (previewRecords.length < 60) {
          previewRecords.push(record);
          renderPreview(previewRecords);
        }

        try {
          const extension = fileExtensionOf(record.src);
          const filename = `${record.id}.${extension}`;
          const wantsDownload =
            (record.type === "image" && includeImages) || (record.type === "video" && includeVideos);
          if (wantsDownload) {
            const dir = await join(jobFolder, record.type === "image" ? "images" : "videos");
            const filePath = await join(dir, filename);
            await mkdir(dir, { recursive: true });
            await fetchOrCopy(record.id, record.src, filePath, signal);
          }
        } catch (err) {
          const message = `#${record.id}: ${errorMessage(err)}`;
          failures.push(message);
          const li = document.createElement("li");
          li.textContent = message;
          failuresEl.appendChild(li);
        }

        if (includeJson) {
          await writeTextFile(jsonPath, JSON.stringify(allRecords, null, 2));
        }

        if (target) {
          const pct = Math.min(100, Math.round((itemCount / target) * 100));
          progressFill.style.width = `${pct}%`;
          const elapsed = Date.now() - jobStart;
          const eta = (elapsed / newItemsThisRun) * Math.max(target - itemCount, 0);
          const totalSuffix = totalCount && target < totalCount ? ` of ${totalCount} total` : "";
          statusEl.textContent =
            `Fetching "${tags}", ${itemCount}/${target} items${totalSuffix} (${pct}%)` +
            (itemCount < target ? `, ~${formatDuration(eta)} left...` : "...");
        } else {
          statusEl.textContent = `Fetching "${tags}", ${itemCount} items collected...`;
        }

        if (batchLimit && target != null && itemCount >= target) {
          batchLimitReached = true;
          currentAbortController.abort();
        }
      },
    });

    progressFill.classList.remove("indeterminate");
    progressFill.style.width = "100%";
    statusEl.textContent = `Done in ${formatDuration(Date.now() - jobStart)}. ${itemCount} items saved to ${jobFolder}`;
    if (failures.length > 0) {
      statusEl.textContent += ` (${failures.length} item(s) failed to download)`;
      console.error("Download failures:", failures);
    }
    return { outcome: "done", itemCount };
  } catch (err) {
    if (err.name === "AbortError") {
      if (batchLimitReached) {
        statusEl.textContent = `Stopped after ${newItemsThisRun} new item(s) (batch limit reached). Run again to continue.`;
        return { outcome: "partial", itemCount };
      }
      statusEl.textContent = `Cancelled. ${itemCount} item(s) saved to ${jobFolder}`;
      return { outcome: "cancelled", itemCount };
    }
    statusEl.textContent = `Error: ${errorMessage(err)}`;
    console.error(err);
    return { outcome: "error", itemCount };
  } finally {
    submitBtn.disabled = false;
    searchBtn.disabled = false;
    queueStartBtn.disabled = false;
    cancelBtn.hidden = true;
    currentAbortController = null;
  }
}

jobForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const tags = tagsInput.value.trim();
  if (!tags) return;

  const options = {
    excludeTags: getEffectiveExcludeTags(),
    batchLimit: batchLimitInput.value ? Number(batchLimitInput.value) : null,
    includeImages: document.getElementById("includeImages").checked,
    includeVideos: document.getElementById("includeVideos").checked,
    includeJson: document.getElementById("includeJson").checked,
  };

  if (options.batchLimit) {
    // A batched download goes through the queue instead of running on its
    // own: that's what makes the full plan (already done, current, still to
    // come) show up somewhere, and what a plain one-off run never left
    // behind before.
    submitBtn.disabled = true;
    submitBtn.textContent = "Queuing...";
    queue.push(...(await buildBatchPlan(tags, options)));
    renderQueue();
    await saveQueue();
    excludeTagsInput.value = "";
    batchLimitInput.value = "";
    submitBtn.disabled = false;
    submitBtn.textContent = "Download";
    await runQueueLoop();
    return;
  }

  await runJob(tags, options);
});

cancelBtn.addEventListener("click", () => {
  currentAbortController?.abort();
});

/**
 * Always describes a batch entry with numbers local to that batch (e.g.
 * "6684/10000 items"), never the whole search's total, so the count next to
 * a batch always matches the size the user actually set as the batch limit.
 * Pending entries carry a startCount/target snapshot from when they were
 * added (see buildBatchPlan), so even a batch that hasn't run yet can show
 * how much of it is already covered by existing downloads.
 */
function formatBatchCount(item) {
  if (item.target != null && item.startCount != null) {
    const batchSize = item.target - item.startCount;
    // Not capped at batchSize: the plan's boundaries are a snapshot, and the
    // messy pre-batching history in an existing folder rarely lines up with
    // clean multiples of the batch limit, so a running batch can genuinely
    // pass its planned size by a bit. Capping it would show "10000/10000"
    // (reads as finished) while the row still says "running" underneath.
    const progress = Math.max(0, (item.liveCount ?? item.startCount) - item.startCount);
    return `${progress}/${batchSize} items`;
  }

  const batchLimit = item.options?.batchLimit;
  if (item.status === "pending" && batchLimit) return `up to ${batchLimit} items`;
  return item.totalCount != null ? `${item.totalCount} items` : "? items";
}

function updateQueueRowCount(item) {
  const span = document.getElementById(`queue-count-${item.id}`);
  if (span) span.textContent = formatBatchCount(item);
}

function renderQueue() {
  queueSection.hidden = queue.length === 0;
  queueList.innerHTML = "";

  // The item Start queue will pick up next: highlighted so it reads as
  // "we're resuming here," distinct from batches already fully covered
  // (grayed via the "done" class) and ones still further out.
  const nextPendingId = queue.find((q) => q.status === "pending")?.id;

  for (const item of queue) {
    const li = document.createElement("li");
    li.id = `queue-row-${item.id}`;
    li.className = item.status + (item.id === nextPendingId ? " next-up" : "");

    const tagSpan = document.createElement("span");
    tagSpan.className = "queue-tag";
    tagSpan.textContent = item.label || item.tags;

    const countSpan = document.createElement("span");
    countSpan.className = "queue-count";
    countSpan.id = `queue-count-${item.id}`;
    countSpan.textContent = formatBatchCount(item);

    const statusSpan = document.createElement("span");
    statusSpan.className = "queue-status";
    statusSpan.textContent = item.status;

    // A fixed-width slot for whichever buttons this row gets, so rows with
    // fewer buttons (e.g. "running", with none) don't let the count/status
    // columns before them drift out of alignment with rows that have more.
    const actions = document.createElement("span");
    actions.className = "queue-actions";

    if (item.status === "pending") {
      const index = queue.indexOf(item);

      const upBtn = document.createElement("button");
      upBtn.type = "button";
      upBtn.className = "secondary";
      upBtn.textContent = "▲";
      upBtn.disabled = index === 0;
      upBtn.addEventListener("click", () => moveQueueItem(item.id, -1));

      const downBtn = document.createElement("button");
      downBtn.type = "button";
      downBtn.className = "secondary";
      downBtn.textContent = "▼";
      downBtn.disabled = index === queue.length - 1;
      downBtn.addEventListener("click", () => moveQueueItem(item.id, 1));

      actions.append(upBtn, downBtn);
    }

    if (item.status === "partial" || item.status === "cancelled" || item.status === "error") {
      const resumeBtn = document.createElement("button");
      resumeBtn.type = "button";
      resumeBtn.className = "secondary";
      resumeBtn.textContent = "Resume";
      resumeBtn.addEventListener("click", () => {
        item.status = "pending";
        renderQueue();
        saveQueue();
      });
      actions.append(resumeBtn);
    }

    if (item.status !== "running") {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "secondary";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", () => {
        queue = queue.filter((q) => q.id !== item.id);
        renderQueue();
        saveQueue();
      });
      actions.append(removeBtn);
    }

    li.append(tagSpan, countSpan, statusSpan, actions);
    queueList.appendChild(li);
  }
}

function moveQueueItem(id, direction) {
  const index = queue.findIndex((q) => q.id === id);
  const newIndex = index + direction;
  if (index < 0 || newIndex < 0 || newIndex >= queue.length) return;
  [queue[index], queue[newIndex]] = [queue[newIndex], queue[index]];
  renderQueue();
  saveQueue();
}

/**
 * Builds the queue entries a search would produce right now: one per batch
 * (or a single entry with no batch limit), each carrying its own startCount/
 * target computed from what's actually on disk for `tags` at this moment.
 * A batch already fully covered by existing downloads is marked "done"
 * immediately, so the queue always shows the whole plan up front, not just
 * whatever's left to do.
 */
async function buildBatchPlan(tags, options) {
  let totalCount = null;
  try {
    const credentials = await store.get("credentials");
    totalCount = await fetchResultCount(combineTags(tags, options.excludeTags), credentials);
  } catch {
    totalCount = null;
  }
  const existingCount = await getExistingCount(tags);

  const { batchLimit } = options;
  const runs = batchLimit && totalCount ? Math.ceil(totalCount / batchLimit) : 1;
  const entries = [];
  for (let i = 0; i < runs; i++) {
    const label = runs > 1 ? `${tags} (batch ${i + 1}/${runs})` : tags;
    const batchStart = batchLimit ? i * batchLimit : 0;
    const batchEnd = batchLimit ? Math.min(totalCount ?? Infinity, (i + 1) * batchLimit) : totalCount;
    const alreadyCovered = batchEnd != null && existingCount >= batchEnd;
    entries.push({
      id: queueIdCounter++,
      tags,
      label,
      options,
      totalCount,
      startCount: batchStart,
      target: batchEnd,
      liveCount: batchEnd != null ? Math.min(existingCount, batchEnd) : existingCount,
      status: alreadyCovered ? "done" : "pending",
    });
  }
  return entries;
}

async function runQueueLoop() {
  if (queueRunning) return;
  queueRunning = true;
  queuePaused = false;
  queueStartBtn.disabled = true;
  queueStartBtn.textContent = "Running...";
  queuePauseBtn.hidden = false;
  queuePauseBtn.disabled = false;
  queuePauseBtn.textContent = "Pause queue";

  for (const item of queue) {
    if (item.status !== "pending") continue;
    item.status = "running";
    renderQueue();
    await saveQueue();

    // item.startCount/target stay exactly as buildBatchPlan set them: the
    // stable, batch-relative range shown while this entry was still
    // pending. runJob figures out its own real starting point from the
    // folder itself (it doesn't need ours), so there's nothing to
    // recompute here, only item.liveCount to keep moving as records land,
    // continuing from the same numbers the pending preview already showed
    // instead of resetting to a fresh 0 for this run. item.target is also
    // passed through as the actual stopping point, so this batch always
    // stops at the same absolute line no matter how many times it's been
    // interrupted and resumed, instead of allowing another full batchLimit
    // each time it restarts.
    const { outcome, itemCount } = await runJob(
      item.tags,
      item.options,
      (liveCount) => {
        item.liveCount = liveCount;
        updateQueueRowCount(item);
      },
      item.target,
    );

    item.liveCount = itemCount;
    item.status = queuePaused && outcome !== "done" ? "pending" : outcome;
    renderQueue();
    await saveQueue();

    if (queuePaused || outcome === "cancelled") break;
  }

  queueRunning = false;
  queuePaused = false;
  queueStartBtn.disabled = false;
  queueStartBtn.textContent = "Start queue";
  queuePauseBtn.hidden = true;
}

queueAddBtn.addEventListener("click", async () => {
  const tags = tagsInput.value.trim();
  if (!tags) return;

  queueAddBtn.disabled = true;
  queueAddBtn.textContent = "Adding...";

  const options = {
    excludeTags: getEffectiveExcludeTags(),
    batchLimit: batchLimitInput.value ? Number(batchLimitInput.value) : null,
    includeImages: document.getElementById("includeImages").checked,
    includeVideos: document.getElementById("includeVideos").checked,
    includeJson: document.getElementById("includeJson").checked,
  };

  queue.push(...(await buildBatchPlan(tags, options)));
  renderQueue();
  await saveQueue();
  excludeTagsInput.value = "";
  batchLimitInput.value = "";

  queueAddBtn.disabled = false;
  queueAddBtn.textContent = "Add to queue";
});

queuePauseBtn.addEventListener("click", () => {
  queuePaused = true;
  queuePauseBtn.disabled = true;
  queuePauseBtn.textContent = "Pausing...";
  currentAbortController?.abort();
});

queueClearBtn.addEventListener("click", () => {
  queue = queue.filter((item) => item.status !== "done");
  renderQueue();
  saveQueue();
});

queueStartBtn.addEventListener("click", runQueueLoop);

function renderPreview(records) {
  previewEl.innerHTML = "";
  for (const record of records) {
    const img = document.createElement("img");
    img.src = record.previewUrl || record.sampleUrl;
    img.loading = "lazy";
    img.title = `#${record.id}`;
    previewEl.appendChild(img);
  }
}
