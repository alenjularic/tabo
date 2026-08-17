"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../src/buckets.js");
require("../src/planner.js");
const B = globalThis.TaboBuckets;
const P = globalThis.TaboPlanner;

const M = B.MARKER;
const NOW = new Date(2026, 7, 17, 12).getTime();

let nextId = 1;
function tab(props) {
  return Object.assign(
    { id: nextId++, index: 0, pinned: false, active: false, groupId: -1, lastAccessed: NOW },
    props
  );
}
function group(props) {
  return Object.assign({ id: 0, title: undefined, color: "blue", collapsed: false }, props);
}
function ofType(ops, op) {
  return ops.find((o) => o.op === op);
}

test("snapshotOrder records only the tabs Tabo is allowed to move", () => {
  const theirs = group({ id: 10, title: "Work" });
  const ours = group({ id: 11, title: M + "This week" });
  const pinned = tab({ index: 0, pinned: true });
  const filed = tab({ index: 1, groupId: 10 });
  const bucketed = tab({ index: 2, groupId: 11 });
  const loose = tab({ index: 3 });

  const saved = P.snapshotOrder({
    windowId: 1,
    tabs: [pinned, filed, bucketed, loose],
    groups: [theirs, ours],
  });

  assert.deepEqual(
    saved.map((e) => e.tabId),
    [bucketed.id, loose.id],
    "pinned and filed tabs are never snapshotted, because Tabo never moved them"
  );
  assert.deepEqual(saved.map((e) => e.index), [2, 3], "sorted by index ascending");
});

test("undo ungroups only Tabo's own groups", () => {
  const theirs = group({ id: 20, title: "Research" });
  const ours = group({ id: 21, title: M + "March 2026" });
  const filed = tab({ index: 0, groupId: 20 });
  const bucketed = tab({ index: 1, groupId: 21 });

  const ops = P.planUndo(
    { windowId: 1, tabs: [filed, bucketed], groups: [theirs, ours] },
    null
  );

  const ungroup = ofType(ops, "ungroupAll");
  assert.deepEqual(ungroup.tabIds, [bucketed.id]);
  assert.ok(!ungroup.tabIds.includes(filed.id), "a group the user made is never dismantled");
});

test("with no snapshot, undo degrades to ungrouping and never invents an order", () => {
  const ours = group({ id: 30, title: M + "This week" });
  const t = tab({ index: 0, groupId: 30 });
  const ops = P.planUndo({ windowId: 1, tabs: [t], groups: [ours] }, null);

  assert.ok(ofType(ops, "ungroupAll"), "still ungroups");
  assert.equal(ofType(ops, "restore"), undefined, "no restore op is fabricated");
});

test("an empty snapshot is treated the same as a missing one", () => {
  const ours = group({ id: 31, title: M + "This week" });
  const t = tab({ index: 0, groupId: 31 });
  const ops = P.planUndo({ windowId: 1, tabs: [t], groups: [ours] }, []);
  assert.equal(ofType(ops, "restore"), undefined);
});

test("undo restores the recorded order, ascending so the run rebuilds left to right", () => {
  const ours = group({ id: 40, title: M + "This week" });
  // Tabo moved these; current order is 2,0,1 versus the recorded 0,1,2.
  const a = tab({ id: 101, index: 1, groupId: 40 });
  const b = tab({ id: 102, index: 2, groupId: 40 });
  const c = tab({ id: 103, index: 0, groupId: 40 });
  const saved = [
    { tabId: 103, index: 2 },
    { tabId: 101, index: 0 },
    { tabId: 102, index: 1 },
  ];

  const ops = P.planUndo({ windowId: 1, tabs: [a, b, c], groups: [ours] }, saved);

  const restore = ofType(ops, "restore");
  assert.deepEqual(
    restore.moves,
    [
      { tabId: 101, index: 0 },
      { tabId: 102, index: 1 },
      { tabId: 103, index: 2 },
    ],
    "sorted by recorded index regardless of the snapshot's own order"
  );
});

test("ungrouping is planned before any move", () => {
  const ours = group({ id: 41, title: M + "This week" });
  const t = tab({ id: 201, index: 0, groupId: 41 });
  const ops = P.planUndo({ windowId: 1, tabs: [t], groups: [ours] }, [{ tabId: 201, index: 3 }]);

  const kinds = ops.map((o) => o.op);
  assert.deepEqual(kinds, ["ungroupAll", "restore"], "moving before ungrouping would re-recruit tabs");
});

test("tabs closed since the snapshot are skipped rather than moved blindly", () => {
  const ours = group({ id: 50, title: M + "This week" });
  const alive = tab({ id: 301, index: 0, groupId: 50 });
  const saved = [
    { tabId: 301, index: 0 },
    { tabId: 999, index: 1 }, // closed
  ];

  const restore = ofType(P.planUndo({ windowId: 1, tabs: [alive], groups: [ours] }, saved), "restore");
  assert.deepEqual(restore.moves, [{ tabId: 301, index: 0 }]);
});

test("a tab pinned since the snapshot is left where it is", () => {
  const ours = group({ id: 51, title: M + "This week" });
  const nowPinned = tab({ id: 401, index: 0, pinned: true });
  const still = tab({ id: 402, index: 1, groupId: 51 });
  const saved = [
    { tabId: 401, index: 5 },
    { tabId: 402, index: 6 },
  ];

  const restore = ofType(
    P.planUndo({ windowId: 1, tabs: [nowPinned, still], groups: [ours] }, saved),
    "restore"
  );
  assert.deepEqual(
    restore.moves,
    [{ tabId: 402, index: 6 }],
    "pinning is an eviction; undo must not drag it back into the unpinned run"
  );
});

test("undo on an untouched window plans nothing", () => {
  const theirs = group({ id: 60, title: "Work" });
  const filed = tab({ index: 0, groupId: 60 });
  const pinned = tab({ index: 1, pinned: true });
  assert.deepEqual(
    P.planUndo({ windowId: 1, tabs: [filed, pinned], groups: [theirs] }, null),
    []
  );
});

test("undo is idempotent — running it on an already-restored window plans no ungrouping", () => {
  const loose1 = tab({ id: 501, index: 0 });
  const loose2 = tab({ id: 502, index: 1 });
  const saved = [
    { tabId: 501, index: 0 },
    { tabId: 502, index: 1 },
  ];
  const ops = P.planUndo({ windowId: 1, tabs: [loose1, loose2], groups: [] }, saved);
  assert.equal(ofType(ops, "ungroupAll"), undefined, "nothing left to ungroup");
});
