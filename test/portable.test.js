"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../src/buckets.js");
require("../src/portable.js");
const T = globalThis.TaboPortable;

let nextId = 1;
function tab(props) {
  return Object.assign(
    { id: nextId++, index: 0, pinned: false, groupId: -1, url: "https://a.test/", title: "A" },
    props
  );
}
function group(props) {
  return Object.assign({ id: 0, title: "G", color: "blue", collapsed: false }, props);
}

// ------------------------------------------------------------------- export

test("export captures groups, loose and pinned tabs separately", () => {
  const g = group({ id: 7, title: "Work", color: "purple", collapsed: true });
  const out = T.buildExport(
    [
      {
        windowId: 1,
        groups: [g],
        tabs: [
          tab({ index: 0, pinned: true, url: "https://pin.test/", title: "Pinned" }),
          tab({ index: 1, groupId: 7, url: "https://in.test/", title: "Grouped" }),
          tab({ index: 2, url: "https://loose.test/", title: "Loose" }),
        ],
      },
    ],
    1234
  );

  assert.equal(out.tabo, T.FORMAT);
  assert.equal(out.exportedAt, 1234);
  const w = out.windows[0];
  assert.deepEqual(w.pinned.map((t) => t.url), ["https://pin.test/"]);
  assert.deepEqual(w.loose.map((t) => t.url), ["https://loose.test/"]);
  assert.equal(w.groups.length, 1);
  assert.equal(w.groups[0].title, "Work");
  assert.equal(w.groups[0].color, "purple");
  assert.equal(w.groups[0].collapsed, true);
  assert.deepEqual(w.groups[0].tabs.map((t) => t.url), ["https://in.test/"]);
});

test("exported groups are ordered by strip position, oldest bucket first", () => {
  const M = T.MARKER;
  // tabGroups.query() order is undocumented, so feed it deliberately scrambled.
  const groups = [
    group({ id: 3, title: M + "This week" }),
    group({ id: 1, title: M + "2024" }),
    group({ id: 2, title: M + "June 2026" }),
  ];
  const tabs = [
    tab({ index: 0, groupId: 1, url: "https://old.test/" }),
    tab({ index: 1, groupId: 2, url: "https://mid.test/" }),
    tab({ index: 2, groupId: 3, url: "https://new.test/" }),
  ];
  const out = T.buildExport([{ windowId: 1, groups, tabs }]);
  assert.deepEqual(
    out.windows[0].groups.map((g) => g.title),
    [M + "2024", M + "June 2026", M + "This week"],
    "order comes from tab indices, never from the order query() happened to return"
  );
});

test("a group's position is its lowest tab index, not its first-seen tab", () => {
  const groups = [group({ id: 1, title: "B" }), group({ id: 2, title: "A" })];
  const tabs = [
    tab({ index: 9, groupId: 1, url: "https://b1.test/" }),
    tab({ index: 2, groupId: 2, url: "https://a1.test/" }),
    tab({ index: 8, groupId: 1, url: "https://b2.test/" }),
    tab({ index: 3, groupId: 2, url: "https://a2.test/" }),
  ];
  const out = T.buildExport([{ windowId: 1, groups, tabs }]);
  assert.deepEqual(out.windows[0].groups.map((g) => g.title), ["A", "B"]);
});

test("import strips Tabo's marker so a restored archive is not re-bucketed", () => {
  const M = T.MARKER;
  // tabs.create cannot set lastAccessed, so imported tabs read as brand new and
  // a marked group would be merged into "this week" on the next pass.
  const result = T.planImport({
    tabo: T.FORMAT,
    windows: [
      {
        groups: [
          { title: M + "2024", color: "grey", tabs: [{ url: "https://a.test/" }] },
          { title: M + "This week", color: "green", tabs: [{ url: "https://b.test/" }] },
          { title: "Work", color: "blue", tabs: [{ url: "https://c.test/" }] },
        ],
      },
    ],
  });
  assert.deepEqual(
    result.plan[0].groups.map((g) => g.title),
    ["2024", "This week", "Work"],
    "marked groups lose the clock; the user's own group is untouched"
  );
  assert.equal(result.stats.unmarked, 2, "how many were unmarked is reported, not hidden");
  for (const g of result.plan[0].groups) {
    assert.equal(T.isImportableUrl(g.tabs[0].url), true);
    assert.ok(!g.title.startsWith(M), "no restored group keeps the marker");
  }
});

