"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../src/buckets.js");
require("../src/planner.js");
const B = globalThis.TaboBuckets;
const P = globalThis.TaboPlanner;

const M = B.MARKER;
const MON = { firstDay: 1, locale: "en-US", collapseOld: true };

function at(y, m, d, h) {
  return new Date(y, m - 1, d, h || 12).getTime();
}
const NOW = at(2026, 8, 17, 12); // Monday

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
  return ops.filter((o) => o.op === op);
}

test("pinned tabs are ignored and never reach a grouping operation", () => {
  const pinned = tab({ pinned: true, index: 0, lastAccessed: at(2024, 1, 1) });
  const loose = tab({ index: 1, lastAccessed: at(2024, 1, 1) });
  const snapshot = { windowId: 1, tabs: [pinned, loose], groups: [] };

  const parts = P.partition(snapshot);
  assert.deepEqual(parts.ignored.map((t) => t.id), [pinned.id]);
  assert.deepEqual(parts.managed.map((t) => t.id), [loose.id]);

  const ops = P.planWindow(snapshot, NOW, MON);
  const created = ofType(ops, "create");
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].tabIds, [loose.id], "the pinned tab is absent from every op");
});

test("tabs in a group we did not create are left completely alone", () => {
  const theirs = group({ id: 10, title: "Work" });
  const filed = tab({ index: 0, groupId: 10, lastAccessed: at(2024, 1, 1) });
  const loose = tab({ index: 1, lastAccessed: at(2024, 1, 1) });
  const snapshot = { windowId: 1, tabs: [filed, loose], groups: [theirs] };

  const parts = P.partition(snapshot);
  assert.deepEqual(parts.filed.map((t) => t.id), [filed.id]);

  const ops = P.planWindow(snapshot, NOW, MON);
  const touched = JSON.stringify(ops);
  assert.ok(!touched.includes(String(filed.id)), "filed tab never appears in any operation");
  assert.ok(!touched.includes('"groupId":10'), "their group is never renamed or restyled");
});

test("an unmarked group titled like a bucket is treated as the user's", () => {
  const lookalike = group({ id: 11, title: "This week" }); // no marker
  const filed = tab({ index: 0, groupId: 11 });
  const snapshot = { windowId: 1, tabs: [filed], groups: [lookalike] };

  assert.deepEqual(P.partition(snapshot).filed.map((t) => t.id), [filed.id]);
  assert.equal(P.planWindow(snapshot, NOW, MON).length, 0, "nothing to do");
});

test("loose tabs are bucketed by recency with newest last and oldest first", () => {
  const recent = tab({ index: 0, lastAccessed: NOW });
  const old = tab({ index: 1, lastAccessed: at(2024, 5, 1) });
  const mid = tab({ index: 2, lastAccessed: at(2026, 3, 4) }); // months depth 3 -> year bucket
  const snapshot = { windowId: 1, tabs: [recent, old, mid], groups: [] };

  const ops = P.planWindow(snapshot, NOW, MON);
  const created = ofType(ops, "create");
  assert.deepEqual(
    created.map((o) => o.label),
    [M + "2024", M + "2026", M + "This week"],
    "creation order is oldest to newest"
  );
  const order = ofType(ops, "order");
  assert.equal(order.length, 1);
  assert.deepEqual(order[0].labels, [M + "2024", M + "2026", M + "This week"]);
});

test("the newest bucket is left expanded and the rest are collapsed", () => {
  const snapshot = {
    windowId: 1,
    tabs: [tab({ lastAccessed: NOW }), tab({ lastAccessed: at(2024, 5, 1) })],
    groups: [],
  };
  const created = ofType(P.planWindow(snapshot, NOW, MON), "create");
  const byLabel = new Map(created.map((o) => [o.label, o]));
  assert.equal(byLabel.get(M + "This week").collapsed, false);
  assert.equal(byLabel.get(M + "2024").collapsed, true);
});

test("collapseOld:false leaves every bucket expanded", () => {
  const snapshot = {
    windowId: 1,
    tabs: [tab({ lastAccessed: NOW }), tab({ lastAccessed: at(2024, 5, 1) })],
    groups: [],
  };
  const created = ofType(
    P.planWindow(snapshot, NOW, { firstDay: 1, locale: "en-US", collapseOld: false }),
    "create"
  );
  assert.ok(created.every((o) => o.collapsed === false));
});

test("colour is assigned by recency rank, newest first", () => {
  const snapshot = {
    windowId: 1,
    tabs: [
      tab({ lastAccessed: NOW }),
      tab({ lastAccessed: at(2026, 8, 11) }), // last week
      tab({ lastAccessed: at(2024, 5, 1) }),
    ],
    groups: [],
  };
  const created = ofType(P.planWindow(snapshot, NOW, MON), "create");
  const byLabel = new Map(created.map((o) => [o.label, o.color]));
  assert.equal(byLabel.get(M + "This week"), B.colorForRank(0));
  assert.equal(byLabel.get(M + "Last week"), B.colorForRank(1));
  assert.equal(byLabel.get(M + "2024"), B.colorForRank(2));
});

