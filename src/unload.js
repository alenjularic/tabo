"use strict";

// Pure candidate selection for the unload sweep. No browser APIs.
//
// tabs.discard() is blunter than Firefox's own unloader: _mayDiscardBrowser has
// no pinned, audible, Picture-in-Picture or WebRTC guard, and discardBrowser()
// calls resetBrowserSharing() and webrtcUI.forgetStreamsFromBrowserContext().
// Without rebuilding the exclusion list here, an automatic sweep would cut off
// music, video calls and screen sharing. The API reports none of this — a
// skipped tab still fulfils the promise — so every exclusion has to be decided
// before the call.

(function (root) {
  const DAY_MS = 86400000;

  // Offered thresholds, in days. The floor is deliberately days rather than
  // minutes: there is no Picture-in-Picture signal exposed to extensions
  // (Firefox checks tab.pictureinpicture internally and no tabs.Tab property
  // mirrors it), so that one exclusion cannot be replicated and the safety
  // margin has to come from the threshold instead.
  const THRESHOLD_DAYS = [2, 3, 7, 14, 30];

  function isSharing(tab) {
    const s = tab.sharingState;
    if (!s) return false;
    return !!(s.camera || s.microphone || s.screen);
  }

  // Returns null when the tab should be unloaded, otherwise the reason it was
  // spared. Named reasons make the exclusions individually testable.
  function skipReason(tab, now, thresholdDays) {
    if (tab.pinned) return "pinned";
    if (tab.active) return "active";
    if (tab.discarded) return "already-discarded";
    if (tab.autoDiscardable === false) return "opted-out";
    if (tab.audible) return "audible";
    if (isSharing(tab)) return "sharing";
    if (!Number.isFinite(tab.lastAccessed)) return "no-timestamp";
    if (now - tab.lastAccessed <= thresholdDays * DAY_MS) return "too-recent";
    return null;
  }

  function selectUnloadCandidates(tabs, now, thresholdDays) {
    if (!thresholdDays) return []; // null or 0 means the feature is off
    const out = [];
    for (const tab of tabs || []) {
      if (skipReason(tab, now, thresholdDays) === null) {
        out.push(tab.id);
      }
    }
    return out;
  }

  root.TaboUnload = {
    DAY_MS,
    THRESHOLD_DAYS,
    isSharing,
    skipReason,
    selectUnloadCandidates,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
