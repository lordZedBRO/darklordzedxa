const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { createDmStore, DEFAULT_COOLDOWN_MS, DEFAULT_DELAY_MS } = require("../dm-store");
const { createDmEngine, createDmAccount, isPrivateThread } = require("../dm-engine");
const { setDmEngine, getDmEngine } = require("../dm-ref");

const silentLog = { error() {}, warn() {}, info() {} };

function settle(ms = 50) {
  return new Promise((r) => setTimeout(r, ms));
}

function tmpFile() {
  return path.join(os.tmpdir(), `dm-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function makeFakeApi(id, sentMessages) {
  return {
    ctx: { lastSeqId: "1" },
    getAppState: () => [{ key: "c_user", value: id }],
    logout: () => {},
    getCurrentUserID: () => id,
    sendMessage: async (text, threadID) => {
      sentMessages.push({ botId: id, text: String(text).slice(0, 80), threadID });
    },
    setMessageReaction: async () => {},
    listenMqtt: async (onEvent) => {
      return () => {};
    },
  };
}

function makeFakeLogin(api) {
  return (opts, loginOpts, cb) => {
    setImmediate(() => cb(null, api));
  };
}

test("dm-store: set and get account settings", () => {
  const store = createDmStore({ filePath: tmpFile(), log: silentLog });
  store.setAccountSettings("acc1", {
    targetUserId: "1234567890",
    enabled: true,
    messageText: "hello",
  });
  const s = store.getAccountSettings("acc1");
  assert.ok(s);
  assert.equal(s.targetUserId, "1234567890");
  assert.equal(s.enabled, true);
  assert.equal(s.messageText, "hello");
  assert.equal(s.cooldownMs, DEFAULT_COOLDOWN_MS);
  assert.equal(s.delayMs, DEFAULT_DELAY_MS);
});

test("dm-store: update partial settings", () => {
  const store = createDmStore({ filePath: tmpFile(), log: silentLog });
  store.setAccountSettings("acc1", { targetUserId: "111", enabled: true, messageText: "hi" });
  store.updateAccountSettings("acc1", { enabled: false });
  const s = store.getAccountSettings("acc1");
  assert.equal(s.enabled, false);
  assert.equal(s.targetUserId, "111");
});

test("dm-store: remove account settings", () => {
  const store = createDmStore({ filePath: tmpFile(), log: silentLog });
  store.setAccountSettings("acc1", { targetUserId: "111", enabled: true, messageText: "x" });
  assert.ok(store.removeAccountSettings("acc1"));
  assert.equal(store.getAccountSettings("acc1"), null);
});

test("dm-store: persists to disk", () => {
  const fpath = tmpFile();
  const store1 = createDmStore({ filePath: fpath, log: silentLog });
  store1.setAccountSettings("acc99", { targetUserId: "999", enabled: true, messageText: "persist" });
  const store2 = createDmStore({ filePath: fpath, log: silentLog });
  const s = store2.getAccountSettings("acc99");
  assert.ok(s);
  assert.equal(s.targetUserId, "999");
  assert.equal(s.messageText, "persist");
  try { fs.unlinkSync(fpath); } catch {}
});

test("isPrivateThread: detects DM vs group", () => {
  assert.ok(isPrivateThread({ isGroup: false, threadID: "123" }));
  assert.ok(isPrivateThread({ threadType: "dm", threadID: "123" }));
  assert.ok(!isPrivateThread({ isGroup: true, threadID: "123" }));
  assert.ok(!isPrivateThread({ threadID: "123", participantIDs: ["a", "b"] }));
});

test("dm-engine: login with fca-eryxenx style callback", async () => {
  const sentMessages = [];
  const api = makeFakeApi("100", sentMessages);
  const fakeLogin = makeFakeLogin(api);
  const store = createDmStore({ filePath: tmpFile(), log: silentLog });

  const engine = createDmEngine({ store, log: silentLog, loginFn: fakeLogin });
  const result = engine.startAccount("100", [{ key: "c_user", value: "100" }], "بوت测试");
  assert.equal(result.ok, true);
  await settle(200);
  assert.ok(engine.accounts.get("100").account.loggedIn);
  engine.stopAll();
});

test("dm-engine: receives private message and sends auto-reply after delay", async () => {
  const sentMessages = [];
  const listeners = new Map();
  const api = makeFakeApi("200", sentMessages);
  api.listenMqtt = async (onEvent) => {
    listeners.set("200", onEvent);
    return () => listeners.delete("200");
  };
  const fakeLogin = makeFakeLogin(api);

  const store = createDmStore({ filePath: tmpFile(), log: silentLog });
  store.setAccountSettings("200", {
    targetUserId: "555",
    enabled: true,
    messageText: "auto reply test",
    delayMs: 100,
    cooldownMs: 5000,
  });

  const engine = createDmEngine({ store, log: silentLog, loginFn: fakeLogin });
  engine.startAccount("200", [{ key: "c_user", value: "200" }], "بوت");
  await settle(200);

  const cb = listeners.get("200");
  assert.ok(cb);
  cb(null, {
    type: "message",
    threadID: "555",
    senderID: "555",
    messageID: "msg1",
    body: "مرحبا",
    isGroup: false,
  });

  await settle(50);
  assert.equal(sentMessages.length, 0, "message not sent before delay");

  await settle(150);
  assert.equal(sentMessages.length, 1, "auto-reply sent after delay");
  assert.ok(sentMessages[0].text.includes("auto reply test"));
  engine.stopAll();
});

test("dm-engine: does not send duplicate for same event", async () => {
  const sentMessages = [];
  const listeners = new Map();
  const api = makeFakeApi("300", sentMessages);
  api.listenMqtt = async (onEvent) => {
    listeners.set("300", onEvent);
    return () => listeners.delete("300");
  };
  const fakeLogin = makeFakeLogin(api);

  const store = createDmStore({ filePath: tmpFile(), log: silentLog });
  store.setAccountSettings("300", {
    targetUserId: "666",
    enabled: true,
    messageText: "dup test",
    delayMs: 50,
    cooldownMs: 100,
  });

  const engine = createDmEngine({ store, log: silentLog, loginFn: fakeLogin });
  engine.startAccount("300", [{ key: "c_user", value: "300" }], "بوت");
  await settle(200);

  const cb = listeners.get("300");
  const event = {
    type: "message",
    threadID: "666",
    senderID: "666",
    messageID: "msg-dup",
    body: "test",
    isGroup: false,
  };

  cb(null, event);
  cb(null, event);
  cb(null, event);

  await settle(200);
  assert.equal(sentMessages.length, 1, "only one message sent despite 3 same events");
  engine.stopAll();
});

test("dm-engine: handles message_reply event", async () => {
  const sentMessages = [];
  const listeners = new Map();
  const api = makeFakeApi("400", sentMessages);
  api.listenMqtt = async (onEvent) => {
    listeners.set("400", onEvent);
    return () => listeners.delete("400");
  };
  const fakeLogin = makeFakeLogin(api);

  const store = createDmStore({ filePath: tmpFile(), log: silentLog });
  store.setAccountSettings("400", {
    targetUserId: "777",
    enabled: true,
    messageText: "reply test",
    delayMs: 50,
    cooldownMs: 10000,
  });

  const engine = createDmEngine({ store, log: silentLog, loginFn: fakeLogin });
  engine.startAccount("400", [{ key: "c_user", value: "400" }], "بوت");
  await settle(200);

  const cb = listeners.get("400");
  cb(null, {
    type: "message_reply",
    threadID: "777",
    senderID: "777",
    messageID: "reply1",
    body: "رد",
    isGroup: false,
    messageReply: { messageID: "old1" },
  });

  await settle(150);
  assert.equal(sentMessages.length, 1);
  engine.stopAll();
});

test("dm-engine: handles message_reaction event", async () => {
  const sentMessages = [];
  const listeners = new Map();
  const api = makeFakeApi("500", sentMessages);
  api.listenMqtt = async (onEvent) => {
    listeners.set("500", onEvent);
    return () => listeners.delete("500");
  };
  const fakeLogin = makeFakeLogin(api);

  const store = createDmStore({ filePath: tmpFile(), log: silentLog });
  store.setAccountSettings("500", {
    targetUserId: "888",
    enabled: true,
    messageText: "reaction test",
    delayMs: 50,
    cooldownMs: 10000,
  });

  const engine = createDmEngine({ store, log: silentLog, loginFn: fakeLogin });
  engine.startAccount("500", [{ key: "c_user", value: "500" }], "بوت");
  await settle(200);

  const cb = listeners.get("500");
  cb(null, {
    type: "message_reaction",
    threadID: "888",
    senderID: "888",
    messageID: "reacted1",
    reaction: "❤️",
    isGroup: false,
  });

  await settle(150);
  assert.equal(sentMessages.length, 1, "auto-reply sent after reaction event");
  engine.stopAll();
});

test("dm-engine: ignores messages from non-target users", async () => {
  const sentMessages = [];
  const listeners = new Map();
  const api = makeFakeApi("600", sentMessages);
  api.listenMqtt = async (onEvent) => {
    listeners.set("600", onEvent);
    return () => listeners.delete("600");
  };
  const fakeLogin = makeFakeLogin(api);

  const store = createDmStore({ filePath: tmpFile(), log: silentLog });
  store.setAccountSettings("600", {
    targetUserId: "target_user",
    enabled: true,
    messageText: "should not send",
    delayMs: 50,
    cooldownMs: 10000,
  });

  const engine = createDmEngine({ store, log: silentLog, loginFn: fakeLogin });
  engine.startAccount("600", [{ key: "c_user", value: "600" }], "بوت");
  await settle(200);

  const cb = listeners.get("600");
  cb(null, {
    type: "message",
    threadID: "someone_else",
    senderID: "someone_else",
    messageID: "msg_other",
    body: "hello",
    isGroup: false,
  });

  await settle(200);
  assert.equal(sentMessages.length, 0, "no reply to non-target user");
  engine.stopAll();
});

test("dm-engine: ignores group messages (only DM)", async () => {
  const sentMessages = [];
  const listeners = new Map();
  const api = makeFakeApi("700", sentMessages);
  api.listenMqtt = async (onEvent) => {
    listeners.set("700", onEvent);
    return () => listeners.delete("700");
  };
  const fakeLogin = makeFakeLogin(api);

  const store = createDmStore({ filePath: tmpFile(), log: silentLog });
  store.setAccountSettings("700", {
    targetUserId: "999",
    enabled: true,
    messageText: "should not send in group",
    delayMs: 50,
    cooldownMs: 10000,
  });

  const engine = createDmEngine({ store, log: silentLog, loginFn: fakeLogin });
  engine.startAccount("700", [{ key: "c_user", value: "700" }], "بوت");
  await settle(200);

  const cb = listeners.get("700");
  cb(null, {
    type: "message",
    threadID: "group123",
    senderID: "999",
    messageID: "grp_msg",
    body: "hello",
    isGroup: true,
    participantIDs: ["999", "700"],
  });

  await settle(200);
  assert.equal(sentMessages.length, 0, "no reply in group thread");
  engine.stopAll();
});

test("dm-engine: disabled settings do not send", async () => {
  const sentMessages = [];
  const listeners = new Map();
  const api = makeFakeApi("800", sentMessages);
  api.listenMqtt = async (onEvent) => {
    listeners.set("800", onEvent);
    return () => listeners.delete("800");
  };
  const fakeLogin = makeFakeLogin(api);

  const store = createDmStore({ filePath: tmpFile(), log: silentLog });
  store.setAccountSettings("800", {
    targetUserId: "111",
    enabled: false,
    messageText: "disabled",
    delayMs: 50,
    cooldownMs: 10000,
  });

  const engine = createDmEngine({ store, log: silentLog, loginFn: fakeLogin });
  engine.startAccount("800", [{ key: "c_user", value: "800" }], "بوت");
  await settle(200);

  const cb = listeners.get("800");
  cb(null, {
    type: "message",
    threadID: "111",
    senderID: "111",
    messageID: "msg_disabled",
    body: "hi",
    isGroup: false,
  });

  await settle(200);
  assert.equal(sentMessages.length, 0, "no reply when disabled");
  engine.stopAll();
});

test("dm-engine: multiple accounts run independently", async () => {
  const listeners = new Map();
  const sentMessages = [];

  function makeMultiApi(id) {
    const api = makeFakeApi(id, sentMessages);
    api.listenMqtt = async (onEvent) => {
      listeners.set(id, onEvent);
      return () => listeners.delete(id);
    };
    return api;
  }

  function multiLogin(opts, loginOpts, cb) {
    const id = opts.appState[0].value;
    setImmediate(() => cb(null, makeMultiApi(id)));
  }

  const store = createDmStore({ filePath: tmpFile(), log: silentLog });
  store.setAccountSettings("acc_a", {
    targetUserId: "target_a",
    enabled: true,
    messageText: "reply A",
    delayMs: 50,
    cooldownMs: 10000,
  });
  store.setAccountSettings("acc_b", {
    targetUserId: "target_b",
    enabled: true,
    messageText: "reply B",
    delayMs: 50,
    cooldownMs: 10000,
  });

  const engine = createDmEngine({ store, log: silentLog, loginFn: multiLogin });
  engine.startAccount("acc_a", [{ key: "c_user", value: "acc_a" }], "بوت أ");
  engine.startAccount("acc_b", [{ key: "c_user", value: "acc_b" }], "بوت ب");
  await settle(200);

  assert.ok(listeners.has("acc_a"));
  assert.ok(listeners.has("acc_b"));

  listeners.get("acc_a")(null, {
    type: "message",
    threadID: "target_a",
    senderID: "target_a",
    messageID: "msg_a",
    body: "hi",
    isGroup: false,
  });

  listeners.get("acc_b")(null, {
    type: "message",
    threadID: "target_b",
    senderID: "target_b",
    messageID: "msg_b",
    body: "hi",
    isGroup: false,
  });

  await settle(200);
  assert.equal(sentMessages.length, 2);
  const texts = sentMessages.map((m) => m.text);
  assert.ok(texts.some((t) => t.includes("reply A")));
  assert.ok(texts.some((t) => t.includes("reply B")));
  engine.stopAll();
});

test("dm-engine: stopAll clears timers and stops listeners", async () => {
  const api = makeFakeApi("900", []);
  const fakeLogin = makeFakeLogin(api);
  const store = createDmStore({ filePath: tmpFile(), log: silentLog });
  store.setAccountSettings("900", {
    targetUserId: "111",
    enabled: true,
    messageText: "stop test",
    delayMs: 5000,
    cooldownMs: 10000,
  });

  const engine = createDmEngine({ store, log: silentLog, loginFn: fakeLogin });
  engine.startAccount("900", [{ key: "c_user", value: "900" }], "بوت");
  await settle(200);
  engine.stopAll();
  const entry = engine.accounts.get("900");
  assert.equal(entry.account.status, "stopped");
  assert.equal(entry.account.loggedIn, false);
});

test("dm-engine: errors in fca-eryxenx do not crash the engine", async () => {
  const failingLogin = (opts, loginOpts, cb) => {
    setImmediate(() => cb(new Error("connection failed")));
  };
  const store = createDmStore({ filePath: tmpFile(), log: silentLog });
  const engine = createDmEngine({ store, log: silentLog, loginFn: failingLogin });
  const result = engine.startAccount("err1", [{ key: "c_user", value: "err1" }], "بوت");
  assert.equal(result.ok, true);
  await settle(200);
  const entry = engine.accounts.get("err1");
  assert.ok(entry.account.lastError || entry.account.status !== "online");
  assert.notEqual(entry.account.status, "online");
  engine.stopAll();
});

test("dm-ref: set and get dmEngine reference", () => {
  const fakeEngine = { store: {}, stopAll: () => {} };
  setDmEngine(fakeEngine);
  assert.equal(getDmEngine(), fakeEngine);
  setDmEngine(null);
  assert.equal(getDmEngine(), null);
});

test("ws3-fca still loads correctly (no interference)", () => {
  const { login } = require("ws3-fca");
  assert.equal(typeof login, "function");
  const { login: eryxenxLogin } = require("fca-eryxenx");
  assert.equal(typeof eryxenxLogin, "function");
  assert.notEqual(login, eryxenxLogin, "ws3-fca and fca-eryxenx are separate modules");
});

test("zedhellking command loads and has correct interface", () => {
  const cmd = require("../Commands/zedhellking");
  assert.equal(cmd.name, "zedhellking");
  assert.equal(typeof cmd.execute, "function");
  assert.equal(typeof cmd.handleReply, "function");
  assert.equal(typeof cmd.stopAll, "function");
  assert.equal(typeof cmd.isValidUserId, "function");
});

test("zedhellking: isValidUserId validates correctly", () => {
  const cmd = require("../Commands/zedhellking");
  assert.ok(cmd.isValidUserId("1234567890"));
  assert.ok(cmd.isValidUserId("123456789012345678"));
  assert.ok(!cmd.isValidUserId("short"));
  assert.ok(!cmd.isValidUserId("abc"));
  assert.ok(!cmd.isValidUserId(""));
  assert.ok(!cmd.isValidUserId(null));
});