test("a correct strip is a no-op", () => {
  const g = group({ id: 20, title: M + "This week", color: B.colorForRank(0), collapsed: false });
  const t = tab({ index: 0, groupId: 20, lastAccessed: NOW });
  const ops = P.planWindow({ windowId: 1, tabs: [t], groups: [g] }, NOW, MON);
  assert.deepEqual(ops, [], "steady state costs nothing");
});

test("a week rollover renames the group and moves no tabs", () => {
  // Both tabs were 'this week' when grouped; now they are last week's.
  const g = group({ id: 21, title: M + "This week", color: B.colorForRank(0), collapsed: false });
  const a = tab({ index: 0, groupId: 21, lastAccessed: at(2026, 8, 11) });
  const b = tab({ index: 1, groupId: 21, lastAccessed: at(2026, 8, 12) });
  const ops = P.planWindow({ windowId: 1, tabs: [a, b], groups: [g] }, NOW, MON);

  const renames = ofType(ops, "rename");
  assert.equal(renames.length, 1);
  assert.equal(renames[0].groupId, 21);
  assert.equal(renames[0].label, M + "Last week");
  assert.equal(ofType(ops, "add").length, 0, "no tab moves");
  assert.equal(ofType(ops, "create").length, 0, "no new group");
});

test("a month away relabels rather than rebuilding", () => {
  // Everything was 'this week'; the browser was closed for a month.
  const later = at(2026, 9, 20, 12);
  const g = group({ id: 22, title: M + "This week", color: B.colorForRank(0), collapsed: false });
  const a = tab({ index: 0, groupId: 22, lastAccessed: at(2026, 8, 17) });
  const b = tab({ index: 1, groupId: 22, lastAccessed: at(2026, 8, 18) });
  const ops = P.planWindow({ windowId: 1, tabs: [a, b], groups: [g] }, later, MON);

  assert.deepEqual(ofType(ops, "rename").map((o) => o.label), [M + "August 2026"]);
  assert.equal(ofType(ops, "add").length, 0);
  assert.equal(ofType(ops, "create").length, 0);
});

test("two buckets that come to share a label merge into one", () => {
  // Separate week buckets that have both aged into the same month.
  const now = at(2026, 9, 20, 12);
  const g1 = group({ id: 30, title: M + "This week", color: "green", collapsed: false });
  const g2 = group({ id: 31, title: M + "Last week", color: "yellow", collapsed: true });
  const a = tab({ index: 0, groupId: 30, lastAccessed: at(2026, 8, 20) });
  const b = tab({ index: 1, groupId: 31, lastAccessed: at(2026, 8, 12) });

  const ops = P.planWindow({ windowId: 1, tabs: [a, b], groups: [g1, g2] }, now, MON);

  const label = M + "August 2026";
  const renames = ofType(ops, "rename");
  assert.equal(renames.length, 1, "exactly one group is renamed into the shared label");
  assert.equal(renames[0].label, label);
  const claimed = renames[0].groupId;
  const other = claimed === 30 ? 31 : 30;

  const adds = ofType(ops, "add");
  assert.equal(adds.length, 1, "the loser's tabs move into the winner");
  assert.equal(adds[0].label, label);
  const loserTab = other === 30 ? a.id : b.id;
  assert.deepEqual(adds[0].tabIds, [loserTab]);
  assert.equal(ofType(ops, "create").length, 0, "no group is created for a merge");
});

test("a revisited tab is pulled out of its old bucket into the current one", () => {
  const oldGroup = group({ id: 40, title: M + "2026", color: "orange", collapsed: true });
  const stale = tab({ index: 0, groupId: 40, lastAccessed: at(2026, 3, 5) });
  const touched = tab({ index: 1, groupId: 40, lastAccessed: NOW }); // just activated
  const ops = P.planWindow({ windowId: 1, tabs: [stale, touched], groups: [oldGroup] }, NOW, MON);

  const created = ofType(ops, "create");
  assert.deepEqual(created.map((o) => o.label), [M + "This week"]);
  assert.deepEqual(created[0].tabIds, [touched.id]);
  assert.ok(
    !ofType(ops, "rename").length,
    "the old group keeps its title because its membership is no longer unanimous"
  );
});

test("a group only splits the tabs that actually crossed a boundary", () => {
  const g = group({ id: 41, title: M + "This week", color: B.colorForRank(0), collapsed: false });
  const stays = tab({ index: 0, groupId: 41, lastAccessed: NOW });
  const ages = tab({ index: 1, groupId: 41, lastAccessed: at(2026, 8, 11) });
  const ops = P.planWindow({ windowId: 1, tabs: [stays, ages], groups: [g] }, NOW, MON);

  const created = ofType(ops, "create");
  assert.deepEqual(created.map((o) => o.label), [M + "Last week"]);
  assert.deepEqual(created[0].tabIds, [ages.id], "only the aged tab moves");
});

