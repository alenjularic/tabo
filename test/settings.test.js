"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../src/buckets.js"); // settings validates bucket depth through it
require("../src/unload.js"); // and thresholds against this
require("../src/planner.js");
require("../src/close.js"); // settings validates close thresholds against it
require("../src/settings.js");
const S = globalThis.TaboSettings;

test("defaults have both features off", () => {
  const s = S.mergeSettings(undefined);
  assert.equal(s.buckets.enabled, false, "bucketing must not reorder tabs on install");
  assert.equal(s.unload.thresholdDays, null, "unloading is off until a threshold is chosen");
  assert.equal(s.buckets.reorderAcknowledged, false);
});

test("missing or malformed stored data falls back to defaults", () => {
  for (const bad of [undefined, null, 0, "nope", [], { buckets: "no" }, { unload: 5 }]) {
    const s = S.mergeSettings(bad);
    assert.equal(s.buckets.enabled, false);
    assert.equal(s.unload.thresholdDays, null);
    assert.equal(s.buckets.collapseOld, true);
  }
});

test("only offered thresholds are accepted", () => {
  for (const days of globalThis.TaboUnload.THRESHOLD_DAYS) {
    assert.equal(S.mergeSettings({ unload: { thresholdDays: days } }).unload.thresholdDays, days);
  }
  for (const bogus of [1, 0.5, 9999, -7, "7", null, {}]) {
    assert.equal(
      S.mergeSettings({ unload: { thresholdDays: bogus } }).unload.thresholdDays,
      null,
      "an unoffered threshold falls back to off, never to a guess: " + JSON.stringify(bogus)
    );
  }
});

test("enabled is strictly boolean true, not merely truthy", () => {
  assert.equal(S.mergeSettings({ buckets: { enabled: "yes" } }).buckets.enabled, false);
  assert.equal(S.mergeSettings({ buckets: { enabled: 1 } }).buckets.enabled, false);
  assert.equal(S.mergeSettings({ buckets: { enabled: true } }).buckets.enabled, true);
});

test("collapseOld defaults on and only an explicit false turns it off", () => {
  assert.equal(S.mergeSettings({}).buckets.collapseOld, true);
  assert.equal(S.mergeSettings({ buckets: { collapseOld: false } }).buckets.collapseOld, false);
  assert.equal(S.mergeSettings({ buckets: { collapseOld: undefined } }).buckets.collapseOld, true);
});

test("dwell is clamped to a sane range", () => {
  assert.equal(S.mergeSettings({ buckets: { dwellMs: 0 } }).buckets.dwellMs, 0, "zero is allowed");
  assert.equal(S.mergeSettings({ buckets: { dwellMs: 3000 } }).buckets.dwellMs, 3000);
  assert.equal(S.mergeSettings({ buckets: { dwellMs: -1 } }).buckets.dwellMs, 1500);
  assert.equal(S.mergeSettings({ buckets: { dwellMs: 999999 } }).buckets.dwellMs, 1500);
  assert.equal(S.mergeSettings({ buckets: { dwellMs: "fast" } }).buckets.dwellMs, 1500);
});

test("unknown keys are dropped rather than carried forward", () => {
  const s = S.mergeSettings({ buckets: { enabled: true, rogue: 1 }, extra: true, version: 99 });
  assert.equal(s.buckets.rogue, undefined);
  assert.equal(s.extra, undefined);
  assert.equal(s.version, S.DEFAULTS.version, "version is ours to set, not the stored data's");
});

test("bucket depth defaults, and a corrupted level falls back per level", () => {
  assert.deepEqual(S.mergeSettings({}).buckets.depth, globalThis.TaboBuckets.DEFAULT_DEPTH);
  assert.deepEqual(
    S.mergeSettings({ buckets: { depth: { days: 2, weeks: 1, months: 0, years: 3 } } }).buckets.depth,
    { days: 2, weeks: 1, months: 0, years: 3 }
  );
  const D = globalThis.TaboBuckets.DEFAULT_DEPTH;
  assert.deepEqual(
    S.mergeSettings({ buckets: { depth: { days: 99, weeks: -1, months: "2", years: null } } }).buckets.depth,
    D,
    "a hand-edited or corrupted depth can never reach the label function"
  );
  assert.deepEqual(S.mergeSettings({ buckets: { depth: "nope" } }).buckets.depth, D);
});

