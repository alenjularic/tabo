"use strict";

// Event-page entry point. Everything decision-shaped lives in the pure modules
// loaded before this one; this file only talks to browser.* and executes plans.
//
// MV3 discipline (Extension.sys.mjs forces persistentBackground:false for any
// manifestVersion > 2, and extensions.background.idle.timeout defaults to 30 s):
//   - every listener is registered synchronously at top level, below
//   - no setTimeout for anything that must survive; alarms only
//   - no in-memory state treated as durable

const B = globalThis.TaboBuckets;
const P = globalThis.TaboPlanner;
const U = globalThis.TaboUnload;
const S = globalThis.TaboSettings;
const Portable = globalThis.TaboPortable;
const Cl = globalThis.TaboClose;

const SWEEP_ALARM = "sweep";
const DWELL_ALARM = "dwell";
const SWEEP_PERIOD_MINUTES = 15;

// tabGroups arrived in Firefox 139 and tabs.group in 138. MDN recommends
// feature detection rather than trusting strict_min_version alone.
const HAS_GROUPS = !!(browser.tabs && browser.tabs.group && browser.tabGroups);

function log(...args) {
  console.log("[tabo]", ...args);
}
function warn(...args) {
  console.warn("[tabo]", ...args);
}

// ---------------------------------------------------------------- strip reads

async function normalWindows() {
  const windows = await browser.windows.getAll({ windowTypes: ["normal"] });
  // Tabo declares no incognito access, so private windows are not ours to touch.
  return windows.filter((w) => !w.incognito);
}

async function snapshotWindow(windowId) {
  // Scoped by windowId deliberately: tabs.query() is O(n) and cross-process
  // (bug 1322869 measured 50 ms at 300 tabs, 72 ms at 500), so a full-profile
  // query on every pass would jank the parent process at high tab counts.
  const tabs = await browser.tabs.query({ windowId });
  // Guarded so export still works on a Firefox without the tabGroups namespace.
  const groups = browser.tabGroups ? await browser.tabGroups.query({ windowId }) : [];
  return { windowId, tabs, groups };
}

async function findGroupIdByTitle(windowId, title) {
  const groups = await browser.tabGroups.query({ windowId });
  const match = groups.find((g) => g.title === title);
  return match ? match.id : null;
}

// ---------------------------------------------------------------- plan execute

async function resolveLabel(windowId, label, resolved) {
  if (resolved.has(label)) return resolved.get(label);
  const id = await findGroupIdByTitle(windowId, label);
  if (id !== null) resolved.set(label, id);
  return id;
}

async function executePlan(windowId, ops) {
  // Labels, not ids: a created group has no id until we make it, and groupId is
  // documented as unstable across restart anyway.
  const resolved = new Map();

  for (const op of ops) {
    try {
      switch (op.op) {
        case "rename": {
          await browser.tabGroups.update(op.groupId, { title: op.label });
          resolved.set(op.label, op.groupId);
          break;
        }
        case "create": {
          // createProperties accepts ONLY windowId — passing title or color
          // throws 'Unexpected property'. Hence the unavoidable two-step, and
          // the brief flash of an untitled auto-coloured group.
          const groupId = await browser.tabs.group({
            tabIds: op.tabIds,
            createProperties: { windowId },
          });
          await browser.tabGroups.update(groupId, {
            title: op.label,
            color: op.color,
            collapsed: op.collapsed,
          });
          resolved.set(op.label, groupId);
          break;
        }
        case "add": {
          const groupId = await resolveLabel(windowId, op.label, resolved);
          if (groupId === null) {
            warn("no group for label, skipping add", op.label);
            break;
          }
          await browser.tabs.group({ tabIds: op.tabIds, groupId });
          break;
        }
        case "style": {
          const groupId = await resolveLabel(windowId, op.label, resolved);
          if (groupId === null) break;
          await browser.tabGroups.update(groupId, {
            color: op.color,
            collapsed: op.collapsed,
          });
          break;
        }
        case "ungroupAll": {
          await browser.tabs.ungroup(op.tabIds);
          break;
        }
        case "restore": {
          for (const move of op.moves) {
            try {
              await browser.tabs.move(move.tabId, { index: move.index });
              // tabs.move() lands a tab inside a group if the index falls
              // within one, silently recruiting it, and fails silently on an
              // illegal index (an unpinned tab cannot go below pinnedTabCount).
              // So verify rather than assume, and evict if adopted.
              const after = await browser.tabs.get(move.tabId);
              if (after.groupId !== undefined && after.groupId !== -1) {
                await browser.tabs.ungroup([move.tabId]);
              }
            } catch (e) {
              warn("restore move failed", move.tabId, String(e));
            }
          }
          break;
        }
        case "order": {
          // Oldest to newest, each appended to the end. index -1 is always a
          // legal target, which avoids absolute-index arithmetic entirely:
          // tabGroups.move throws on an index inside the pinned region or
          // inside another group, and needs a shift correction for rightward
          // moves. Appending in order sidesteps all of it.
          for (const label of op.labels) {
            const groupId = await resolveLabel(windowId, label, resolved);
            if (groupId === null) continue;
            await browser.tabGroups.move(groupId, { index: -1 });
          }
          break;
        }
        default:
          warn("unknown op", op);
      }
    } catch (e) {
      // A pass is idempotent and stateless, so a failed op is simply retried on
      // the next sweep. No compensating logic, no partial-state repair.
      warn("op failed, continuing", op.op, op.label || op.groupId, String(e));
    }
  }
}

