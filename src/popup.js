"use strict";

const el = (id) => document.getElementById(id);
let current = null;
let canRestoreOrder = false;

function renderThresholds(thresholds, selected) {
  const select = el("threshold");
  while (select.options.length > 1) select.remove(1);
  for (const days of thresholds) {
    const option = document.createElement("option");
    option.value = String(days);
    option.textContent = days === 1 ? "1 day" : days + " days";
    select.appendChild(option);
  }
  select.value = selected === null ? "" : String(selected);
}

const DEPTH_LEVELS = ["days", "weeks", "months", "years"];
const depthEl = (level) => el("depth" + level[0].toUpperCase() + level.slice(1));

// Each level has its own maximum, so the dropdowns have different lengths.
function renderDepthOptions(maxDepth) {
  for (const level of DEPTH_LEVELS) {
    const select = depthEl(level);
    if (select.options.length) continue; // built once
    for (let n = 0; n <= maxDepth[level]; n++) {
      const option = document.createElement("option");
      option.value = String(n);
      option.textContent = String(n);
      select.appendChild(option);
    }
  }
}

// Shows the buckets the current settings would actually produce, so the effect
// of a dropdown is visible before any tabs move.
function renderDepthPreview(depth, labels) {
  // Labels arrive as plain arrays, not functions: this crosses sendMessage and
  // structured clone cannot carry a function.
  const names = labels.days.slice(0, depth.days).concat(labels.weeks.slice(0, depth.weeks));
  if (depth.months) names.push(depth.months === 1 ? "the current month" : depth.months + " months");
  if (depth.years) names.push(depth.years === 1 ? "the current year" : depth.years + " years");
  names.push(labels.older);
  el("depthPreview").textContent = "Groups: " + names.join(" · ");
}

function render(status) {
  current = status.settings;
  canRestoreOrder = !!status.canRestoreOrder;
  renderDepthOptions(status.maxDepth);
  for (const level of DEPTH_LEVELS) {
    depthEl(level).value = String(current.buckets.depth[level]);
    depthEl(level).disabled = !status.hasGroups;
  }
  renderDepthPreview(current.buckets.depth, status.labels);
  el("unsupported").classList.toggle("hidden", status.hasGroups);
  el("bucketsEnabled").checked = current.buckets.enabled;
  el("bucketsEnabled").disabled = !status.hasGroups;
  el("collapseOld").checked = current.buckets.collapseOld;
  el("reorganize").disabled = !status.hasGroups || !current.buckets.enabled;
  renderThresholds(status.thresholds, current.unload.thresholdDays);

  el("undo").disabled = !status.hasGroups;
  el("undoNote").textContent = status.hasGroups
    ? status.canRestoreOrder
      ? "Undo removes Tabo's groups and puts your tabs back in their original order."
      : "Undo removes Tabo's groups. Original tab order is no longer recoverable — that snapshot is lost when Firefox restarts."
    : "";

  el("unloadedCount").textContent = status.unloadedCount
    ? status.unloadedCount + " tabs unloaded since Firefox started"
    : "";

  renderCloseThresholds(status.closeThresholds, current.close.thresholdDays);
  renderCloseState(current.close);
}

function renderCloseThresholds(thresholds, selected) {
  const select = el("closeThreshold");
  if (select.options.length <= 1) {
    for (const days of thresholds) {
      const option = document.createElement("option");
      option.value = String(days);
      option.textContent = days === 365 ? "1 year" : days + " days";
      select.appendChild(option);
    }
  }
  select.value = selected === null ? "" : String(selected);
}

