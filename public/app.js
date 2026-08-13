import { Store } from "@tauri-apps/plugin-store";
import { open } from "@tauri-apps/plugin-dialog";
import { mkdir, writeFile, writeTextFile, readTextFile, exists, copyFile } from "@tauri-apps/plugin-fs";
import { join, downloadDir } from "@tauri-apps/api/path";
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
const searchBtn = document.getElementById("search-btn");
const searchResultEl = document.getElementById("search-result");
const submitBtn = document.getElementById("submit-btn");
const cancelBtn = document.getElementById("cancel-btn");
const queueAddBtn = document.getElementById("queue-add-btn");
const queueSection = document.getElementById("queue-section");
const queueList = document.getElementById("queue-list");
const queueStartBtn = document.getElementById("queue-start-btn");
const statusEl = document.getElementById("status");
const previewEl = document.getElementById("preview");
const failuresEl = document.getElementById("failures");
const progressTrack = document.getElementById("progress-track");
const progressFill = document.getElementById("progress-fill");
const folderLabel = document.getElementById("folder-label");
const changeFolderBtn = document.getElementById("change-folder");
const editKeyLink = document.getElementById("edit-key");

let downloadRoot = null;
let currentAbortController = null;
let queue = [];
let queueIdCounter = 0;
let queueRunning = false;
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

changeFolderBtn.addEventListener("click", async () => {
  const picked = await open({ directory: true, multiple: false, title: "Choose download folder" });
  if (!picked) return;
  downloadRoot = picked;
  folderLabel.textContent = downloadRoot;
  await store.set("downloadRoot", downloadRoot);
  await store.save();
  await loadGlobalIndex();
});

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
  const queryTags = combineTags(tags, excludeTagsInput.value.trim());

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
async function runJob(tags, { excludeTags, includeImages, includeVideos, includeJson }) {
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

  try {
    const slug = slugifyTags(tags);
    jobFolder = await join(downloadRoot, slug);
    await mkdir(jobFolder, { recursive: true });

    const jsonPath = await join(jobFolder, `${slug}_data.json`);
    const existingRecords = (await exists(jsonPath)) ? JSON.parse(await readTextFile(jsonPath)) : [];
    const seenIds = new Set(existingRecords.map((r) => r.id));
    const allRecords = [...existingRecords];
    itemCount = allRecords.length;
    const previewRecords = [];
    const failures = [];

    const totalCount = await fetchResultCount(queryTags, { userId, apiKey }, signal).catch(() => null);
    const totalPages = totalCount ? Math.ceil(totalCount / RESULTS_PER_PAGE) : null;
    const jobStart = Date.now();

    if (totalPages) {
      progressFill.classList.remove("indeterminate");
      progressFill.style.width = "0%";
    }

    await collectAllResults({
      tags: queryTags,
      credentials: { userId, apiKey },
      alreadySeenIds: seenIds,
      signal,
      onRateLimited: () => {
        statusEl.textContent = `Rate limited by rule34.xxx, retrying in 5s... (${itemCount} items so far)`;
      },
      onRecord: async (record) => {
        allRecords.push(record);
        itemCount = allRecords.length;
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

        if (totalCount) {
          const pct = Math.min(100, Math.round((itemCount / totalCount) * 100));
          progressFill.style.width = `${pct}%`;
          const elapsed = Date.now() - jobStart;
          const eta = (elapsed / itemCount) * Math.max(totalCount - itemCount, 0);
          statusEl.textContent =
            `Fetching "${tags}", ${itemCount}/${totalCount} items (${pct}%)` +
            (itemCount < totalCount ? `, ~${formatDuration(eta)} left...` : "...");
        } else {
          statusEl.textContent = `Fetching "${tags}", ${itemCount} items collected...`;
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
    return "done";
  } catch (err) {
    if (err.name === "AbortError") {
      statusEl.textContent = `Cancelled. ${itemCount} item(s) saved to ${jobFolder}`;
      return "cancelled";
    }
    statusEl.textContent = `Error: ${errorMessage(err)}`;
    console.error(err);
    return "error";
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
  await runJob(tags, {
    excludeTags: excludeTagsInput.value.trim(),
    includeImages: document.getElementById("includeImages").checked,
    includeVideos: document.getElementById("includeVideos").checked,
    includeJson: document.getElementById("includeJson").checked,
  });
});

cancelBtn.addEventListener("click", () => {
  currentAbortController?.abort();
});

function renderQueue() {
  queueSection.hidden = queue.length === 0;
  queueList.innerHTML = "";

  for (const item of queue) {
    const li = document.createElement("li");
    li.className = item.status;

    const tagSpan = document.createElement("span");
    tagSpan.className = "queue-tag";
    tagSpan.textContent = item.tags;

    const countSpan = document.createElement("span");
    countSpan.className = "queue-count";
    countSpan.textContent = item.totalCount != null ? `${item.totalCount} items` : "? items";

    const statusSpan = document.createElement("span");
    statusSpan.className = "queue-status";
    statusSpan.textContent = item.status;

    li.append(tagSpan, countSpan, statusSpan);

    if (item.status === "pending") {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "secondary";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", () => {
        queue = queue.filter((q) => q.id !== item.id);
        renderQueue();
        saveQueue();
      });
      li.append(removeBtn);
    }

    queueList.appendChild(li);
  }
}

queueAddBtn.addEventListener("click", async () => {
  const tags = tagsInput.value.trim();
  if (!tags) return;
  const excludeTags = excludeTagsInput.value.trim();

  queueAddBtn.disabled = true;
  queueAddBtn.textContent = "Adding...";

  const options = {
    excludeTags,
    includeImages: document.getElementById("includeImages").checked,
    includeVideos: document.getElementById("includeVideos").checked,
    includeJson: document.getElementById("includeJson").checked,
  };

  let totalCount = null;
  try {
    const credentials = await store.get("credentials");
    totalCount = await fetchResultCount(combineTags(tags, excludeTags), credentials);
  } catch {
    totalCount = null;
  }

  queue.push({ id: queueIdCounter++, tags, options, totalCount, status: "pending" });
  renderQueue();
  await saveQueue();
  tagsInput.value = "";
  excludeTagsInput.value = "";
  tagsInput.focus();

  queueAddBtn.disabled = false;
  queueAddBtn.textContent = "Add to queue";
});

queueStartBtn.addEventListener("click", async () => {
  if (queueRunning) return;
  queueRunning = true;
  queueStartBtn.disabled = true;
  queueStartBtn.textContent = "Running...";

  for (const item of queue) {
    if (item.status !== "pending") continue;
    item.status = "running";
    renderQueue();
    await saveQueue();

    const outcome = await runJob(item.tags, item.options);
    item.status = outcome;
    renderQueue();
    await saveQueue();

    if (outcome === "cancelled") break;
  }

  queueRunning = false;
  queueStartBtn.disabled = false;
  queueStartBtn.textContent = "Start queue";
});

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
