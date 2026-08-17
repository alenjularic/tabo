"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../src/unload.js");
const U = globalThis.TaboUnload;

const NOW = new Date(2026, 7, 17, 12).getTime();
const DAY = U.DAY_MS;

let nextId = 1;
function tab(props) {
  return Object.assign(
    {
      id: nextId++,
      pinned: false,
      active: false,
      discarded: false,
      audible: false,
      autoDiscardable: true,
      lastAccessed: NOW - 30 * DAY,
    },
    props
  );
}

test("a long-idle background tab is a candidate", () => {
  const t = tab({});
  assert.equal(U.skipReason(t, NOW, 7), null);
  assert.deepEqual(U.selectUnloadCandidates([t], NOW, 7), [t.id]);
});

test("the feature is off when no threshold is set", () => {
  const t = tab({});
  assert.deepEqual(U.selectUnloadCandidates([t], NOW, null), [], "null means off");
  assert.deepEqual(U.selectUnloadCandidates([t], NOW, 0), [], "zero means off, not unload-everything");
  assert.deepEqual(U.selectUnloadCandidates([t], NOW, undefined), []);
});

test("pinned tabs are exempt because pinning is the ignore gesture", () => {
  assert.equal(U.skipReason(tab({ pinned: true }), NOW, 7), "pinned");
});

test("the active tab is never a candidate", () => {
  // Firefox refuses to discard it anyway, and does so silently.
  assert.equal(U.skipReason(tab({ active: true }), NOW, 7), "active");
});

test("an already discarded tab is skipped rather than re-discarded", () => {
  assert.equal(U.skipReason(tab({ discarded: true }), NOW, 7), "already-discarded");
});

test("autoDiscardable false is respected as the per-tab opt-out", () => {
  assert.equal(U.skipReason(tab({ autoDiscardable: false }), NOW, 7), "opted-out");
  assert.equal(U.skipReason(tab({ autoDiscardable: true }), NOW, 7), null);
  assert.equal(
    U.skipReason(tab({ autoDiscardable: undefined }), NOW, 7),
    null,
    "absent means not opted out"
  );
});

test("a tab producing sound is never unloaded", () => {
  assert.equal(U.skipReason(tab({ audible: true }), NOW, 7), "audible");
});

test("camera, microphone and screen sharing each spare a tab", () => {
  for (const key of ["camera", "microphone", "screen"]) {
    const t = tab({ sharingState: { [key]: true } });
    assert.equal(U.skipReason(t, NOW, 7), "sharing", key + " must not be torn down");
    assert.equal(U.isSharing(t), true);
  }
  assert.equal(U.isSharing(tab({ sharingState: {} })), false);
  assert.equal(U.isSharing(tab({})), false, "absent sharingState is not sharing");
});

test("sharing beats the idle threshold no matter how stale the tab is", () => {
  const ancient = tab({ lastAccessed: NOW - 900 * DAY, sharingState: { screen: true } });
  assert.equal(U.skipReason(ancient, NOW, 2), "sharing");
});

test("the threshold boundary is exclusive, so a tab exactly at it is spared", () => {
  const exactly = tab({ lastAccessed: NOW - 7 * DAY });
  assert.equal(U.skipReason(exactly, NOW, 7), "too-recent");
  const justPast = tab({ lastAccessed: NOW - 7 * DAY - 1 });
  assert.equal(U.skipReason(justPast, NOW, 7), null);
});

test("a shorter threshold catches more tabs", () => {
  const tabs = [
    tab({ lastAccessed: NOW - 1 * DAY }),
    tab({ lastAccessed: NOW - 3 * DAY }),
    tab({ lastAccessed: NOW - 10 * DAY }),
  ];
  assert.equal(U.selectUnloadCandidates(tabs, NOW, 30).length, 0);
  assert.equal(U.selectUnloadCandidates(tabs, NOW, 7).length, 1);
  assert.equal(U.selectUnloadCandidates(tabs, NOW, 2).length, 2);
});

test("a tab with no usable timestamp is spared, not swept", () => {
  assert.equal(U.skipReason(tab({ lastAccessed: undefined }), NOW, 2), "no-timestamp");
  assert.equal(U.skipReason(tab({ lastAccessed: NaN }), NOW, 2), "no-timestamp");
});

test("a future timestamp from clock skew is treated as recent", () => {
  assert.equal(U.skipReason(tab({ lastAccessed: NOW + 5 * DAY }), NOW, 2), "too-recent");
});

test("only the offered thresholds are day-scale and start at two days", () => {
  assert.deepEqual(U.THRESHOLD_DAYS, [2, 3, 7, 14, 30]);
  assert.ok(Math.min(...U.THRESHOLD_DAYS) >= 2, "no minute-scale option: PiP cannot be detected");
});

test("selection tolerates an empty or missing tab list", () => {
  assert.deepEqual(U.selectUnloadCandidates([], NOW, 7), []);
  assert.deepEqual(U.selectUnloadCandidates(undefined, NOW, 7), []);
});
