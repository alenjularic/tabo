"use strict";

// Export and import of the whole tab session, as JSON. Pure — no browser APIs,
// so every rule here is unit-testable.
//
// Import data is a file the user picked off disk, so it is untrusted input:
// every field is validated or coerced, anything malformed is dropped rather
// than thrown on, and there are hard caps so a huge or hostile file cannot make
// the extension open an unbounded number of tabs.

(function (root) {
  const FORMAT = 1;

  // Same marker the bucket labels use; imported groups have it stripped.
  const MARKER = root.TaboBuckets.MARKER;

  // Only schemes tabs.create will actually accept. ext-tabs.js rejects
  // privileged about: URLs outright ("Illegal URL"), and javascript: must never
  // be resurrected from a file on disk.
  const IMPORTABLE_SCHEMES = ["http:", "https:"];

  const MAX_WINDOWS = 50;
  const MAX_TABS = 10000;
  const MAX_STRING = 2000;

  const VALID_COLORS = [
    "blue",
    "cyan",
    "grey",
    "green",
    "orange",
    "pink",
    "purple",
    "red",
    "yellow",
  ];

  function clip(value) {
    return typeof value === "string" ? value.slice(0, MAX_STRING) : "";
  }

  function isImportableUrl(url) {
    if (typeof url !== "string" || url.length > MAX_STRING) return false;
    // Cheap scheme check rather than a URL parse: the point is to refuse
    // anything that is not plainly http(s), not to normalise.
    const lower = url.toLowerCase();
    return IMPORTABLE_SCHEMES.some((s) => lower.startsWith(s + "//"));
  }

  // Imported groups lose Tabo's clock marker, and this is deliberate.
  //
  // tabs.create cannot set lastAccessed, and a never-selected tab's timestamp is
  // its creation time — so every imported tab reads as brand new no matter how
  // old it was when exported. Restored as a marked bucket, the next reconcile
  // pass would compute "This week" for all of them and merge a whole archive
  // into one group within fifteen minutes.
  //
  // Dropping the marker makes the group the user's own, which Tabo never touches.
  // The archive is preserved exactly as exported, and the user can add the clock
  // back by hand if they want it live again.
  function restoredTitle(title) {
    return title.startsWith(MARKER) ? title.slice(MARKER.length) : title;
  }

  function tabRecord(tab) {
    const record = { url: clip(tab.url), title: clip(tab.title) };
    if (Number.isFinite(tab.lastAccessed)) record.lastAccessed = tab.lastAccessed;
    return record;
  }

  // snapshots: [{ windowId, tabs, groups }] — the same shape the planner takes.
  // Every group is exported, the user's own as well as Tabo's, so the file is a
  // real session backup rather than a Tabo-only artefact.
  function buildExport(snapshots, exportedAt) {
    const windows = [];

    for (const snapshot of snapshots || []) {
      const groupsById = new Map();
      for (const group of snapshot.groups || []) {
        groupsById.set(group.id, {
          title: clip(group.title),
          color: VALID_COLORS.includes(group.color) ? group.color : "grey",
          collapsed: !!group.collapsed,
          tabs: [],
        });
      }

      const loose = [];
      const pinned = [];

      // Tab order within each bucket follows strip order.
      for (const tab of (snapshot.tabs || []).slice().sort((a, b) => a.index - b.index)) {
        const record = tabRecord(tab);
        if (!record.url) continue;
        if (tab.pinned) {
          pinned.push(record);
          continue;
        }
        const group = groupsById.get(tab.groupId);
        if (group) {
          group.tabs.push(record);
        } else {
          loose.push(record);
        }
      }

      // A group with no exportable tabs cannot be recreated — groups cannot be
      // empty in Firefox — so it is dropped rather than written out.
      //
      // Sorted by strip position, derived from the lowest tab index each group
      // holds, so the file preserves left-to-right order: oldest bucket first,
      // the current week last. tabGroups.query() must not be trusted for this —
      // its order is undocumented and only incidentally matches the strip.
      const order = new Map();
      for (const tab of snapshot.tabs || []) {
        if (!groupsById.has(tab.groupId)) continue;
        const at = order.get(tab.groupId);
        if (at === undefined || tab.index < at) order.set(tab.groupId, tab.index);
      }
      const groups = Array.from(groupsById.entries())
        .filter(([, g]) => g.tabs.length)
        .sort((a, b) => (order.get(a[0]) ?? Infinity) - (order.get(b[0]) ?? Infinity))
        .map(([, g]) => g);

      windows.push({ groups, loose, pinned });
    }

    return { tabo: FORMAT, exportedAt: exportedAt || 0, windows };
  }

  // Returns { ok, error } or { ok: true, plan, stats }. The plan is one entry
  // per window to create; stats explain anything dropped, so the UI can say so
  // out loud instead of silently importing less than the file held.
  function planImport(raw) {
    if (!raw || typeof raw !== "object") {
      return { ok: false, error: "Not a Tabo export file." };
    }
    if (raw.tabo !== FORMAT) {
      return {
        ok: false,
        error:
          "Unsupported file format" +
          (raw.tabo === undefined ? "." : " (version " + String(raw.tabo).slice(0, 20) + ")."),
      };
    }
    if (!Array.isArray(raw.windows)) {
      return { ok: false, error: "File has no windows to import." };
    }

    const stats = { tabs: 0, groups: 0, windows: 0, skippedTabs: 0, unmarked: 0, truncated: false };
    const plan = [];

    for (const rawWindow of raw.windows.slice(0, MAX_WINDOWS)) {
      if (!rawWindow || typeof rawWindow !== "object") continue;

      const take = (list) => {
        const out = [];
        for (const entry of Array.isArray(list) ? list : []) {
          if (!entry || typeof entry !== "object") continue;
          if (!isImportableUrl(entry.url)) {
            stats.skippedTabs++;
            continue;
          }
          if (stats.tabs >= MAX_TABS) {
            stats.truncated = true;
            break;
          }
          stats.tabs++;
          out.push({ url: entry.url, title: clip(entry.title) });
        }
        return out;
      };

      const pinned = take(rawWindow.pinned);
      const groups = [];
      for (const rawGroup of Array.isArray(rawWindow.groups) ? rawWindow.groups : []) {
        if (!rawGroup || typeof rawGroup !== "object") continue;
        const tabs = take(rawGroup.tabs);
        if (!tabs.length) continue; // Firefox destroys empty groups on sight
        const title = restoredTitle(clip(rawGroup.title));
        if (title !== clip(rawGroup.title)) stats.unmarked++;
        groups.push({
          title,
          color: VALID_COLORS.includes(rawGroup.color) ? rawGroup.color : "grey",
          collapsed: !!rawGroup.collapsed,
          tabs,
        });
        stats.groups++;
      }
      const loose = take(rawWindow.loose);

      if (!pinned.length && !groups.length && !loose.length) continue;
      plan.push({ pinned, groups, loose });
      stats.windows++;
    }

    if (!plan.length) {
      return { ok: false, error: "Nothing importable in that file.", stats };
    }
    return { ok: true, plan, stats };
  }

  root.TaboPortable = {
    FORMAT,
    MARKER,
    restoredTitle,
    VALID_COLORS,
    IMPORTABLE_SCHEMES,
    MAX_WINDOWS,
    MAX_TABS,
    isImportableUrl,
    buildExport,
    planImport,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