test("ordering is skipped when the strip is already in the right order", () => {
  const older = group({ id: 50, title: M + "2024", color: B.colorForRank(1), collapsed: true });
  const newer = group({ id: 51, title: M + "This week", color: B.colorForRank(0), collapsed: false });
  const a = tab({ index: 0, groupId: 50, lastAccessed: at(2024, 5, 1) });
  const b = tab({ index: 1, groupId: 51, lastAccessed: NOW });
  const ops = P.planWindow({ windowId: 1, tabs: [a, b], groups: [older, newer] }, NOW, MON);
  assert.equal(ofType(ops, "order").length, 0, "no gratuitous visible reordering");
});

test("ordering is emitted when buckets sit in the wrong order", () => {
  // Newest bucket is to the left of the oldest.
  const newer = group({ id: 60, title: M + "This week", color: B.colorForRank(0), collapsed: false });
  const older = group({ id: 61, title: M + "2024", color: B.colorForRank(1), collapsed: true });
  const a = tab({ index: 0, groupId: 60, lastAccessed: NOW });
  const b = tab({ index: 1, groupId: 61, lastAccessed: at(2024, 5, 1) });
  const ops = P.planWindow({ windowId: 1, tabs: [a, b], groups: [newer, older] }, NOW, MON);

  const order = ofType(ops, "order");
  assert.equal(order.length, 1);
  assert.deepEqual(order[0].labels, [M + "2024", M + "This week"], "oldest first");
});

test("a single bucket never triggers an order operation", () => {
  const g = group({ id: 70, title: M + "This week", color: B.colorForRank(0), collapsed: false });
  const t = tab({ index: 5, groupId: 70, lastAccessed: NOW });
  const ops = P.planWindow({ windowId: 1, tabs: [t], groups: [g] }, NOW, MON);
  assert.equal(ofType(ops, "order").length, 0);
});

test("a stale colour or collapse state is corrected without moving tabs", () => {
  const g = group({ id: 80, title: M + "This week", color: "pink", collapsed: true });
  const t = tab({ index: 0, groupId: 80, lastAccessed: NOW });
  const ops = P.planWindow({ windowId: 1, tabs: [t], groups: [g] }, NOW, MON);

  const styles = ofType(ops, "style");
  assert.equal(styles.length, 1);
  assert.equal(styles[0].color, B.colorForRank(0));
  assert.equal(styles[0].collapsed, false, "the newest bucket is expanded");
  assert.equal(ofType(ops, "add").length, 0);
});

test("tabs with no usable timestamp are left loose rather than guessed at", () => {
  const bad = tab({ index: 0, lastAccessed: undefined });
  const worse = tab({ index: 1, lastAccessed: NaN });
  const ops = P.planWindow({ windowId: 1, tabs: [bad, worse], groups: [] }, NOW, MON);
  assert.deepEqual(ops, []);
});

test("operations are ordered so membership settles before placement", () => {
  const g = group({ id: 90, title: M + "This week", color: "pink", collapsed: true });
  const stays = tab({ index: 0, groupId: 90, lastAccessed: NOW });
  const ages = tab({ index: 1, groupId: 90, lastAccessed: at(2024, 2, 2) });
  const ops = P.planWindow({ windowId: 1, tabs: [stays, ages], groups: [g] }, NOW, MON);

  const kinds = ops.map((o) => o.op);
  const rank = { rename: 0, create: 1, add: 2, style: 3, order: 4 };
  const ranks = kinds.map((k) => rank[k]);
  assert.deepEqual(ranks.slice().sort((x, y) => x - y), ranks, "ops come back in execution order");
});

test("every planned move is an append, so no absolute index is ever computed", () => {
  const snapshot = {
    windowId: 1,
    tabs: [
      tab({ index: 0, pinned: true }),
      tab({ index: 1, lastAccessed: NOW }),
      tab({ index: 2, lastAccessed: at(2024, 1, 1) }),
    ],
    groups: [],
  };
  const ops = P.planWindow(snapshot, NOW, MON);
  for (const op of ops) {
    assert.ok(!("index" in op), "planner emits no raw indices; placement is always move(-1)");
  }
});

test("groupPositions reads a group's place from its lowest tab index", () => {
  const tabs = [
    tab({ index: 0, groupId: -1 }),
    tab({ index: 3, groupId: 7 }),
    tab({ index: 1, groupId: 7 }),
    tab({ index: 2, groupId: 8 }),
  ];
  const pos = P.groupPositions(tabs);
  assert.equal(pos.get(7), 1);
  assert.equal(pos.get(8), 2);
  assert.equal(pos.has(-1), false, "ungrouped tabs have no group position");
});
