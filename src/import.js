"use strict";

// Import runs on its own page rather than in the popup because Firefox dismisses
// an extension panel as soon as a file picker takes focus — bug 1378527 and
// friends, still open. Mozilla's documented workaround is exactly this: put the
// file input on an extension page that is not a popup.
//
// Being a real page also buys a preview: the same validation the background will
// run is applied here first, so the file's contents are shown before anything is
// created.

const el = (id) => document.getElementById(id);
const T = globalThis.TaboPortable;

let planned = null;

function row(label, value) {
  const tr = document.createElement("tr");
  const a = document.createElement("td");
  a.textContent = label;
  const b = document.createElement("td");
  b.textContent = String(value);
  tr.append(a, b);
  return tr;
}

function showError(message) {
  el("fileError").textContent = message;
  el("fileError").classList.remove("hidden");
  el("preview").classList.add("hidden");
  planned = null;
}

el("file").addEventListener("change", async (event) => {
  const file = event.target.files && event.target.files[0];
  el("fileError").classList.add("hidden");
  el("done").classList.add("hidden");
  if (!file) return;

  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (e) {
    showError("That file is not valid JSON.");
    return;
  }

  const result = T.planImport(data);
  if (!result.ok) {
    showError(result.error);
    return;
  }

  planned = data;
  const counts = el("counts");
  counts.textContent = "";
  counts.append(
    row("File", file.name),
    row("Windows", result.stats.windows),
    row("Groups", result.stats.groups),
    row("Tabs", result.stats.tabs)
  );

  // Anything the file contained but cannot be restored is stated up front,
  // rather than quietly importing less than the user expects.
  const notes = [];
  if (result.stats.skippedTabs) {
    notes.push(
      result.stats.skippedTabs +
        " entries will be skipped because only http and https pages can be reopened."
    );
  }
  if (result.stats.truncated) {
    notes.push("The file is larger than the " + T.MAX_TABS + " tab limit and will be truncated.");
  }
  el("dropped").textContent = notes.join(" ");
  el("dropped").classList.toggle("hidden", notes.length === 0);

  el("preview").classList.remove("hidden");
  el("go").disabled = false;
});

el("go").addEventListener("click", async () => {
  if (!planned) return;
  el("go").disabled = true;
  el("go").textContent = "Importing…";

  try {
    const r = await browser.runtime.sendMessage({ type: "importSession", data: planned });
    if (!r || !r.ok) {
      showError((r && r.error) || "Import failed.");
      el("go").textContent = "Import";
      el("go").disabled = false;
      return;
    }
    const parts = ["Imported " + r.tabs + " tabs into " + r.windowsCreated + " new window(s)."];
    if (r.skippedTabs) parts.push(r.skippedTabs + " entries were skipped.");
    if (r.truncated) parts.push("The file was truncated at the tab limit.");
    el("result").textContent = parts.join(" ");
    el("done").classList.remove("hidden");
    el("preview").classList.add("hidden");
  } catch (e) {
    showError("Import failed: " + e);
    el("go").textContent = "Import";
    el("go").disabled = false;
  }
});