// ------------------------------------------------------------------------ undo
//
// Session-scoped by necessity, not by choice: tab ids do not survive a restart,
// so a saved order could not be matched to any tab afterwards. Making undo
// outlive a restart would mean sessions.setTabValue and its extra install
// prompt. After a restart, undo still ungroups — it just cannot restore order.

async function rememberOriginalOrder(windowId, snapshot) {
  const stored = await browser.storage.session.get("originalOrder");
  const all = stored.originalOrder || {};
  // Captured once per window per session, before the first pass that moves
  // anything. Capturing per pass would make undo revert only the last sweep.
  if (all[windowId]) return;
  all[windowId] = P.snapshotOrder(snapshot);
  await browser.storage.session.set({ originalOrder: all });
  log("recorded original order for window", windowId, "-", all[windowId].length, "tabs");
}

async function hasUndo() {
  const stored = await browser.storage.session.get("originalOrder");
  return Object.keys(stored.originalOrder || {}).length > 0;
}

async function undoGrouping() {
  if (!HAS_GROUPS) return { windows: 0, restoredOrder: false };

  const stored = await browser.storage.session.get("originalOrder");
  const all = stored.originalOrder || {};
  let windows = 0;
  let restoredOrder = false;

  for (const win of await normalWindows()) {
    try {
      const snapshot = await snapshotWindow(win.id);
      const ops = P.planUndo(snapshot, all[win.id] || null);
      if (!ops.length) continue;
      log("window", win.id, "undo:", ops.map((o) => o.op).join(", "));
      if (ops.some((o) => o.op === "restore")) restoredOrder = true;
      await executePlan(win.id, ops);
      windows++;
    } catch (e) {
      warn("undo failed for window", win.id, String(e));
    }
  }

  await browser.storage.session.remove("originalOrder");

  // Turn bucketing off, or the next sweep immediately regroups everything the
  // undo just took apart. Saved directly rather than through the save message,
  // which would kick off a fresh pass.
  const settings = await S.loadSettings();
  settings.buckets.enabled = false;
  await S.saveSettings(settings);

  return { windows, restoredOrder };
}

async function reconcileWindow(windowId, settings) {
  const snapshot = await snapshotWindow(windowId);
  const ops = P.planWindow(snapshot, Date.now(), {
    collapseOld: settings.buckets.collapseOld,
    depth: settings.buckets.depth,
    locale: browser.i18n ? browser.i18n.getUILanguage() : undefined,
  });
  if (!ops.length) return 0;
  await rememberOriginalOrder(windowId, snapshot);
  log("window", windowId, "plan:", ops.map((o) => o.op + ":" + (o.label || o.groupId)).join(", "));
  await executePlan(windowId, ops);
  return ops.length;
}

async function reconcileAll(settings) {
  if (!HAS_GROUPS || !settings.buckets.enabled) return 0;
  let total = 0;
  for (const win of await normalWindows()) {
    try {
      total += await reconcileWindow(win.id, settings);
    } catch (e) {
      warn("reconcile failed for window", win.id, String(e));
    }
  }
  return total;
}

// -------------------------------------------------------------------- unloading

async function unloadBatch(tabIds) {
  if (!tabIds.length) return;
  try {
    // discard() accepts an array, but a single invalid id rejects the whole
    // call and discards nothing — getNativeTabsFromIDArray resolves every id
    // before any discard runs. So fall back to one at a time on rejection.
    await browser.tabs.discard(tabIds);
  } catch (e) {
    warn("batch discard rejected, falling back to per-tab", String(e));
    for (const id of tabIds) {
      try {
        await browser.tabs.discard(id);
      } catch (inner) {
        // Expected for a tab closed between query and discard.
      }
    }
  }
}

