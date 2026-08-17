"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../src/buckets.js");
require("../src/planner.js");
require("../src/close.js");
const B = globalThis.TaboBuckets;
const C = globalThis.TaboClose;

const DAY = C.DAY_MS;
const NOW = new Date(2026, 7, 17, 12).getTime();

let nextId = 1;
function tab(props) {
  return Object.assign(
    {
      id: nextId++,
      index: 0,
      pinned: false,
      active: false,
      groupId: -1,
      audible: false,
      autoDiscardable: true,
      lastAccessed: NOW - 100 * DAY,
    },
    props
  );
}
function snap(tabs, groups) {
  return { windowId: 1, tabs, groups: groups || [] };
}

// Auto-close was switched on 200 days ago, so anything last active since then
// has had its whole idle period observed.
const WATCHING = { thresholdDays: 30, observingSince: NOW - 200 * DAY };

test("the feature is off until a threshold is chosen", () => {
  const t = tab({ lastAccessed: NOW - 500 * DAY });
  for (const off of [null, 0, undefined]) {
    assert.equal(C.skipReason(t, NOW, { thresholdDays: off, observingSince: 0 }), "off");
    assert.deepEqual(C.closeCandidates(snap([t]), NOW, { thresholdDays: off }), []);
  }
});

test("a long-idle tab that Tabo watched the whole time is closeable", () => {
  const t = tab({ lastAccessed: NOW - 60 * DAY });
  assert.equal(C.skipReason(t, NOW, WATCHING), null);
  assert.deepEqual(C.closeCandidates(snap([t]), NOW, WATCHING), [t.id]);
});

test("thresholds are all at least 30 days, so closing never outpaces unloading", () => {
  require("../src/unload.js");
  const maxUnload = Math.max(...globalThis.TaboUnload.THRESHOLD_DAYS);
  assert.deepEqual(C.THRESHOLD_DAYS, [30, 60, 90, 180, 365]);
  assert.ok(Math.min(...C.THRESHOLD_DAYS) >= maxUnload, "shortest close >= longest unload");
});

test("the threshold boundary is exclusive", () => {
  assert.equal(C.skipReason(tab({ lastAccessed: NOW - 30 * DAY }), NOW, WATCHING), "too-recent");
  assert.equal(C.skipReason(tab({ lastAccessed: NOW - 30 * DAY - 1 }), NOW, WATCHING), null);
});

// ------------------------------------------------- the backlog guarantee

test("a tab last active before Tabo was watching is never closed automatically", () => {
  const enabledRecently = { thresholdDays: 30, observingSince: NOW - 40 * DAY };
  const backlog = tab({ lastAccessed: NOW - 900 * DAY });
  assert.equal(
    C.skipReason(backlog, NOW, enabledRecently),
    "not-observed",
    "nine hundred days idle and still immune, because the idle time predates Tabo"
  );
  assert.deepEqual(C.closeCandidates(snap([backlog]), NOW, enabledRecently), []);
});

test("enabling auto-close closes nothing at all on the first sweep", () => {
  const justEnabled = { thresholdDays: 30, observingSince: NOW };
  const tabs = [
    tab({ lastAccessed: NOW - 1 * DAY }),
    tab({ lastAccessed: NOW - 200 * DAY }),
    tab({ lastAccessed: NOW - 4000 * DAY }),
  ];
  assert.deepEqual(
    C.closeCandidates(snap(tabs), NOW, justEnabled),
    [],
    "installing must never reap a backlog"
  );
});

test("a missing observingSince is treated as not observed, never as forever", () => {
  const t = tab({ lastAccessed: NOW - 500 * DAY });
  for (const bad of [undefined, null, NaN, "yesterday"]) {
    assert.equal(C.skipReason(t, NOW, { thresholdDays: 30, observingSince: bad }), "not-observed");
  }
});

test("the observed boundary is exclusive too", () => {
  const since = NOW - 100 * DAY;
  const opts = { thresholdDays: 30, observingSince: since };
  assert.equal(C.skipReason(tab({ lastAccessed: since }), NOW, opts), "not-observed", "exactly at");
  assert.equal(C.skipReason(tab({ lastAccessed: since + 1 }), NOW, opts), null, "just after");
});

