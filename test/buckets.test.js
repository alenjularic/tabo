"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../src/buckets.js");
const B = globalThis.TaboBuckets;

const M = B.MARKER;

// Local time throughout, so build reference points with the local constructor.
function at(y, m, d, h, min) {
  return new Date(y, m - 1, d, h || 0, min || 0).getTime();
}

// Monday 2026-08-17, midday. Week (Mon-start) runs 2026-08-17 .. 2026-08-23.
const NOW = at(2026, 8, 17, 12, 0);
const MON = { firstDay: 1, locale: "en-US" };

test("isTaboTitle only matches the marker prefix", () => {
  assert.equal(B.isTaboTitle(M + "This week"), true);
  assert.equal(B.isTaboTitle("This week"), false, "unmarked title is the user's, not ours");
  assert.equal(B.isTaboTitle("Work"), false);
  assert.equal(B.isTaboTitle(""), false);
  assert.equal(B.isTaboTitle(undefined), false, "untitled groups have no title at all");
  assert.equal(B.isTaboTitle("prefixed " + M + "This week"), false, "marker must lead");
});

test("startOfWeekMs honours the first day of week", () => {
  // Sunday 2026-08-16.
  const sunday = at(2026, 8, 16, 9, 0);
  assert.equal(B.startOfWeekMs(sunday, 1), at(2026, 8, 10), "Monday start: previous Monday");
  assert.equal(B.startOfWeekMs(sunday, 7), at(2026, 8, 16), "Sunday start: that same Sunday");
  // Monday 2026-08-17.
  assert.equal(B.startOfWeekMs(NOW, 1), at(2026, 8, 17), "Monday start: today");
  assert.equal(B.startOfWeekMs(NOW, 7), at(2026, 8, 16), "Sunday start: yesterday");
});

test("this week covers the whole calendar week including its first instant", () => {
  assert.equal(B.targetLabel(NOW, NOW, MON), M + "This week");
  assert.equal(B.targetLabel(at(2026, 8, 17, 0, 0), NOW, MON), M + "This week", "week start midnight");
  assert.equal(B.targetLabel(at(2026, 8, 23, 23, 59), NOW, MON), M + "This week", "week end");
});

test("a timestamp in the future is treated as current, not as an error", () => {
  assert.equal(B.targetLabel(NOW + 86400000 * 30, NOW, MON), M + "This week");
});

test("last week is the previous calendar week, and its boundaries are exact", () => {
  assert.equal(B.targetLabel(at(2026, 8, 16, 23, 59), NOW, MON), M + "Last week", "day before week start");
  assert.equal(B.targetLabel(at(2026, 8, 10, 0, 0), NOW, MON), M + "Last week", "first instant of last week");
  assert.equal(
    B.targetLabel(at(2026, 8, 9, 23, 59), NOW, MON),
    M + "August 2026",
    "one instant earlier falls through to the month"
  );
});

test("week labels follow the locale's first day", () => {
  const sunday = at(2026, 8, 16, 9, 0);
  assert.equal(B.targetLabel(sunday, NOW, { firstDay: 1, locale: "en-US" }), M + "Last week");
  assert.equal(B.targetLabel(sunday, NOW, { firstDay: 7, locale: "en-US" }), M + "This week");
});

test("earlier in the current month falls to the month bucket, not a week bucket", () => {
  assert.equal(B.targetLabel(at(2026, 8, 3, 12, 0), NOW, MON), M + "August 2026");
});

test("month buckets reach back as far as the months depth allows", () => {
  // Default depth is months: 3, so monthsBack 0, 1 and 2 keep month granularity.
  assert.equal(B.targetLabel(at(2026, 8, 3), NOW, MON), M + "August 2026", "monthsBack 0");
  assert.equal(B.targetLabel(at(2026, 7, 15), NOW, MON), M + "July 2026", "monthsBack 1");
  assert.equal(B.targetLabel(at(2026, 6, 1), NOW, MON), M + "June 2026", "monthsBack 2");
  assert.equal(B.targetLabel(at(2026, 5, 1), NOW, MON), M + "2026", "monthsBack 3 falls to the year");
});