async function unloadSweep(settings) {
  const threshold = settings.unload.thresholdDays;
  if (!threshold) return;

  for (const win of await normalWindows()) {
    try {
      // Queried immediately before discarding so the ids are fresh.
      const tabs = await browser.tabs.query({ windowId: win.id });

      // Ignored tabs are also shielded from Firefox's own unloader.
      for (const tab of tabs) {
        if (tab.pinned && tab.autoDiscardable !== false) {
          try {
            await browser.tabs.update(tab.id, { autoDiscardable: false });
          } catch (e) {
            /* tab may have closed */
          }
        }
      }

      const candidates = U.selectUnloadCandidates(tabs, Date.now(), threshold);
      if (candidates.length) {
        log("unloading", candidates.length, "tabs in window", win.id);
        await unloadBatch(candidates);
      }
    } catch (e) {
      warn("unload sweep failed for window", win.id, String(e));
    }
  }
}

// --------------------------------------------------------- export and import

async function exportSession(stamp) {
  const snapshots = [];
  for (const win of await normalWindows()) {
    snapshots.push(await snapshotWindow(win.id));
  }
  const data = Portable.buildExport(snapshots, stamp);
  const json = JSON.stringify(data, null, 2);

  // Blob and URL.createObjectURL exist here because Firefox MV3 uses an event
  // *page*, not a service worker. This would need a different approach on Chrome.
  const blobUrl = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const filename = "tabo-session-" + new Date(stamp).toISOString().slice(0, 10) + ".json";

  try {
    const id = await browser.downloads.download({ url: blobUrl, filename, saveAs: true });
    const release = (delta) => {
      if (delta.id !== id || !delta.state || delta.state.current === "in_progress") return;
      URL.revokeObjectURL(blobUrl);
      browser.downloads.onChanged.removeListener(release);
    };
    browser.downloads.onChanged.addListener(release);
  } catch (e) {
    // Cancelling the Save dialog rejects. Not an error worth shouting about.
    URL.revokeObjectURL(blobUrl);
    return { ok: false, error: "Export cancelled." };
  }

  let tabs = 0;
  let groups = 0;
  for (const w of data.windows) {
    tabs += w.pinned.length + w.loose.length;
    groups += w.groups.length;
    for (const g of w.groups) tabs += g.tabs.length;
  }
  return { ok: true, windows: data.windows.length, tabs, groups };
}

// title is only accepted alongside discarded:true, and discarded requires
// active:false — which is exactly what we want. Restoring a few hundred tabs
// costs no content processes, no network and no memory, and each tab still shows
// its real saved title. Loading them all would defeat the whole extension.
async function createRestoredTab(windowId, record) {
  const create = { windowId, url: record.url, active: false, discarded: true };
  if (record.title) create.title = record.title;
  return browser.tabs.create(create);
}

async function importSession(raw) {
  const planned = Portable.planImport(raw);
  if (!planned.ok) return { ok: false, error: planned.error };

  let windowsCreated = 0;
  for (const spec of planned.plan) {
    try {
      const win = await browser.windows.create({});
      const blanks = (await browser.tabs.query({ windowId: win.id })).map((t) => t.id);

      for (const record of spec.pinned) {
        const tab = await createRestoredTab(win.id, record);
        // Pinning may force a load: Firefox never leaves a pinned tab lazy.
        await browser.tabs.update(tab.id, { pinned: true });
      }

      for (const group of spec.groups) {
        const ids = [];
        for (const record of group.tabs) {
          ids.push((await createRestoredTab(win.id, record)).id);
        }
        if (HAS_GROUPS && ids.length) {
          const groupId = await browser.tabs.group({
            tabIds: ids,
            createProperties: { windowId: win.id },
          });
          await browser.tabGroups.update(groupId, {
            title: group.title,
            color: group.color,
            collapsed: group.collapsed,
          });
        }
      }

      for (const record of spec.loose) {
        await createRestoredTab(win.id, record);
      }

      // Drop the blank tab the new window opened with. Firefox then activates
      // one restored tab, which loads it — one page load for the whole import.
      if (blanks.length) await browser.tabs.remove(blanks);
      windowsCreated++;
    } catch (e) {
      warn("import failed for one window", String(e));
    }
  }

  return { ok: true, windowsCreated, ...planned.stats };
}