test("restoredTitle only strips a leading marker and leaves everything else alone", () => {
  const M = T.MARKER;
  assert.equal(T.restoredTitle(M + "Last week"), "Last week");
  assert.equal(T.restoredTitle("Work"), "Work");
  assert.equal(T.restoredTitle(""), "");
  assert.equal(T.restoredTitle("Read " + M + "later"), "Read " + M + "later", "marker must lead");
});

test("export keeps the marker, so a round trip freezes rather than losing names", () => {
  const M = T.MARKER;
  const g = group({ id: 5, title: M + "March 2026" });
  const out = T.buildExport([
    { windowId: 1, groups: [g], tabs: [tab({ index: 0, groupId: 5 })] },
  ]);
  assert.equal(out.windows[0].groups[0].title, M + "March 2026", "the file records what was there");
  const back = T.planImport(JSON.parse(JSON.stringify(out)));
  assert.equal(back.plan[0].groups[0].title, "March 2026", "stripping happens on the way in");
});

test("export preserves strip order within each bucket", () => {
  const out = T.buildExport([
    {
      windowId: 1,
      groups: [],
      tabs: [
        tab({ index: 5, url: "https://c.test/" }),
        tab({ index: 1, url: "https://a.test/" }),
        tab({ index: 3, url: "https://b.test/" }),
      ],
    },
  ]);
  assert.deepEqual(
    out.windows[0].loose.map((t) => t.url),
    ["https://a.test/", "https://b.test/", "https://c.test/"]
  );
});

test("export keeps Tabo's own buckets like any other group", () => {
  const bucket = group({ id: 9, title: "\u{1F552} This week", color: "green" });
  const out = T.buildExport([
    { windowId: 1, groups: [bucket], tabs: [tab({ index: 0, groupId: 9 })] },
  ]);
  assert.equal(out.windows[0].groups[0].title, "\u{1F552} This week");
});

test("export drops groups left with no exportable tabs", () => {
  // Firefox cannot recreate an empty group, so writing one out is a lie.
  const empty = group({ id: 11, title: "Ghost" });
  const out = T.buildExport([{ windowId: 1, groups: [empty], tabs: [] }]);
  assert.deepEqual(out.windows[0].groups, []);
});

test("export records lastAccessed only when it is usable", () => {
  const out = T.buildExport([
    {
      windowId: 1,
      groups: [],
      tabs: [
        tab({ index: 0, lastAccessed: 999 }),
        tab({ index: 1, lastAccessed: undefined, url: "https://b.test/" }),
      ],
    },
  ]);
  assert.equal(out.windows[0].loose[0].lastAccessed, 999);
  assert.equal("lastAccessed" in out.windows[0].loose[1], false);
});

test("export falls back to a valid colour for an unknown one", () => {
  const g = group({ id: 12, color: "chartreuse" });
  const out = T.buildExport([
    { windowId: 1, groups: [g], tabs: [tab({ index: 0, groupId: 12 })] },
  ]);
  assert.ok(T.VALID_COLORS.includes(out.windows[0].groups[0].color));
});

test("export tolerates empty input", () => {
  assert.deepEqual(T.buildExport([]).windows, []);
  assert.deepEqual(T.buildExport(undefined).windows, []);
});

// ------------------------------------------------------------------- import

test("import rejects anything that is not a Tabo file, without throwing", () => {
  for (const junk of [null, undefined, 42, "text", [], {}, { tabo: 99, windows: [] }]) {
    const result = T.planImport(junk);
    assert.equal(result.ok, false, JSON.stringify(junk));
    assert.equal(typeof result.error, "string");
  }
});

test("import round-trips an export", () => {
  const g = group({ id: 3, title: "Work", color: "red" });
  const exported = T.buildExport([
    {
      windowId: 1,
      groups: [g],
      tabs: [
        tab({ index: 0, pinned: true, url: "https://pin.test/" }),
        tab({ index: 1, groupId: 3, url: "https://in.test/" }),
        tab({ index: 2, url: "https://loose.test/" }),
      ],
    },
  ]);

  const result = T.planImport(JSON.parse(JSON.stringify(exported)));
  assert.equal(result.ok, true);
  assert.equal(result.plan.length, 1);
  assert.deepEqual(result.plan[0].pinned.map((t) => t.url), ["https://pin.test/"]);
  assert.deepEqual(result.plan[0].groups[0].tabs.map((t) => t.url), ["https://in.test/"]);
  assert.equal(result.plan[0].groups[0].color, "red");
  assert.deepEqual(result.plan[0].loose.map((t) => t.url), ["https://loose.test/"]);
  assert.equal(result.stats.tabs, 3);
  assert.equal(result.stats.skippedTabs, 0);
});