test("year buckets reach back as far as the years depth allows, then Older", () => {
  assert.equal(B.targetLabel(at(2025, 8, 31), NOW, MON), M + "2025", "yearsBack 1");
  assert.equal(B.targetLabel(at(2024, 6, 1), NOW, MON), M + "2024", "yearsBack 2");
  assert.equal(B.targetLabel(at(2023, 12, 31), NOW, MON), M + "Older", "yearsBack 3 is past the depth");
  assert.equal(B.targetLabel(at(2019, 1, 1), NOW, MON), M + "Older", "nothing is ever left unbucketed");
});

test("the month cutoff is by calendar month, not by day count", () => {
  const now = at(2026, 1, 15, 12, 0);
  assert.equal(B.targetLabel(at(2025, 12, 1), now, MON), M + "December 2025", "monthsBack 1");
  assert.equal(B.targetLabel(at(2025, 11, 30), now, MON), M + "November 2025", "monthsBack 2");
  assert.equal(B.targetLabel(at(2025, 10, 31), now, MON), M + "2025", "monthsBack 3, same year as above");
});

// --------------------------------------------------------------- depth control

test("normalizeDepth falls back per level, against that level's own maximum", () => {
  assert.deepEqual(B.normalizeDepth(undefined), B.DEFAULT_DEPTH);
  assert.deepEqual(B.normalizeDepth({}), B.DEFAULT_DEPTH);
  assert.deepEqual(B.normalizeDepth({ days: 3, weeks: 0, months: 1, years: 2 }), {
    days: 3,
    weeks: 0,
    months: 1,
    years: 2,
  });
  const bad = B.normalizeDepth({ days: -1, weeks: 99, months: 1.5, years: "2" });
  assert.deepEqual(bad, B.DEFAULT_DEPTH, "every invalid value falls back rather than clamping oddly");

  assert.deepEqual(B.MAX_DEPTH, { days: 6, weeks: 4, months: 11, years: 6 });
  // Each level is checked against its own ceiling, not a shared one.
  assert.equal(B.normalizeDepth({ days: 6 }).days, 6);
  assert.equal(B.normalizeDepth({ days: 7 }).days, B.DEFAULT_DEPTH.days);
  assert.equal(B.normalizeDepth({ months: 11 }).months, 11);
  assert.equal(B.normalizeDepth({ months: 12 }).months, B.DEFAULT_DEPTH.months);
  assert.equal(B.normalizeDepth({ weeks: 4 }).weeks, 4);
  assert.equal(B.normalizeDepth({ weeks: 5 }).weeks, B.DEFAULT_DEPTH.weeks);
  assert.equal(B.normalizeDepth({ years: 6 }).years, 6);
  assert.equal(B.normalizeDepth({ years: 7 }).years, B.DEFAULT_DEPTH.years);
});

test("the deepest possible setting still labels every tab", () => {
  const deepest = { firstDay: 1, locale: "en-US", depth: B.MAX_DEPTH };
  // 6 days, then 4 weeks, then 11 months, then 6 years, then Older.
  assert.equal(B.targetLabel(NOW, NOW, deepest), M + "Today");
  assert.equal(B.targetLabel(at(2026, 8, 12, 9), NOW, deepest), M + "5 days ago");
  assert.equal(B.targetLabel(at(2026, 8, 11, 9), NOW, deepest), M + "Last week", "past 6 days");
  // Monday-start weeks back from Mon 2026-08-17: Aug 10 is 1, Aug 3 is 2,
  // Jul 27 is 3, Jul 20 is 4 — and 4 is past the depth of 4, which covers 0..3.
  assert.equal(B.targetLabel(at(2026, 7, 29, 9), NOW, deepest), M + "3 weeks ago");
  assert.equal(B.targetLabel(at(2026, 7, 22, 9), NOW, deepest), M + "July 2026", "past 4 weeks");
  assert.equal(B.targetLabel(at(2025, 10, 1), NOW, deepest), M + "October 2025", "10 months back");
  assert.equal(B.targetLabel(at(2025, 8, 1), NOW, deepest), M + "2025", "past 11 months");
  assert.equal(B.targetLabel(at(2021, 1, 1), NOW, deepest), M + "2021", "5 years back");
  assert.equal(B.targetLabel(at(2020, 1, 1), NOW, deepest), M + "Older", "past 6 years");
});

