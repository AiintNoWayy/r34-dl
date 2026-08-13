import { Store } from "@tauri-apps/plugin-store";
import { open } from "@tauri-apps/plugin-dialog";
import { mkdir, writeFile, writeTextFile, readTextFile, exists } from "@tauri-apps/plugin-fs";
import { join, downloadDir } from "@tauri-apps/api/path";
import {
  slugifyTags,
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
const uploaderResultEl = document.getElementById("uploader-result");

const jobForm = document.getElementById("job-form");
const tagsInput = document.getElementById("tags");
const searchBtn = document.getElementById("search-btn");
const searchResultEl = document.getElementById("search-result");
const submitBtn = document.getElementById("submit-btn");
const cancelBtn = document.getElementById("cancel-btn");
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

async function getDefaultDownloadRoot() {
  const saved = await store.get("downloadRoot");
  if (saved) return saved;
  return join(await downloadDir(), "r34-dl");
}

async function showMainView() {
  setupView.hidden = true;
  mainView.hidden = false;
  downloadRoot = await getDefaultDownloadRoot();
  folderLabel.textContent = downloadRoot;
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

changeFolderBtn.addEventListener("click", async () => {
  const picked = await open({ directory: true, multiple: false, title: "Choose download folder" });
  if (!picked) return;
  downloadRoot = picked;
  folderLabel.textContent = downloadRoot;
  await store.set("downloadRoot", downloadRoot);
  await store.save();
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

  searchBtn.disabled = true;
  submitBtn.disabled = true;
  searchBtn.textContent = "Searching...";
  searchResultEl.classList.remove("error");
  searchResultEl.textContent = "";
  previewEl.innerHTML = "";

  try {
    const credentials = await store.get("credentials");
    const { totalCount, records } = await searchPreview(tags, credentials);
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

jobForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  previewEl.innerHTML = "";
  failuresEl.innerHTML = "";
  progressTrack.classList.add("visible");
  progressFill.classList.add("indeterminate");
  progressFill.style.width = "";

  const tags = tagsInput.value.trim();
  const includeImages = document.getElementById("includeImages").checked;
  const includeVideos = document.getElementById("includeVideos").checked;
  const includeJson = document.getElementById("includeJson").checked;
  if (!tags) return;

  const { userId, apiKey } = await store.get("credentials");

  currentAbortController = new AbortController();
  const { signal } = currentAbortController;

  submitBtn.disabled = true;
  searchBtn.disabled = true;
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

    const totalCount = await fetchResultCount(tags, { userId, apiKey }, signal).catch(() => null);
    const totalPages = totalCount ? Math.ceil(totalCount / RESULTS_PER_PAGE) : null;
    const jobStart = Date.now();

    if (totalPages) {
      progressFill.classList.remove("indeterminate");
      progressFill.style.width = "0%";
    }

    await collectAllResults({
      tags,
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
            if (!(await exists(filePath))) {
              await mkdir(dir, { recursive: true });
              await writeFile(filePath, await downloadBinary(record.src, signal));
            }
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
  } catch (err) {
    if (err.name === "AbortError") {
      statusEl.textContent = `Cancelled. ${itemCount} item(s) saved to ${jobFolder}`;
    } else {
      statusEl.textContent = `Error: ${errorMessage(err)}`;
      console.error(err);
    }
  } finally {
    submitBtn.disabled = false;
    searchBtn.disabled = false;
    cancelBtn.hidden = true;
    currentAbortController = null;
  }
});

cancelBtn.addEventListener("click", () => {
  currentAbortController?.abort();
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
