(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DuelSyncCore = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const SCHEMA_VERSION = 3;

  function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function stampParts(stamp) {
    const raw = String(stamp || "");
    const separator = raw.indexOf("|");
    const time = Number(separator === -1 ? raw : raw.slice(0, separator)) || 0;
    const writer = separator === -1 ? "" : raw.slice(separator + 1);
    return { time, writer };
  }

  function compareStamp(left, right) {
    const a = stampParts(left);
    const b = stampParts(right);
    if (a.time !== b.time) return a.time > b.time ? 1 : -1;
    if (a.writer === b.writer) return 0;
    return a.writer > b.writer ? 1 : -1;
  }

  function participantFromRecord(recordKey) {
    if (recordKey === "meta:p1Name") return "p1";
    if (recordKey === "meta:p2Name") return "p2";
    const match = String(recordKey).match(/_(p1|p2)(?::|$)/);
    return match ? match[1] : null;
  }

  function legacyStamp(state, recordKey, writerId) {
    const who = participantFromRecord(recordKey);
    const time = Number(state.meta && state.meta[who === "p2" ? "t2" : "t1"]) || 1;
    return `${time}|${writerId || "legacy"}`;
  }

  function ensureSyncState(state, writerId) {
    state.meta = state.meta || { p1Name: "محمد", p2Name: "رسل", t1: 0, t2: 0, theme: "auto" };
    state.done = state.done || {};
    state.customTasks = state.customTasks || {};
    state.sync = state.sync || {};
    state.sync.schemaVersion = SCHEMA_VERSION;
    state.sync.clocks = state.sync.clocks || {};
    state.sync.lastTime = Number(state.sync.lastTime) || 0;

    const clocks = state.sync.clocks;
    if (Number(state.meta.t1) > 0 && !clocks["meta:p1Name"]) {
      clocks["meta:p1Name"] = legacyStamp(state, "meta:p1Name", writerId);
    }
    if (Number(state.meta.t2) > 0 && !clocks["meta:p2Name"]) {
      clocks["meta:p2Name"] = legacyStamp(state, "meta:p2Name", writerId);
    }

    Object.keys(state.done).forEach(dayKey => {
      const record = state.done[dayKey] || {};
      Object.keys(record).forEach(taskId => {
        const recordKey = `done:${dayKey}:${taskId}`;
        if (!clocks[recordKey]) clocks[recordKey] = legacyStamp(state, recordKey, writerId);
      });
    });

    Object.keys(state.customTasks).forEach(customKey => {
      const recordKey = `tasks:${customKey}`;
      if (!clocks[recordKey]) clocks[recordKey] = legacyStamp(state, recordKey, writerId);
    });

    Object.values(clocks).forEach(stamp => {
      state.sync.lastTime = Math.max(state.sync.lastTime, stampParts(stamp).time);
    });
    return state;
  }

  function touch(state, recordKey, writerId, now) {
    ensureSyncState(state, writerId);
    const nextTime = Math.max(Number(now) || Date.now(), state.sync.lastTime + 1);
    state.sync.lastTime = nextTime;
    state.sync.updatedAt = nextTime;
    const stamp = `${nextTime}|${writerId}`;
    state.sync.clocks[recordKey] = stamp;
    return stamp;
  }

  function readRecord(state, recordKey) {
    if (recordKey === "meta:p1Name") return state.meta.p1Name;
    if (recordKey === "meta:p2Name") return state.meta.p2Name;
    if (recordKey.startsWith("tasks:")) {
      return state.customTasks[recordKey.slice(6)];
    }
    if (recordKey.startsWith("done:")) {
      const rest = recordKey.slice(5);
      const separator = rest.indexOf(":");
      if (separator === -1) return undefined;
      const dayKey = rest.slice(0, separator);
      const taskId = rest.slice(separator + 1);
      return state.done[dayKey] && state.done[dayKey][taskId];
    }
    return undefined;
  }

  function writeRecord(state, recordKey, value) {
    if (recordKey === "meta:p1Name") state.meta.p1Name = value;
    else if (recordKey === "meta:p2Name") state.meta.p2Name = value;
    else if (recordKey.startsWith("tasks:")) {
      state.customTasks[recordKey.slice(6)] = clone(value);
    } else if (recordKey.startsWith("done:")) {
      const rest = recordKey.slice(5);
      const separator = rest.indexOf(":");
      if (separator === -1) return;
      const dayKey = rest.slice(0, separator);
      const taskId = rest.slice(separator + 1);
      state.done[dayKey] = state.done[dayKey] || {};
      state.done[dayKey][taskId] = !!value;
    }
  }

  function mergeState(localState, remoteState, writerId) {
    if (!remoteState || typeof remoteState !== "object") {
      return { changed: false, localNewer: false };
    }

    ensureSyncState(localState, writerId || "local");
    const remote = clone(remoteState);
    ensureSyncState(remote, (remote.sync && remote.sync.writerId) || "remote-legacy");

    const keys = new Set([
      ...Object.keys(localState.sync.clocks),
      ...Object.keys(remote.sync.clocks)
    ]);
    let changed = false;
    let localNewer = false;

    keys.forEach(recordKey => {
      const localStamp = localState.sync.clocks[recordKey];
      const remoteStamp = remote.sync.clocks[recordKey];
      const order = compareStamp(remoteStamp, localStamp);
      if (order > 0) {
        writeRecord(localState, recordKey, readRecord(remote, recordKey));
        localState.sync.clocks[recordKey] = remoteStamp;
        changed = true;
      } else if (order < 0) {
        localNewer = true;
      }
    });

    localState.meta.t1 = Math.max(Number(localState.meta.t1) || 0, Number(remote.meta.t1) || 0);
    localState.meta.t2 = Math.max(Number(localState.meta.t2) || 0, Number(remote.meta.t2) || 0);
    localState.sync.lastTime = Math.max(localState.sync.lastTime, remote.sync.lastTime || 0);
    localState.sync.updatedAt = Math.max(localState.sync.updatedAt || 0, remote.sync.updatedAt || 0);
    return { changed, localNewer };
  }

  function exportSharedState(state, writerId) {
    ensureSyncState(state, writerId);
    return clone({
      meta: {
        p1Name: state.meta.p1Name,
        p2Name: state.meta.p2Name,
        t1: Number(state.meta.t1) || 0,
        t2: Number(state.meta.t2) || 0
      },
      done: state.done,
      customTasks: state.customTasks,
      sync: state.sync
    });
  }

  function hasSharedData(state, writerId) {
    ensureSyncState(state, writerId);
    return Object.keys(state.sync.clocks).length > 0;
  }

  return {
    SCHEMA_VERSION,
    compareStamp,
    ensureSyncState,
    exportSharedState,
    hasSharedData,
    mergeState,
    touch
  };
});