// -------------------------------------------------------------------- closing
//
// The only irreversible thing Tabo does. Recovery, verified in
// SessionStore.sys.mjs: tabs.remove() is recorded exactly as a user close, and
// tabs closed from inside a tab group are exempt from max_tabs_undo (25 per
// window) because "users expect tab groups to be intact" — so Ctrl+Shift+T
// works even for a large sweep. But cleanup.forget_closed_after purges the list
// after 14 days, and a user with max_tabs_undo = 0 records nothing at all.

async function closeTabs(tabIds) {
  if (!tabIds.length) return 0;
  try {
    await browser.tabs.remove(tabIds);
    return tabIds.length;
  } catch (e) {
    // One dead id can sink a batch, as with discard. Fall back per tab so the
    // rest still close.
    warn("batch close rejected, falling back per tab", String(e));
    let n = 0;
    for (const id of tabIds) {
      try {
        await browser.tabs.remove(id);
        n++;
      } catch (inner) {
        /* closed between query and remove */
      }
    }
    return n;
  }
}

async function closeSweep(settings) {
  const { thresholdDays, observingSince } = settings.close;
  if (!thresholdDays || !observingSince) return 0;

  let closed = 0;
  for (const win of await normalWindows()) {
    try {
      // Queried immediately before removing so the ids are fresh.
      const snapshot = await snapshotWindow(win.id);
      const ids = Cl.closeCandidates(snapshot, Date.now(), { thresholdDays, observingSince });
      if (!ids.length) continue;
      log("closing", ids.length, "tabs idle over", thresholdDays, "days in window", win.id);
      closed += await closeTabs(ids);
    } catch (e) {
      warn("close sweep failed for window", win.id, String(e));
    }
  }
  return closed;
}

// The backlog: tabs whose idle time predates Tabo, which the automatic sweep
// will never touch. Counted for display, and only closed on an explicit click.
async function backlogReport(thresholdDays) {
  if (!thresholdDays) return { count: 0, thresholdDays: null };
  let count = 0;
  for (const win of await normalWindows()) {
    try {
      const snapshot = await snapshotWindow(win.id);
      count += Cl.backlogCandidates(snapshot, Date.now(), thresholdDays).length;
    } catch (e) {
      warn("backlog count failed for window", win.id, String(e));
    }
  }
  return { count, thresholdDays };
}

async function closeBacklog(thresholdDays) {
  if (!thresholdDays) return { closed: 0 };
  let closed = 0;
  for (const win of await normalWindows()) {
    try {
      const snapshot = await snapshotWindow(win.id);
      const ids = Cl.backlogCandidates(snapshot, Date.now(), thresholdDays);
      if (!ids.length) continue;
      log("closing backlog:", ids.length, "tabs in window", win.id);
      closed += await closeTabs(ids);
    } catch (e) {
      warn("backlog close failed for window", win.id, String(e));
    }
  }
  return { closed };
}

// ------------------------------------------------------------------- scheduling

async function armAlarms() {
  // Firefox alarms live in an in-memory Map with live nsITimers and are cleared
  // by onShutdown — they do NOT survive a browser restart. Re-arm every time.
  // delayInMinutes is set explicitly because specifying only periodInMinutes
  // puts the first fire one full period out.
  await browser.alarms.create(SWEEP_ALARM, {
    delayInMinutes: 1,
    periodInMinutes: SWEEP_PERIOD_MINUTES,
  });
}

async function onSweep() {
  const settings = await S.loadSettings();
  await reconcileAll(settings);
  await unloadSweep(settings);
  await closeSweep(settings);
}

async function onDwell() {
  const settings = await S.loadSettings();
  if (!HAS_GROUPS || !settings.buckets.enabled) return;

  const stored = await browser.storage.session.get("pendingActivation");
  const pending = stored && stored.pendingActivation;
  if (!pending) return;
  await browser.storage.session.remove("pendingActivation");

  let tab = null;
  try {
    tab = await browser.tabs.get(pending.tabId);
  } catch (e) {
    return; // closed during the dwell window
  }
  // Still the tab the user landed on? If they moved on, that activation was
  // transit, not use, and the newer activation has its own alarm.
  if (!tab || !tab.active) return;

  // A full reconcile is exactly right here and needs no special case: the
  // active tab reports Date.now() for lastAccessed, so it targets the current
  // week, and the planner moves only what actually changed.
  await reconcileWindow(tab.windowId, settings);
}