test("each depth level accepts zero through its own maximum", () => {
  const MAX = globalThis.TaboBuckets.MAX_DEPTH;
  const DEFAULT = globalThis.TaboBuckets.DEFAULT_DEPTH;

  // The maxima differ per level; they are not one shared cap.
  assert.deepEqual(MAX, { days: 6, weeks: 4, months: 11, years: 6 });

  for (const level of ["days", "weeks", "months", "years"]) {
    for (let n = 0; n <= MAX[level]; n++) {
      const s = S.mergeSettings({ buckets: { depth: { [level]: n } } });
      assert.equal(s.buckets.depth[level], n, level + "=" + n);
    }
    const over = S.mergeSettings({ buckets: { depth: { [level]: MAX[level] + 1 } } });
    assert.equal(
      over.buckets.depth[level],
      DEFAULT[level],
      level + " above its own maximum falls back"
    );
  }
});

test("a level's maximum does not leak into another level", () => {
  const MAX = globalThis.TaboBuckets.MAX_DEPTH;
  const DEFAULT = globalThis.TaboBuckets.DEFAULT_DEPTH;
  // 11 is legal for months and illegal for weeks, which a single shared cap
  // would have got wrong in one direction or the other.
  assert.equal(S.mergeSettings({ buckets: { depth: { months: 11 } } }).buckets.depth.months, 11);
  assert.equal(
    S.mergeSettings({ buckets: { depth: { weeks: 11 } } }).buckets.depth.weeks,
    DEFAULT.weeks
  );
  assert.equal(S.mergeSettings({ buckets: { depth: { days: 6 } } }).buckets.depth.days, 6);
  assert.equal(
    S.mergeSettings({ buckets: { depth: { weeks: 5 } } }).buckets.depth.weeks,
    DEFAULT.weeks,
    "weeks caps at " + MAX.weeks
  );
});

test("auto-close is off by default and only accepts offered thresholds", () => {
  assert.deepEqual(S.mergeSettings({}).close, { thresholdDays: null, observingSince: null });
  for (const days of globalThis.TaboClose.THRESHOLD_DAYS) {
    const s = S.mergeSettings({ close: { thresholdDays: days, observingSince: 1000 } });
    assert.equal(s.close.thresholdDays, days);
  }
  for (const bogus of [7, 14, 1, 0.5, -30, "30", null, {}]) {
    assert.equal(
      S.mergeSettings({ close: { thresholdDays: bogus } }).close.thresholdDays,
      null,
      "an unoffered close threshold falls back to off, never to a guess: " + JSON.stringify(bogus)
    );
  }
});

test("a corrupted observingSince fails closed, so nothing becomes closeable", () => {
  for (const bad of [undefined, null, NaN, 0, -1, "yesterday", {}]) {
    const s = S.mergeSettings({ close: { thresholdDays: 30, observingSince: bad } });
    assert.equal(s.close.thresholdDays, 30);
    assert.equal(
      s.close.observingSince,
      null,
      "null means never observed, which makes every tab ineligible: " + JSON.stringify(bad)
    );
  }
  assert.equal(S.mergeSettings({ close: { thresholdDays: 30, observingSince: 5 } }).close.observingSince, 5);
});

test("turning auto-close off clears observingSince so re-enabling restarts the guarantee", () => {
  const s = S.mergeSettings({ close: { thresholdDays: null, observingSince: 999999 } });
  assert.equal(s.close.observingSince, null);
});

test("merge is idempotent", () => {
  const once = S.mergeSettings({ buckets: { enabled: true }, unload: { thresholdDays: 14 } });
  assert.deepEqual(S.mergeSettings(once), once);
});
