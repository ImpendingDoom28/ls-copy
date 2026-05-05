const META_PREFIX_RE = /^__/;

/* UTILS */
function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function copyText(text) {
  await navigator.clipboard.writeText(text);
}

function setStatus(message, kind = "") {
  const el = $("status");
  el.textContent = message || "";
  el.dataset.kind = kind || "";
}

function stripMetaEntries(obj) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (META_PREFIX_RE.test(k)) continue;
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

function applyKeyRegex(entries, patternRaw, replacementRaw) {
  const pattern = patternRaw.trim();
  if (!pattern) return entries;
  let re;
  try {
    re = new RegExp(pattern, "g");
  } catch (e) {
    throw new Error(`Invalid regex: ${e && e.message ? e.message : String(e)}`);
  }
  const replacement = replacementRaw ?? "";
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(entries)) {
    const nk = k.replace(re, replacement);
    out[nk] = v;
  }
  return out;
}

async function readLocalStorageFromActiveTab() {
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error("No active tab.");
  if (tab.url?.startsWith("chrome://") || tab.url?.startsWith("chrome-extension://")) {
    throw new Error("Cannot access storage on this page URL.");
  }

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: () => Object.fromEntries(Object.entries(window.localStorage)),
  });

  if (!result || typeof result !== "object") {
    throw new Error("Unexpected result reading localStorage.");
  }

  return { tab, snapshot: /** @type {Record<string, string>} */ (result) };
}

async function writeLocalStorageToActiveTab(entries, replace) {
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error("No active tab.");
  if (tab.url?.startsWith("chrome://") || tab.url?.startsWith("chrome-extension://")) {
    throw new Error("Cannot access storage on this page URL.");
  }

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    args: [entries, replace],
    func: (payload, replaceMode) => {
      /** @type {{ key?: string, phase?: string, error: string }[]} */
      const errors = [];

      if (replaceMode) {
        try {
          window.localStorage.clear();
        } catch (e) {
          errors.push({
            phase: "clear",
            error: String(e && e.message ? e.message : e),
          });
        }
      }

      for (const [key, value] of Object.entries(payload)) {
        try {
          window.localStorage.setItem(key, String(value));
        } catch (e) {
          errors.push({
            key,
            error: String(e && e.message ? e.message : e),
          });
        }
      }

      return { errors };
    },
  });

  return /** @type {{ errors: { key?: string, phase?: string, error: string }[] }} */ (result);
}

function buildExportPayload(snapshot, tabUrl) {
  return {
    ...snapshot,
    __meta: {
      exportedAt: new Date().toISOString(),
      origin: tabUrl || "",
      tool: "ls-copy",
    },
  };
}

function downloadJson(filename, text) {
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function selectedImportMode() {
  const sel = document.querySelector('input[name="import-mode"]:checked');
  return sel?.value === "replace" ? "replace" : "merge";
}

async function onExport() {
  setStatus("");
  try {
    const { tab, snapshot } = await readLocalStorageFromActiveTab();
    const payload = buildExportPayload(snapshot, tab.url || "");
    const text = JSON.stringify(payload, null, 2);
    $("export-json").value = text;
    setStatus(`Exported ${Object.keys(snapshot).length} keys from this tab.`);
  } catch (e) {
    setStatus(String(e && e.message ? e.message : e), "error");
  }
}

async function onCopyExport() {
  setStatus("");
  const text = $("export-json").value.trim();
  if (!text) {
    setStatus("Nothing to copy — export first.", "error");
    return;
  }
  try {
    await copyText(text);
    setStatus("Copied JSON to clipboard.");
  } catch (e) {
    setStatus(`Copy failed: ${e && e.message ? e.message : String(e)}`, "error");
  }
}

function onDownloadExport() {
  setStatus("");
  const text = $("export-json").value.trim();
  if (!text) {
    setStatus("Nothing to download — export first.", "error");
    return;
  }
  const stamp = new Date().toISOString().replaceAll(":", "-");
  downloadJson(`localStorage-export-${stamp}.json`, text);
  setStatus("Download started.");
}

function parseImportObject(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON: ${e && e.message ? e.message : String(e)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON must be an object.");
  }
  return /** @type {Record<string, unknown>} */ (parsed);
}

async function onImport() {
  setStatus("");
  const raw = $("import-json").value.trim();
  if (!raw) {
    setStatus("Paste JSON or choose a file first.", "error");
    return;
  }

  try {
    const parsed = parseImportObject(raw);
    let entries = stripMetaEntries(parsed);

    const regexPat = $("key-regex").value;
    const regexRep = $("key-replacement").value;
    entries = applyKeyRegex(entries, regexPat, regexRep);

    const replace = selectedImportMode() === "replace";
    const { errors } = await writeLocalStorageToActiveTab(entries, replace);

    if (errors.length) {
      const preview = errors
        .slice(0, 8)
        .map((x) => (x.key ? `${x.key}: ${x.error}` : `${x.phase}: ${x.error}`))
        .join("\n");
      const more = errors.length > 8 ? `\n… +${errors.length - 8} more` : "";
      setStatus(`Imported with ${errors.length} issue(s):\n${preview}${more}`, "warn");
      return;
    }

    setStatus(`Imported ${Object.keys(entries).length} keys into this tab. Reload the page if the app caches storage.`);
  } catch (e) {
    setStatus(String(e && e.message ? e.message : e), "error");
  }
}

function onImportFileChange(ev) {
  const input = ev.target;
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    $("import-json").value = String(reader.result ?? "");
    setStatus(`Loaded file: ${file.name}`);
  };
  reader.onerror = () => {
    setStatus("Failed to read file.", "error");
  };
  reader.readAsText(file, "utf-8");
}

document.addEventListener("DOMContentLoaded", () => {
  $("btn-export").addEventListener("click", () => {
    void onExport();
  });
  $("btn-copy-export").addEventListener("click", () => {
    void onCopyExport();
  });
  $("btn-download-export").addEventListener("click", onDownloadExport);
  $("btn-import").addEventListener("click", () => {
    void onImport();
  });
  $("import-file").addEventListener("change", onImportFileChange);
});