// -------------------------------------------------------------------- listeners
// All registered synchronously at top level so the event page can be revived.

browser.runtime.onInstalled.addListener(() => {
  armAlarms().then(onSweep).catch((e) => warn("onInstalled", String(e)));
});

browser.runtime.onStartup.addListener(() => {
  armAlarms().then(onSweep).catch((e) => warn("onStartup", String(e)));
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SWEEP_ALARM) {
    onSweep().catch((e) => warn("sweep", String(e)));
  } else if (alarm.name === DWELL_ALARM) {
    onDwell().catch((e) => warn("dwell", String(e)));
  }
});

browser.tabs.onActivated.addListener((info) => {
  (async () => {
    const settings = await S.loadSettings();
    if (!HAS_GROUPS || !settings.buckets.enabled) return;
    await browser.storage.session.set({
      pendingActivation: { tabId: info.tabId, windowId: info.windowId, at: Date.now() },
    });
    // Creating an alarm with an existing name replaces it, which is what gives
    // 'only the tab you land on' for free. Firefox applies no minimum period —
    // ext-alarms.js passes minutes straight to an nsITimer — so a sub-second
    // delay is legitimate here, unlike on Chrome.
    await browser.alarms.create(DWELL_ALARM, {
      delayInMinutes: settings.buckets.dwellMs / 60000,
    });
  })().catch((e) => warn("onActivated", String(e)));
});

// The only honest source of 'what actually got unloaded': tabs.discard()'s
// promise fulfils even when nothing was discarded.
browser.tabs.onUpdated.addListener(
  (tabId, changeInfo) => {
    if (changeInfo.discarded === true) {
      browser.storage.session
        .get("unloadedCount")
        .then((s) => browser.storage.session.set({ unloadedCount: (s.unloadedCount || 0) + 1 }))
        .catch(() => {});
    }
  },
  { properties: ["discarded"] }
);

browser.runtime.onMessage.addListener((message) => {
  switch (message && message.type) {
    case "status":
      return (async () => {
        const settings = await S.loadSettings();
        const session = await browser.storage.session.get("unloadedCount");
        return {
          settings,
          hasGroups: HAS_GROUPS,
          unloadedCount: session.unloadedCount || 0,
          thresholds: U.THRESHOLD_DAYS,
          closeThresholds: Cl.THRESHOLD_DAYS,
          canRestoreOrder: await hasUndo(),
          maxDepth: B.MAX_DEPTH,
          // Plain arrays, not functions: structured clone cannot carry a
          // function across sendMessage.
          labels: {
            days: Array.from({ length: B.MAX_DEPTH.days }, (_, i) => B.dayLabel(i)),
            weeks: Array.from({ length: B.MAX_DEPTH.weeks }, (_, i) => B.weekLabel(i)),
            older: B.OLDER,
          },
        };
      })();
    case "save":
      return (async () => {
        const previous = await S.loadSettings();
        const next = message.settings;
        // Stamp the moment auto-close is switched on. From then until a tab has
        // been idle a full threshold *since this instant*, nothing is eligible —
        // which is what makes enabling the feature incapable of reaping a
        // backlog. Raising or lowering the threshold later does not reset it,
        // because the observation is still valid; turning it off clears it, so
        // re-enabling restarts the guarantee.
        if (next && next.close && next.close.thresholdDays) {
          next.close.observingSince =
            previous.close.thresholdDays && previous.close.observingSince
              ? previous.close.observingSince
              : Date.now();
        }
        const settings = await S.saveSettings(next);
        await armAlarms();
        await onSweep();
        return { settings };
      })();
    case "reorganizeNow":
      return (async () => {
        const settings = await S.loadSettings();
        const changed = await reconcileAll(settings);
        return { changed };
      })();
    case "undoGrouping":
      return undoGrouping();
    case "exportSession":
      // Date.now() comes from the caller so the stamp is decided in one place.
      return exportSession(message.stamp || Date.now());
    case "importSession":
      return importSession(message.data);
    case "backlogReport":
      return (async () => {
        const settings = await S.loadSettings();
        return backlogReport(settings.close.thresholdDays);
      })();
    case "closeBacklog":
      return (async () => {
        const settings = await S.loadSettings();
        return closeBacklog(settings.close.thresholdDays);
      })();
    case "unloadNow":
      return (async () => {
        const settings = await S.loadSettings();
        await unloadSweep(settings);
        return { ok: true };
      })();
    default:
      return undefined;
  }
});

log("loaded; tab groups", HAS_GROUPS ? "available" : "unavailable");
