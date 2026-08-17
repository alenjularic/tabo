"use strict";

// Settings are the only thing Tabo persists. Bucket state is derived from the
// strip on every pass, so losing storage.local costs the user their preferences
// and nothing else — which is why unlimitedStorage is not requested even though
// storage.local is best-effort and evictable.

(function (root) {
  const DEFAULTS = {
    version: 1,
    buckets: {
      enabled: false,
      collapseOld: true,
      dwellMs: 1500,
      // Set once the user has acknowledged that enabling reorders their tabs.
      reorderAcknowledged: false,
      // How far back each granularity reaches. 0 disables a level and the next
      // coarser one absorbs its span; anything past the deepest level goes to
      // a single "Older" bucket.
      depth: { days: 0, weeks: 2, months: 3, years: 3 },
    },
    unload: {
      thresholdDays: null, // null means off; choosing a threshold is the opt-in
    },
    close: {
      thresholdDays: null, // null means off
      // When auto-close was switched on. Tabs last active before this are never
      // closed automatically, because Tabo cannot vouch for idle time it did not
      // observe. Cleared when the feature is turned off, so re-enabling restarts
      // the guarantee rather than inheriting a stale one.
      observingSince: null,
    },
  };

  // Pure, so it can be tested without storage. Unknown keys in stored data are
  // dropped rather than carried forward, and a malformed section falls back to
  // its defaults instead of poisoning the whole object.
  function mergeSettings(stored) {
    const s = stored && typeof stored === "object" ? stored : {};
    const buckets = s.buckets && typeof s.buckets === "object" ? s.buckets : {};
    const unload = s.unload && typeof s.unload === "object" ? s.unload : {};

    const threshold = unload.thresholdDays;
    const validThreshold =
      typeof threshold === "number" && root.TaboUnload.THRESHOLD_DAYS.includes(threshold)
        ? threshold
        : null;

    const dwell = buckets.dwellMs;
    const validDwell = typeof dwell === "number" && dwell >= 0 && dwell <= 60000
      ? dwell
      : DEFAULTS.buckets.dwellMs;

    return {
      version: DEFAULTS.version,
      buckets: {
        enabled: buckets.enabled === true,
        collapseOld: buckets.collapseOld !== false,
        dwellMs: validDwell,
        reorderAcknowledged: buckets.reorderAcknowledged === true,
        // Clamped and defaulted in one place, so a hand-edited or corrupted
        // value can never make the label function produce nonsense.
        depth: root.TaboBuckets.normalizeDepth(buckets.depth),
      },
      unload: {
        thresholdDays: validThreshold,
      },
      close: closeSection(s.close),
    };
  }

  function closeSection(raw) {
    const c = raw && typeof raw === "object" ? raw : {};
    const days =
      typeof c.thresholdDays === "number" && root.TaboClose.THRESHOLD_DAYS.includes(c.thresholdDays)
        ? c.thresholdDays
        : null;
    // A corrupted or absent observingSince must read as "never observed", which
    // makes every tab ineligible for automatic closing. Failing closed matters
    // here: the alternative is closing tabs whose idle time we cannot vouch for.
    const since =
      Number.isFinite(c.observingSince) && c.observingSince > 0 ? c.observingSince : null;
    return { thresholdDays: days, observingSince: days === null ? null : since };
  }

  async function loadSettings() {
    const stored = await root.browser.storage.local.get("settings");
    return mergeSettings(stored && stored.settings);
  }

  async function saveSettings(next) {
    const clean = mergeSettings(next);
    await root.browser.storage.local.set({ settings: clean });
    return clean;
  }

  root.TaboSettings = { DEFAULTS, mergeSettings, loadSettings, saveSettings };
})(typeof globalThis !== "undefined" ? globalThis : self);
