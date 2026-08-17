"use strict";

// Pure recency-label logic. No browser APIs — this file is loaded both as a
// classic background script and directly by the unit tests.
//
// A bucket is never stored. Its label is a pure function of a timestamp and
// "now", which is what lets a reconcile pass rename a group instead of moving
// its tabs, and what makes two buckets that come to share a label merge on
// their own. See docs/superpowers/specs/2026-08-17-tabo-mvp-design.md.

(function (root) {
  // U+1F552 plus a space. A group belongs to Tabo if and only if its title
  // starts with this. The tabGroups API exposes no provenance whatsoever, and
  // groupId changes across restart, so the title is the only durable handle we
  // have on our own buckets.
  const MARKER = "\u{1F552} ";

  // Firefox accepts exactly these nine, and spells grey the Chromium way.
  // Rank 0 is the newest bucket; everything past the ninth is grey, which
  // reads correctly for the long tail.
  const COLORS = [
    "green",
    "yellow",
    "orange",
    "red",
    "pink",
    "purple",
    "cyan",
    "blue",
    "grey",
  ];

  function isTaboTitle(title) {
    return typeof title === "string" && title.startsWith(MARKER);
  }

  // ISO day numbering: 1 = Monday … 7 = Sunday, matching Intl's weekInfo.
  function firstDayOfWeek(locale) {
    try {
      const loc = new Intl.Locale(locale);
      const info = typeof loc.getWeekInfo === "function" ? loc.getWeekInfo() : loc.weekInfo;
      if (info && info.firstDay >= 1 && info.firstDay <= 7) {
        return info.firstDay;
      }
    } catch (e) {
      // Older engines, or a locale Intl does not know. Fall through.
    }
    return 1;
  }

  function startOfDayMs(ts) {
    const d = new Date(ts);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  // Local midnight of the week containing ts. Going through the Date
  // constructor rather than subtracting milliseconds keeps this correct across
  // DST transitions, where a week is not always 7 * 24 hours long.
  function startOfWeekMs(ts, firstDay) {
    const d = new Date(startOfDayMs(ts));
    const iso = d.getDay() === 0 ? 7 : d.getDay();
    const back = (iso - firstDay + 7) % 7;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime();
  }

  // How far back each granularity reaches, in units of itself. 0 disables that
  // level entirely and the next coarser one absorbs its span.
  const DEFAULT_DEPTH = { days: 0, weeks: 2, months: 3, years: 3 };

  // Per level, because the useful ranges differ: a week has 7 days so 6 day
  // buckets is the most that can precede a week bucket, a month holds about
  // 4 weeks, 11 months is as far as month granularity goes before the year
  // repeats itself, and 6 years is a deep enough tail for anyone.
  const MAX_DEPTH = { days: 6, weeks: 4, months: 11, years: 6 };

  // Anything older than the deepest configured level lands here, so no tab is
  // ever left without a bucket.
  const OLDER = "Older";

  function normalizeDepth(depth) {
    const d = depth || {};
    const clamp = (level) => {
      const value = d[level];
      return Number.isInteger(value) && value >= 0 && value <= MAX_DEPTH[level]
        ? value
        : DEFAULT_DEPTH[level];
    };
    return {
      days: clamp("days"),
      weeks: clamp("weeks"),
      months: clamp("months"),
      years: clamp("years"),
    };
  }

  function dayLabel(back) {
    if (back === 0) return "Today";
    if (back === 1) return "Yesterday";
    return back + " days ago";
  }

  function weekLabel(back) {
    if (back === 0) return "This week";
    if (back === 1) return "Last week";
    return back + " weeks ago";
  }

  // Rounding rather than integer division because two local midnights are not
  // always a whole number of 24-hour periods apart — a DST shift makes one week
  // 167 or 169 hours long.
  function unitsBetween(earlierMs, laterMs, unitMs) {
    return Math.max(0, Math.round((laterMs - earlierMs) / unitMs));
  }

  // First match wins, finest granularity first, which is what keeps the levels
  // from overlapping: a day bucket claims today before the week bucket can, so
  // "This week" quietly means "this week, excluding the days shown separately".
  //
  // Calendar-based rather than rolling, so every boundary moves for every tab at
  // the same instant. That is what lets a pass rename a group instead of moving
  // its tabs.
  function targetLabel(ts, now, opts) {
    const options = opts || {};
    const locale = options.locale || "en-US";
    const firstDay = options.firstDay || firstDayOfWeek(locale);
    const depth = normalizeDepth(options.depth);

    if (depth.days > 0) {
      const daysBack = unitsBetween(startOfDayMs(ts), startOfDayMs(now), 86400000);
      if (daysBack < depth.days) return MARKER + dayLabel(daysBack);
    }

    if (depth.weeks > 0) {
      const weeksBack = unitsBetween(
        startOfWeekMs(ts, firstDay),
        startOfWeekMs(now, firstDay),
        7 * 86400000
      );
      if (weeksBack < depth.weeks) return MARKER + weekLabel(weeksBack);
    }

    const then = new Date(ts);
    const nowDate = new Date(now);

    if (depth.months > 0) {
      const monthsBack = Math.max(
        0,
        (nowDate.getFullYear() * 12 + nowDate.getMonth()) -
          (then.getFullYear() * 12 + then.getMonth())
      );
      if (monthsBack < depth.months) {
        return MARKER + then.toLocaleString(locale, { month: "long" }) + " " + then.getFullYear();
      }
    }

    if (depth.years > 0) {
      const yearsBack = Math.max(0, nowDate.getFullYear() - then.getFullYear());
      if (yearsBack < depth.years) return MARKER + then.getFullYear();
    }

    return MARKER + OLDER;
  }

  function colorForRank(rank) {
    const i = Math.max(0, Math.min(COLORS.length - 1, rank | 0));
    return COLORS[i];
  }

  root.TaboBuckets = {
    MARKER,
    COLORS,
    OLDER,
    DEFAULT_DEPTH,
    MAX_DEPTH,
    normalizeDepth,
    isTaboTitle,
    firstDayOfWeek,
    startOfDayMs,
    startOfWeekMs,
    dayLabel,
    weekLabel,
    targetLabel,
    colorForRank,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
