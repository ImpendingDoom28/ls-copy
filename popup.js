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

/** @type {ReturnType<typeof setTimeout> | null} */
let toastHideTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let toastClearTimer = null;

function showToast(message, durationMs = 2300) {
  const el = $("toast");
  if (toastHideTimer !== null) clearTimeout(toastHideTimer);
  if (toastClearTimer !== null) clearTimeout(toastClearTimer);
  el.textContent = message;
  requestAnimationFrame(() => {
    el.classList.add("toast--visible");
  });
  toastHideTimer = setTimeout(() => {
    toastHideTimer = null;
    el.classList.remove("toast--visible");
    toastClearTimer = setTimeout(() => {
      toastClearTimer = null;
      el.textContent = "";
    }, 200);
  }, durationMs);
}

async function copyText(text) {
  await navigator.clipboard.writeText(text);
  showToast("Copied to clipboard");
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
    const keyCount = Object.keys(snapshot).length;
    $("export-json").value = text;
    try {
      await copyText(text);
    } catch (copyErr) {
      const msg = copyErr && copyErr.message ? copyErr.message : String(copyErr);
      setStatus(`Exported ${keyCount} keys, but copy failed: ${msg}`, "error");
    }
  } catch (e) {
    setStatus(String(e && e.message ? e.message : e), "error");
  }
}

function syncPayloadPanelToggle() {
  const panel = $("payload-panel");
  const btn = $("btn-toggle-payload");
  const open = !panel.hidden;
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  btn.textContent = open ? "Hide payload" : "View payload";
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
  let raw;
  try {
    raw = (await navigator.clipboard.readText()).trim();
  } catch (e) {
    const name = e && e.name ? e.name : "";
    if (name === "NotAllowedError") {
      setStatus("Clipboard read was blocked. Allow clipboard access for this extension.", "error");
      return;
    }
    setStatus(String(e && e.message ? e.message : e), "error");
    return;
  }

  if (!raw) {
    setStatus("Clipboard is empty. Export from the source tab first (copies JSON to the clipboard).", "error");
    return;
  }

  try {
    const parsed = parseImportObject(raw);
    const entries = stripMetaEntries(parsed);

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

document.addEventListener("DOMContentLoaded", () => {
  $("btn-export").addEventListener("click", () => {
    void onExport();
  });
  $("btn-toggle-payload").addEventListener("click", () => {
    const panel = $("payload-panel");
    panel.hidden = !panel.hidden;
    syncPayloadPanelToggle();
  });
  $("btn-import").addEventListener("click", () => {
    void onImport();
  });
});
