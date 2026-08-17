"use strict";

// Pure reconcile planner. Takes a snapshot of one window and returns the list
// of operations needed to make the strip match the tabs' recency. Touches no
// browser APIs, so all of the real logic is unit-testable.
//
// The planner is stateless by design. Nothing about a bucket is persisted:
// groupId changes across restart, Firefox destroys a group the instant its last
// tab leaves, and a drained bucket that refills comes back with a new id. Every
// pass therefore recomputes from scratch, which also makes a failed pass safe to
// simply retry.

(function (root) {
  const B = root.TaboBuckets;

  const UNGROUPED = -1;

  // Operations reference buckets by label, never by groupId, because a created
  // group has no id until the executor runs. The executor resolves labels to
  // ids as it goes.
  //
  //   { op: "rename", groupId, label }
  //   { op: "create", label, tabIds, color, collapsed }
  //   { op: "add",    label, tabIds }
  //   { op: "style",  label, color, collapsed }
  //   { op: "order",  labels }            oldest -> newest, each moved to -1
  //
  // They are returned in execution order.

  function partition(snapshot) {
    const groupsById = new Map();
    for (const g of snapshot.groups || []) {
      groupsById.set(g.id, g);
    }

    const ourGroupIds = new Set();
    for (const g of snapshot.groups || []) {
      if (B.isTaboTitle(g.title)) {
        ourGroupIds.add(g.id);
      }
    }

    const ignored = [];
    const filed = [];
    const managed = [];

    for (const tab of snapshot.tabs || []) {
      if (tab.pinned) {
        // Pinned is the ignored state. tabs.group() would silently unpin, and
        // the API reports nothing, so these must never reach a grouping call.
        ignored.push(tab);
        continue;
      }
      const inGroup = tab.groupId !== undefined && tab.groupId !== UNGROUPED;
      if (inGroup && !ourGroupIds.has(tab.groupId)) {
        // The user's own group, or one of Firefox's AI groups — we cannot tell
        // the difference and do not need to. Either way it is hands off.
        filed.push(tab);
        continue;
      }
      managed.push(tab);
    }

    return { ignored, filed, managed, ourGroupIds, groupsById };
  }

  // Smallest tab index held by a group, used to read its position in the strip.
  // The tabGroups API exposes no index of its own.
  function groupPositions(tabs) {
    const pos = new Map();
    for (const tab of tabs) {
      if (tab.groupId === undefined || tab.groupId === UNGROUPED) continue;
      const cur = pos.get(tab.groupId);
      if (cur === undefined || tab.index < cur) {
        pos.set(tab.groupId, tab.index);
      }
    }
    return pos;
  }

  function planWindow(snapshot, now, opts) {
    const options = opts || {};
    const collapseOld = options.collapseOld !== false;
    const labelOpts = {
      locale: options.locale,
      firstDay: options.firstDay,
      depth: options.depth,
    };

    const { managed, ourGroupIds, groupsById } = partition(snapshot);

    // Which bucket does each managed tab belong in?
    const cohorts = new Map(); // label -> { label, tabIds, maxTs }
    const labelByTabId = new Map();
    for (const tab of managed) {
      if (!Number.isFinite(tab.lastAccessed)) {
        // No usable timestamp. Leave the tab loose rather than guess.
        continue;
      }
      const label = B.targetLabel(tab.lastAccessed, now, labelOpts);
      labelByTabId.set(tab.id, label);
      let cohort = cohorts.get(label);
      if (!cohort) {
        cohort = { label, tabIds: [], maxTs: -Infinity };
        cohorts.set(label, cohort);
      }
      cohort.tabIds.push(tab.id);
      if (tab.lastAccessed > cohort.maxTs) {
        cohort.maxTs = tab.lastAccessed;
      }
    }

    // Members of each of our existing groups, restricted to managed tabs.
    const membersByGroup = new Map();
    for (const tab of managed) {
      if (!ourGroupIds.has(tab.groupId)) continue;
      if (!membersByGroup.has(tab.groupId)) membersByGroup.set(tab.groupId, []);
      membersByGroup.get(tab.groupId).push(tab);
    }

    const ops = [];
    const claimedByLabel = new Map(); // label -> groupId
    const claimedGroups = new Set();

    // Pass 1: a group whose title already equals a needed label keeps it.
    for (const label of cohorts.keys()) {
      for (const groupId of membersByGroup.keys()) {
        if (claimedGroups.has(groupId)) continue;
        const group = groupsById.get(groupId);
        if (group && group.title === label) {
          claimedByLabel.set(label, groupId);
          claimedGroups.add(groupId);
          break;
        }
      }
    }

    // Pass 2: a group whose entire membership now targets one label is renamed
    // into it. This is the cheap path that handles both a week rollover and a
    // month-long absence — one tabGroups.update, zero tabs moved.
    for (const [groupId, members] of membersByGroup) {
      if (claimedGroups.has(groupId)) continue;
      const labels = new Set();
      for (const tab of members) {
        const label = labelByTabId.get(tab.id);
        if (label) labels.add(label);
      }
      if (labels.size !== 1) continue;
      const label = labels.values().next().value;
      if (claimedByLabel.has(label)) continue; // another group already holds it
      claimedByLabel.set(label, groupId);
      claimedGroups.add(groupId);
      ops.push({ op: "rename", groupId, label });
    }

    // Rank cohorts newest-first for colour, and order them oldest-first in the
    // strip. Ordering comes from timestamps, never from parsing labels back.
    const ordered = Array.from(cohorts.values()).sort((a, b) => a.maxTs - b.maxTs);
    const newestFirst = ordered.slice().reverse();
    const rankByLabel = new Map();
    newestFirst.forEach((cohort, i) => rankByLabel.set(cohort.label, i));

    // Pass 3: create the buckets that have no group yet.
    for (const cohort of ordered) {
      if (claimedByLabel.has(cohort.label)) continue;
      const rank = rankByLabel.get(cohort.label);
      ops.push({
        op: "create",
        label: cohort.label,
        tabIds: cohort.tabIds.slice(),
        color: B.colorForRank(rank),
        collapsed: collapseOld && rank > 0,
      });
      claimedByLabel.set(cohort.label, null); // resolved at execution time
    }

    // Pass 4: move stragglers into their bucket. A tab already in the claimed
    // group is left alone; that is the overwhelmingly common case. Groups that
    // drain completely are destroyed by Firefox, so there is nothing to clean.
    const managedById = new Map(managed.map((t) => [t.id, t]));
    for (const cohort of ordered) {
      const groupId = claimedByLabel.get(cohort.label);
      if (groupId === null) continue; // just created with exactly these tabs
      const strays = [];
      for (const tabId of cohort.tabIds) {
        const tab = managedById.get(tabId);
        if (!tab) continue;
        if (tab.groupId === groupId) continue;
        strays.push(tabId);
      }
      if (strays.length) {
        ops.push({ op: "add", label: cohort.label, tabIds: strays });
      }
    }

    // Pass 5: colour and collapse, only where they differ from the current
    // state. A newly created group already carries both.
    for (const cohort of ordered) {
      const groupId = claimedByLabel.get(cohort.label);
      if (groupId === null) continue;
      const group = groupsById.get(groupId);
      if (!group) continue;
      const rank = rankByLabel.get(cohort.label);
      const color = B.colorForRank(rank);
      const collapsed = collapseOld && rank > 0;
      if (group.color !== color || !!group.collapsed !== collapsed) {
        ops.push({ op: "style", label: cohort.label, color, collapsed });
      }
    }

    // Pass 6: ordering. Placement is always tabGroups.move(id, {index: -1}),
    // applied oldest to newest, which appends each bucket to the end of the
    // strip in turn. That sidesteps absolute-index arithmetic entirely: no
    // rightward shift correction, and no chance of landing inside the pinned
    // region or inside another group, both of which throw.
    //
    // Only emitted when the current order is actually wrong, since the moves
    // are visible to the user.
    const positions = groupPositions(managed);
    let orderWrong = false;
    let previous = -Infinity;
    for (const cohort of ordered) {
      const groupId = claimedByLabel.get(cohort.label);
      if (groupId === null) {
        orderWrong = true; // a new group lands at the end regardless
        break;
      }
      const at = positions.get(groupId);
      if (at === undefined || at < previous) {
        orderWrong = true;
        break;
      }
      previous = at;
    }
    if (orderWrong && ordered.length > 1) {
      ops.push({ op: "order", labels: ordered.map((c) => c.label) });
    }

    return ops;
  }

  // ------------------------------------------------------------------- undo
  //
  // Undo has to put tabs back where they were, not merely ungroup them —
  // ungrouping alone leaves Tabo's reordering in place, and that is the part a
  // user cannot redo by hand.
  //
  // Only managed tabs are ever snapshotted or restored. Pinned and filed tabs
  // are excluded because Tabo never moved them, and moving them back would be
  // the one thing that could pull a tab out of a group the user made.

  function snapshotOrder(snapshot) {
    const { managed } = partition(snapshot);
    return managed
      .filter((t) => !t.pinned)
      .map((t) => ({ tabId: t.id, index: t.index }))
      .sort((a, b) => a.index - b.index);
  }

  // saved may be null, meaning the snapshot is gone — after a browser restart
  // tab ids no longer match anything, so ungrouping is all that remains
  // possible. That degradation is structural, not a shortcut.
  function planUndo(snapshot, saved) {
    const { managed, ourGroupIds } = partition(snapshot);
    const ops = [];

    const grouped = managed.filter((t) => ourGroupIds.has(t.groupId)).map((t) => t.id);
    if (grouped.length) {
      ops.push({ op: "ungroupAll", tabIds: grouped });
    }

    if (!saved || !saved.length) return ops;

    const live = new Map(managed.filter((t) => !t.pinned).map((t) => [t.id, t]));
    const moves = [];
    // Ascending recorded index, so each move lands before the ones still to
    // come and the run rebuilds left to right.
    for (const entry of saved.slice().sort((a, b) => a.index - b.index)) {
      const tab = live.get(entry.tabId);
      if (!tab) continue; // closed since the snapshot
      moves.push({ tabId: entry.tabId, index: entry.index });
    }
    if (moves.length) {
      ops.push({ op: "restore", moves });
    }
    return ops;
  }

  root.TaboPlanner = {
    partition,
    groupPositions,
    planWindow,
    snapshotOrder,
    planUndo,
    UNGROUPED,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