test("import only accepts http and https", () => {
  for (const url of [
    "about:config",
    "about:debugging",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "moz-extension://abc/page.html",
    "data:text/html,x",
    "ftp://x.test/",
    "",
    null,
  ]) {
    assert.equal(T.isImportableUrl(url), false, String(url) + " must not be importable");
  }
  assert.equal(T.isImportableUrl("https://ok.test/"), true);
  assert.equal(T.isImportableUrl("HTTP://Ok.Test/"), true, "scheme check is case-insensitive");
});

test("unimportable urls are skipped and counted, not fatal", () => {
  const result = T.planImport({
    tabo: T.FORMAT,
    windows: [
      {
        loose: [
          { url: "https://keep.test/", title: "keep" },
          { url: "about:config", title: "nope" },
          { url: "javascript:alert(1)", title: "nope" },
        ],
      },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan[0].loose.map((t) => t.url), ["https://keep.test/"]);
  assert.equal(result.stats.skippedTabs, 2, "the UI can report what was dropped");
});

test("a file with nothing importable fails loudly rather than opening an empty window", () => {
  const result = T.planImport({
    tabo: T.FORMAT,
    windows: [{ loose: [{ url: "about:config" }] }],
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Nothing importable/);
});

test("import drops groups that end up empty after filtering", () => {
  const result = T.planImport({
    tabo: T.FORMAT,
    windows: [
      {
        groups: [
          { title: "AllBad", color: "blue", tabs: [{ url: "about:blank" }] },
          { title: "Good", color: "blue", tabs: [{ url: "https://ok.test/" }] },
        ],
      },
    ],
  });
  assert.equal(result.plan[0].groups.length, 1);
  assert.equal(result.plan[0].groups[0].title, "Good");
  assert.equal(result.stats.groups, 1);
});

test("import sanitises colours and coerces titles", () => {
  const result = T.planImport({
    tabo: T.FORMAT,
    windows: [
      {
        groups: [
          { title: { evil: true }, color: "not-a-colour", tabs: [{ url: "https://a.test/", title: 7 }] },
        ],
      },
    ],
  });
  assert.equal(result.plan[0].groups[0].color, "grey");
  assert.equal(result.plan[0].groups[0].title, "", "a non-string title becomes empty, not '[object Object]'");
  assert.equal(result.plan[0].groups[0].tabs[0].title, "");
});

test("import ignores malformed windows and entries instead of failing the whole file", () => {
  const result = T.planImport({
    tabo: T.FORMAT,
    windows: [
      null,
      42,
      { groups: "nope", loose: "nope" },
      { loose: [null, 5, { url: "https://good.test/" }] },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan.length, 1);
  assert.deepEqual(result.plan[0].loose.map((t) => t.url), ["https://good.test/"]);
});

test("import caps total tabs and says so", () => {
  const many = Array.from({ length: T.MAX_TABS + 25 }, (_, i) => ({
    url: "https://x.test/" + i,
  }));
  const result = T.planImport({ tabo: T.FORMAT, windows: [{ loose: many }] });
  assert.equal(result.ok, true);
  assert.equal(result.stats.tabs, T.MAX_TABS, "hard cap on how many tabs a file can open");
  assert.equal(result.stats.truncated, true, "truncation is reported, never silent");
});

test("import caps windows", () => {
  const windows = Array.from({ length: T.MAX_WINDOWS + 5 }, (_, i) => ({
    loose: [{ url: "https://w.test/" + i }],
  }));
  const result = T.planImport({ tabo: T.FORMAT, windows });
  assert.equal(result.plan.length, T.MAX_WINDOWS);
});

test("long strings are clipped rather than passed through", () => {
  const huge = "x".repeat(50000);
  const result = T.planImport({
    tabo: T.FORMAT,
    windows: [{ groups: [{ title: huge, color: "blue", tabs: [{ url: "https://a.test/", title: huge }] }] }],
  });
  assert.ok(result.plan[0].groups[0].title.length <= 2000);
  assert.ok(result.plan[0].groups[0].tabs[0].title.length <= 2000);
  assert.equal(T.isImportableUrl("https://a.test/" + huge), false, "an absurd url is refused");
});
