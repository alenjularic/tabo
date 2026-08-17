"use strict";

// Pure candidate selection for the auto-close sweep. No browser APIs.
//
// Closing is the only irreversible thing Tabo does, so the rules are stricter
// than unloading's and every one of them is decided here where it can be tested.
//
// Recovery, verified against SessionStore.sys.mjs: tabs.remove() is recorded
// exactly like a user-initiated close, so Ctrl+Shift+T restores them, and tabs
// closed from inside a tab group are exempt from browser.sessionstore
// .max_tabs_undo (default 25 per window) — "always keep all closed tabs because
// users expect tab groups to be intact". But browser.sessionstore.cleanup
// .forget_closed_after purges the list after 14 days regardless, and a user with
// max_tabs_undo = 0 records nothing at all. So closing is recoverable for a
// fortnight at best, and possibly not at all.

(function (root) {
  const P = root.TaboPlanner;
  const DAY_MS = 86400000;

  // Deliberately long. The shortest is 30 days, matching the longest unload
  // threshold, so closing can never outpace unloading.
  const THRESHOLD_DAYS = [30, 60, 90, 180, 365];

  function isSharing(tab) {
    const s = tab.sharingState;
    return !!(s && (s.camera || s.microphone || s.screen));
  }

  // Returns null when the tab may be closed, otherwise why it was spared.
  //
  // `observingSince` is when auto-close was switched on. A tab is only eligible
  // if it was last active AFTER that moment, which is what proves Tabo watched
  // the whole idle period. lastAccessed survives a restart faithfully, so the
  // timestamp itself is trustworthy — what is not trustworthy is idle time that
  // elapsed before Tabo was watching, and there is no API that can tell the
  // difference (Firefox's own lastSeenActive is chrome-only and explicitly
  // declines to make it). Hence: unobserved tabs are never closed automatically.
  //
  // `manual` skips only that check, for an explicit user-initiated reap where the
  // count is shown first and the user clicks.
  function skipReason(tab, now, options) {
    const { thresholdDays, observingSince, filedIds, manual } = options;

    if (!thresholdDays) return "off";
    if (tab.pinned) return "pinned";
    if (tab.active) return "active";
    if (filedIds && filedIds.has(tab.id)) return "filed";
    if (tab.autoDiscardable === false) return "opted-out";
    if (tab.audible) return "audible";
    if (isSharing(tab)) return "sharing";
    if (!Number.isFinite(tab.lastAccessed)) return "no-timestamp";
    if (now - tab.lastAccessed <= thresholdDays * DAY_MS) return "too-recent";

    if (!manual) {
      if (!Number.isFinite(observingSince)) return "not-observed";
      if (tab.lastAccessed <= observingSince) return "not-observed";
    }
    return null;
  }

  // snapshot is { windowId, tabs, groups } — the same shape the planner takes,
  // so the three-state rules are reused rather than restated. Tabs the user has
  // filed into a group of their own are never closed: filing is a deliberate act.
  function closeCandidates(snapshot, now, options) {
    const parts = P.partition(snapshot);
    const filedIds = new Set(parts.filed.map((t) => t.id));
    const opts = Object.assign({}, options, { filedIds });

    const out = [];
    for (const tab of snapshot.tabs || []) {
      if (skipReason(tab, now, opts) === null) out.push(tab.id);
    }
    return out;
  }

  // What the manual reap button offers: everything past the threshold whether or
  // not Tabo observed it, so the user can clear a backlog on purpose.
  function backlogCandidates(snapshot, now, thresholdDays) {
    return closeCandidates(snapshot, now, { thresholdDays, manual: true });
  }

  root.TaboClose = {
    DAY_MS,
    THRESHOLD_DAYS,
    isSharing,
    skipReason,
    closeCandidates,
    backlogCandidates,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