function renderCloseState(close) {
  const on = close.thresholdDays !== null;
  el("closeWarning").classList.toggle("hidden", !on);
  el("closeBacklog").classList.toggle("hidden", true);

  if (!on) {
    el("closeNote").textContent = "";
    return;
  }
  // Say plainly that the backlog is exempt, and when automatic closing starts.
  const startsIn = close.observingSince
    ? Math.max(
        0,
        Math.ceil(
          (close.observingSince + close.thresholdDays * 86400000 - Date.now()) / 86400000
        )
      )
    : close.thresholdDays;
  el("closeNote").textContent =
    "Only tabs Tabo has watched go idle are closed automatically" +
    (startsIn > 0 ? ", so the first can close in " + startsIn + " day(s). " : ". ") +
    "Tabs that were already open before you turned this on are never closed automatically.";

  askBacklog().catch(() => {});
}

// Offers the backlog as an explicit, counted action rather than closing it behind
// the user's back.
async function askBacklog() {
  const report = await browser.runtime.sendMessage({ type: "backlogReport" });
  const button = el("closeBacklog");
  if (!report || !report.count) {
    button.classList.add("hidden");
    return;
  }
  button.textContent = "Close " + report.count + " older tab(s) now";
  button.disabled = false;
  button.classList.remove("hidden");
}

async function refresh() {
  render(await browser.runtime.sendMessage({ type: "status" }));
}

// The stored settings are the source of truth, so the UI follows storage rather
// than trusting a message round-trip to have repainted it. This is what keeps
// the grouping checkbox honest when the background turns it off by itself —
// undo does exactly that.
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    refresh().catch(() => {});
  }
});

// Replaces window.confirm(), which can dismiss the whole popup: the modal takes
// focus and Firefox closes extension panels on focus loss, killing the handler
// mid-await. Resolves true/false from buttons inside the panel instead.
function confirmInPopup(message) {
  return new Promise((resolve) => {
    el("confirmText").textContent = message;
    el("confirmBox").classList.remove("hidden");
    const done = (answer) => {
      el("confirmBox").classList.add("hidden");
      el("confirmYes").removeEventListener("click", yes);
      el("confirmNo").removeEventListener("click", no);
      resolve(answer);
    };
    const yes = () => done(true);
    const no = () => done(false);
    el("confirmYes").addEventListener("click", yes);
    el("confirmNo").addEventListener("click", no);
  });
}

async function save(mutate) {
  const next = JSON.parse(JSON.stringify(current));
  mutate(next);
  const result = await browser.runtime.sendMessage({ type: "save", settings: next });
  current = result.settings;
  await refresh();
}

el("bucketsEnabled").addEventListener("change", async (event) => {
  const enabling = event.target.checked;
  if (enabling && !current.buckets.reorderAcknowledged) {
    // Turning this on is the moment tabs move. Never make that a surprise.
    el("reorderWarning").classList.remove("hidden");
    const ok = await confirmInPopup(
      "Tabo will reorder your tabs into groups by when you last used them. " +
        "Pinned tabs and tabs already in your own groups are left alone."
    );
    if (!ok) {
      event.target.checked = false;
      el("reorderWarning").classList.add("hidden");
      return;
    }
  }
  await save((s) => {
    s.buckets.enabled = enabling;
    if (enabling) s.buckets.reorderAcknowledged = true;
  });
});

el("collapseOld").addEventListener("change", (event) =>
  save((s) => {
    s.buckets.collapseOld = event.target.checked;
  })
);

for (const level of DEPTH_LEVELS) {
  depthEl(level).addEventListener("change", (event) => {
    const value = Number(event.target.value);
    return save((s) => {
      s.buckets.depth[level] = value;
    });
  });
}

el("threshold").addEventListener("change", (event) =>
  save((s) => {
    s.unload.thresholdDays = event.target.value === "" ? null : Number(event.target.value);
  })
);

el("reorganize").addEventListener("click", async () => {
  el("reorganize").disabled = true;
  await browser.runtime.sendMessage({ type: "reorganizeNow" });
  await refresh();
});