test("day buckets appear only when the days depth is above zero", () => {
  const none = { firstDay: 1, locale: "en-US", depth: { days: 0, weeks: 2, months: 3, years: 3 } };
  assert.equal(B.targetLabel(NOW, NOW, none), M + "This week", "days off: today is just this week");

  const two = { firstDay: 1, locale: "en-US", depth: { days: 2, weeks: 2, months: 3, years: 3 } };
  assert.equal(B.targetLabel(NOW, NOW, two), M + "Today");
  assert.equal(B.targetLabel(at(2026, 8, 16, 9), NOW, two), M + "Yesterday");
});

test("a finer level claims a tab before a coarser one can, so levels never overlap", () => {
  const deep = { firstDay: 1, locale: "en-US", depth: { days: 3, weeks: 3, months: 3, years: 3 } };
  // NOW is Monday 2026-08-17, the first day of its week.
  assert.equal(B.targetLabel(NOW, NOW, deep), M + "Today", "not This week, even though it is in this week");
  assert.equal(B.targetLabel(at(2026, 8, 15, 9), NOW, deep), M + "2 days ago", "not Last week");
  // Four days back is past the day depth, so the week level takes it.
  assert.equal(B.targetLabel(at(2026, 8, 13, 9), NOW, deep), M + "Last week");
});

test("a disabled level is absorbed by the next coarser one", () => {
  const noWeeks = { firstDay: 1, locale: "en-US", depth: { days: 0, weeks: 0, months: 3, years: 3 } };
  assert.equal(B.targetLabel(NOW, NOW, noWeeks), M + "August 2026", "weeks off: straight to the month");

  const yearsOnly = { firstDay: 1, locale: "en-US", depth: { days: 0, weeks: 0, months: 0, years: 3 } };
  assert.equal(B.targetLabel(NOW, NOW, yearsOnly), M + "2026");
});

test("with every level at zero, everything lands in Older", () => {
  const off = { firstDay: 1, locale: "en-US", depth: { days: 0, weeks: 0, months: 0, years: 0 } };
  assert.equal(B.targetLabel(NOW, NOW, off), M + "Older");
  assert.equal(B.targetLabel(at(2019, 1, 1), NOW, off), M + "Older");
});

test("day and week labels read naturally for the first two, then count", () => {
  assert.deepEqual([0, 1, 2].map(B.dayLabel), ["Today", "Yesterday", "2 days ago"]);
  assert.deepEqual([0, 1, 2].map(B.weekLabel), ["This week", "Last week", "2 weeks ago"]);
});

test("a deeper weeks setting produces counted week buckets", () => {
  const three = { firstDay: 1, locale: "en-US", depth: { days: 0, weeks: 3, months: 3, years: 3 } };
  assert.equal(B.targetLabel(at(2026, 8, 5, 9), NOW, three), M + "2 weeks ago");
  assert.equal(B.targetLabel(at(2026, 7, 29, 9), NOW, three), M + "July 2026", "past the week depth");
});

test("labels survive a DST transition without drifting a week", () => {
  // US DST began Sunday 2026-03-08. Week of Mon 2026-03-09 contains the change
  // in the week before it, so the boundary must still land on local midnight.
  const now = at(2026, 3, 12, 12, 0);
  assert.equal(B.startOfWeekMs(now, 1), at(2026, 3, 9), "Monday of a post-DST week");
  assert.equal(B.targetLabel(at(2026, 3, 9, 0, 0), now, MON), M + "This week");
  assert.equal(B.targetLabel(at(2026, 3, 8, 12, 0), now, MON), M + "Last week", "the DST day itself");
});

test("firstDayOfWeek falls back to Monday for unknown locales", () => {
  const d = B.firstDayOfWeek("zz-ZZ");
  assert.ok(d >= 1 && d <= 7);
});

test("colorForRank is deterministic, clamped, and only ever returns valid colors", () => {
  assert.equal(B.colorForRank(0), "green", "newest bucket");
  assert.equal(B.colorForRank(8), "grey");
  assert.equal(B.colorForRank(50), "grey", "the long tail clamps rather than wrapping");
  assert.equal(B.colorForRank(-3), "green", "never indexes off the front");
  for (let i = 0; i < 30; i++) {
    assert.ok(B.COLORS.includes(B.colorForRank(i)));
  }
  assert.equal(B.COLORS.length, 9, "Firefox accepts exactly nine");
  assert.ok(B.COLORS.includes("grey") && !B.COLORS.includes("gray"), "API spelling is grey");
});