test("a restart does not make observed tabs unobserved again", () => {
  // lastAccessed survives a restart faithfully, so nothing about a restart
  // changes eligibility. observingSince is stored once, when the user opts in.
  const t = tab({ lastAccessed: NOW - 60 * DAY });
  assert.equal(C.skipReason(t, NOW, WATCHING), null);
  assert.equal(C.skipReason(t, NOW, WATCHING), null, "idempotent, no session state involved");
});

// ------------------------------------------------------------- exclusions

test("pinned tabs are never closed", () => {
  assert.equal(C.skipReason(tab({ pinned: true, lastAccessed: NOW - 900 * DAY }), NOW, WATCHING), "pinned");
});

test("the active tab is never closed", () => {
  assert.equal(C.skipReason(tab({ active: true, lastAccessed: NOW - 900 * DAY }), NOW, WATCHING), "active");
});

test("tabs filed into a group of the user's own are never closed", () => {
  const theirs = { id: 10, title: "Work", color: "blue" };
  const filed = tab({ groupId: 10, lastAccessed: NOW - 900 * DAY });
  const loose = tab({ lastAccessed: NOW - 60 * DAY });
  const got = C.closeCandidates(snap([filed, loose], [theirs]), NOW, WATCHING);
  assert.deepEqual(got, [loose.id], "filing a tab is a deliberate act and protects it");
});

test("tabs in Tabo's own buckets are closeable like loose ones", () => {
  const ours = { id: 11, title: B.MARKER + "2024", color: "grey" };
  const t = tab({ groupId: 11, lastAccessed: NOW - 60 * DAY });
  assert.deepEqual(C.closeCandidates(snap([t], [ours]), NOW, WATCHING), [t.id]);
});

test("audible, sharing and opted-out tabs are spared regardless of age", () => {
  const old = NOW - 900 * DAY;
  assert.equal(C.skipReason(tab({ audible: true, lastAccessed: old }), NOW, WATCHING), "audible");
  assert.equal(
    C.skipReason(tab({ sharingState: { screen: true }, lastAccessed: old }), NOW, WATCHING),
    "sharing"
  );
  assert.equal(
    C.skipReason(tab({ autoDiscardable: false, lastAccessed: old }), NOW, WATCHING),
    "opted-out",
    "the per-tab opt-out protects from closing as well as unloading"
  );
  for (const key of ["camera", "microphone", "screen"]) {
    assert.equal(C.isSharing(tab({ sharingState: { [key]: true } })), true, key);
  }
});

test("a tab with no usable timestamp is spared", () => {
  assert.equal(C.skipReason(tab({ lastAccessed: undefined }), NOW, WATCHING), "no-timestamp");
  assert.equal(C.skipReason(tab({ lastAccessed: NaN }), NOW, WATCHING), "no-timestamp");
});

test("a future timestamp counts as recent, not as ancient", () => {
  assert.equal(C.skipReason(tab({ lastAccessed: NOW + 5 * DAY }), NOW, WATCHING), "too-recent");
});

// --------------------------------------------------------- the manual reap

test("the manual reap ignores observation but keeps every other exclusion", () => {
  const theirs = { id: 20, title: "Work", color: "blue" };
  const backlog = tab({ lastAccessed: NOW - 900 * DAY });
  const pinned = tab({ pinned: true, lastAccessed: NOW - 900 * DAY });
  const filed = tab({ groupId: 20, lastAccessed: NOW - 900 * DAY });
  const loud = tab({ audible: true, lastAccessed: NOW - 900 * DAY });
  const recent = tab({ lastAccessed: NOW - 5 * DAY });

  const got = C.backlogCandidates(snap([backlog, pinned, filed, loud, recent], [theirs]), NOW, 30);
  assert.deepEqual(got, [backlog.id], "only the unobserved backlog tab, nothing else loosens");
});

test("the manual reap still respects the threshold", () => {
  const t = tab({ lastAccessed: NOW - 20 * DAY });
  assert.deepEqual(C.backlogCandidates(snap([t]), NOW, 30), []);
  assert.deepEqual(C.backlogCandidates(snap([t]), NOW, 14), [t.id]);
});

test("selection tolerates an empty window", () => {
  assert.deepEqual(C.closeCandidates(snap([]), NOW, WATCHING), []);
  assert.deepEqual(C.backlogCandidates(snap([]), NOW, 30), []);
});