el("undo").addEventListener("click", async () => {
  const ok = await confirmInPopup(
    canRestoreOrder
      ? "Remove Tabo's groups and put your tabs back in their original order? This also turns grouping off."
      : "Remove Tabo's groups? Your original tab order cannot be restored — that snapshot is lost when Firefox restarts. This also turns grouping off."
  );
  if (!ok) return;
  el("undo").disabled = true;
  const result = await browser.runtime.sendMessage({ type: "undoGrouping" });
  // Reflect it immediately as well as via storage.onChanged: undo turns grouping
  // off in the background, and the checkbox must never be left claiming it is on.
  el("bucketsEnabled").checked = false;
  el("reorganize").disabled = true;
  await refresh();
  if (result && result.windows === 0) {
    el("undoNote").textContent = "Nothing to undo — no Tabo groups found.";
  }
});

el("closeThreshold").addEventListener("change", async (event) => {
  const value = event.target.value === "" ? null : Number(event.target.value);
  if (value !== null) {
    const ok = await confirmInPopup(
      "Tabo will permanently close tabs you have not used for " +
        value +
        " days. Pinned tabs, tabs in your own groups, and anything playing audio " +
        "or sharing are never closed. Tabs already open before now are never " +
        "closed automatically."
    );
    if (!ok) {
      event.target.value = current.close.thresholdDays === null ? "" : String(current.close.thresholdDays);
      return;
    }
  }
  await save((s) => {
    s.close.thresholdDays = value;
  });
});

el("closeBacklog").addEventListener("click", async () => {
  const label = el("closeBacklog").textContent;
  const ok = await confirmInPopup(
    label.replace("Close", "Permanently close") +
      "? Firefox can reopen them with Ctrl+Shift+T for 14 days, after which they are gone."
  );
  if (!ok) return;
  el("closeBacklog").disabled = true;
  const r = await browser.runtime.sendMessage({ type: "closeBacklog" });
  el("closeNote").textContent = "Closed " + (r ? r.closed : 0) + " tab(s).";
  await refresh();
});

el("exportBtn").addEventListener("click", async () => {
  el("exportBtn").disabled = true;
  try {
    const r = await browser.runtime.sendMessage({ type: "exportSession", stamp: Date.now() });
    el("portableNote").textContent = r.ok
      ? "Exported " + r.tabs + " tabs across " + r.windows + " window(s), " + r.groups + " group(s)."
      : r.error;
  } catch (e) {
    el("portableNote").textContent = "Export failed: " + e;
  }
  el("exportBtn").disabled = false;
});

el("importBtn").addEventListener("click", () => el("importFile").click());

el("importFile").addEventListener("change", async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  event.target.value = ""; // so re-picking the same file fires again

  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (e) {
    el("portableNote").textContent = "That file is not valid JSON.";
    return;
  }

  const ok = await confirmInPopup(
    "Import tabs from " + file.name + "? Each saved window opens as a new window. " +
      "Your current tabs are not touched."
  );
  if (!ok) return;

  el("importBtn").disabled = true;
  try {
    const r = await browser.runtime.sendMessage({ type: "importSession", data });
    if (!r.ok) {
      el("portableNote").textContent = r.error;
    } else {
      // Say out loud what was dropped rather than reporting a clean success.
      const notes = [];
      if (r.skippedTabs) notes.push(r.skippedTabs + " skipped (not a web page)");
      if (r.truncated) notes.push("file truncated at the tab limit");
      el("portableNote").textContent =
        "Imported " + r.tabs + " tabs into " + r.windowsCreated + " window(s)" +
        (notes.length ? " — " + notes.join(", ") : ".");
    }
  } catch (e) {
    el("portableNote").textContent = "Import failed: " + e;
  }
  el("importBtn").disabled = false;
});

el("unloadNow").addEventListener("click", async () => {
  el("unloadNow").disabled = true;
  await browser.runtime.sendMessage({ type: "unloadNow" });
  await refresh();
  el("unloadNow").disabled = false;
});

refresh().catch((e) => {
  document.body.textContent = "Tabo could not start: " + e;
});
