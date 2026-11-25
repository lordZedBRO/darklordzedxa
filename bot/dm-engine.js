const { createListenerSession } = require("./listener-session");
const { createDmStore, DEFAULT_COOLDOWN_MS, DEFAULT_DELAY_MS } = require("./dm-store");
const { classifyError } = require("./login-errors");

const LOGIN_OPTIONS = {
  listenEvents: true,
  selfListen: false,
  autoMarkDelivery: false,
  autoMarkRead: false,
  forceLogin: false,
  autoReconnect: false,
  online: true,
};

const RECONNECT_BASE_MS = 15000;
const RECONNECT_MAX_MS = 300000;

function isPrivateThread(event) {
  if (!event) return false;
  if (event.isGroup === false) return true;
  if (event.threadType === "dm" || event.threadType === "user") return true;
  const tid = String(event.threadID || "");
  return /^\d{10,15}$/.test(tid) && !event.participantIDs;
}

function createDmAccount({ id, name, appState, store, log, loginFn, onReady }) {
  const fcaLogin = loginFn || require("fca-eryxenx").login;
  const account = {
    id,
    name,
    api: null,
    listener: createListenerSession({ log }),
    status: "stopped",
    loggedIn: false,
    listenerActive: false,
    loginInFlight: false,
    reconnectTimer: null,
    stopping: false,
    lastError: null,
    lastConnectedAt: null,
  };

  const sentTracker = new Map();
  const cooldownTracker = new Map();
  const pendingTimers = new Map();
  let stopFlag = false;

  function clearReconnectTimer() {
    if (account.reconnectTimer) {
      clearTimeout(account.reconnectTimer);
      account.reconnectTimer = null;
    }
  }

  function clearAllPending() {
    for (const timer of pendingTimers.values()) {
      clearTimeout(timer);
    }
    pendingTimers.clear();
  }

  function scheduleReconnect(reason) {
    if (account.stopping) return;
    clearReconnectTimer();
    const attempt = (account.reconnectAttempts || 0) + 1;
    account.reconnectAttempts = attempt;
    const backoff = Math.min(
      RECONNECT_BASE_MS * 2 ** Math.min(attempt - 1, 4),
      RECONNECT_MAX_MS,
    );
    const delay = backoff * (0.8 + Math.random() * 0.4);
    account.status = "reconnecting";
    log.warn("dm-engine", "إعادة محاولة اتصال الرسائل الخاصة", {
      id: account.id,
      reason,
      attempt,
      delayMs: Math.round(delay),
    });
    account.reconnectTimer = setTimeout(() => {
      account.reconnectTimer = null;
      start();
    }, delay);
    account.reconnectTimer.unref();
  }

  function getCooldownKey(targetUserId, eventSignature) {
    return `${targetUserId}:${eventSignature}`;
  }

  function isInCooldown(targetUserId, eventSignature, cooldownMs) {
    const key = getCooldownKey(targetUserId, eventSignature);
    const lastTime = cooldownTracker.get(key);
    if (!lastTime) return false;
    if (Date.now() - lastTime < cooldownMs) return true;
    cooldownTracker.delete(key);
    return false;
  }

  function markCooldown(targetUserId, eventSignature) {
    const key = getCooldownKey(targetUserId, eventSignature);
    cooldownTracker.set(key, Date.now());
  }

  function isAlreadySent(targetUserId, eventSignature) {
    const key = `${targetUserId}:${eventSignature}`;
    return sentTracker.has(key);
  }

  function markSent(targetUserId, eventSignature) {
    const key = `${targetUserId}:${eventSignature}`;
    sentTracker.set(key, Date.now());
  }

  function getEventSignature(event) {
    if (event.type === "message_reaction") {
      return `reaction:${event.messageID || ""}:${event.reaction || ""}`;
    }
    if (event.type === "message_reply") {
      return `reply:${event.messageID || ""}`;
    }
    return `message:${event.messageID || ""}`;
  }

  function shouldProcessEvent(event, settings) {
    if (!settings || !settings.enabled) return false;
    if (!isPrivateThread(event)) return false;
    const targetUserId = String(settings.targetUserId || "");
    const senderID = String(event.senderID || "");
    if (targetUserId && senderID !== targetUserId) return false;
    return true;
  }

  async function sendAutoMessage(threadID, settings, event) {
    if (!account.api) return;
    const targetUserId = String(settings.targetUserId || "");
    const eventSig = getEventSignature(event);

    if (isAlreadySent(targetUserId, eventSig)) {
      log.info("dm-engine", "تم تخطي الحدث — رسالة مرسلة مسبقاً لهذا الحدث", {
        id: account.id,
        eventSig,
      });
      return;
    }

    if (isInCooldown(targetUserId, eventSig, settings.cooldownMs || DEFAULT_COOLDOWN_MS)) {
      log.info("dm-engine", "تم تخطي الحدث — ضمن فترة التهدئة", {
        id: account.id,
        eventSig,
      });
      return;
    }

    markSent(targetUserId, eventSig);
    markCooldown(targetUserId, eventSig);

    const delayMs = settings.delayMs || DEFAULT_DELAY_MS;
    const timer = setTimeout(async () => {
      pendingTimers.delete(getEventSignature(event));
      if (stopFlag || !account.api || !settings.enabled) return;
      try {
        await account.api.sendMessage(settings.messageText, threadID);
        log.info("dm-engine", "تم إرسال الرسالة الخاصة تلقائياً", {
          id: account.id,
          threadID,
          delayMs,
        });
      } catch (error) {
        log.error("dm-engine", "فشل إرسال الرسالة الخاصة", {
          id: account.id,
          message: error.message || error,
        });
      }
    }, delayMs);
    pendingTimers.set(getEventSignature(event), timer);
    timer.unref();

    log.info("dm-engine", "تمت جدولة الرسالة الخاصة", {
      id: account.id,
      threadID,
      delayMs,
    });
  }

  function onListenerEvent(api, err, event) {
    if (err) {
      const kind = classifyError(err);
      account.lastError = kind;
      log.error("dm-engine", "خطأ في مستمع الرسائل الخاصة", { id: account.id, kind });
      if (kind === "checkpoint" || kind === "session_expired") {
        stopListener(kind);
        account.status = "needs_attention";
        return;
      }
      stopListener(kind);
      scheduleReconnect(kind);
      return;
    }

    if (!event) return;
    if (event.type === "message" || event.type === "message_reply") {
      if (event.senderID && api && typeof api.getCurrentUserID === "function") {
        const botID = String(api.getCurrentUserID() || "");
        if (String(event.senderID) === botID) return;
      }
    }

    const settings = store.getAccountSettings(account.id);
    if (!shouldProcessEvent(event, settings)) return;

    const threadID = String(event.threadID);
    const eventSig = getEventSignature(event);

    if (
      event.type === "message" ||
      event.type === "message_reply" ||
      event.type === "message_reaction"
    ) {
      sendAutoMessage(threadID, settings, event).catch((error) => {
        log.error("dm-engine", "خطأ في معالجة حدث الرسائل الخاصة", {
          id: account.id,
          message: error.message || error,
        });
      });
    }
  }

  async function startListening() {
    try {
      const result = await account.listener.start(account.api, (err, event) =>
        onListenerEvent(account.api, err, event),
      );
      if (!result.started) return;
      account.listenerActive = true;
      account.status = "online";
      account.reconnectAttempts = 0;
      account.lastConnectedAt = new Date().toISOString();
      log.info("dm-engine", "مستمع الرسائل الخاصة يعمل", { id: account.id, name: account.name });
      if (onReady) onReady(account);
    } catch (error) {
      log.error("dm-engine", "فشل بدء مستمع الرسائل الخاصة", {
        id: account.id,
        message: error.message,
      });
      scheduleReconnect("listen_start_failed");
    }
  }

  function onLoginResult(err, api) {
    account.loginInFlight = false;
    if (account.stopping) {
      if (api && typeof api.logout === "function") {
        try { api.logout(() => {}); } catch {}
      }
      return;
    }

    if (err) {
      const kind = classifyError(err);
      account.loggedIn = false;
      account.lastError = kind;
      log.error("dm-engine", "فشل تسجيل دخول الرسائل الخاصة", { id: account.id, kind });
      if (kind === "checkpoint" || kind === "session_expired") {
        account.status = "needs_attention";
        return;
      }
      account.status = "reconnecting";
      scheduleReconnect("login_failed");
      return;
    }

    account.api = api;
    account.loggedIn = true;
    account.lastError = null;
    log.info("dm-engine", "تم تسجيل دخول حساب الرسائل الخاصة", {
      id: account.id,
      name: account.name,
    });
    if (api.ctx && api.ctx.lastSeqId) api.ctx.firstListen = true;
    startListening();
  }

  function start() {
    if (account.stopping || account.loginInFlight || account.listener.active) return;
    if (!account.appState) {
      account.status = "no_cookies";
      return;
    }
    stopFlag = false;
    account.loginInFlight = true;
    account.status = "connecting";
    fcaLogin({ appState: account.appState }, LOGIN_OPTIONS, onLoginResult);
  }

  function stopListener(reason) {
    account.listener.stop(reason);
    account.listenerActive = false;
    account.api = null;
  }

  function stop() {
    account.stopping = true;
    stopFlag = true;
    clearReconnectTimer();
    clearAllPending();
    stopListener("stopped");
    account.loggedIn = false;
    account.status = "stopped";
  }

  function disableDm() {
    stopFlag = true;
    clearAllPending();
  }

  function enableDm() {
    stopFlag = false;
  }

  return { account, start, stop, disableDm, enableDm };
}

function createDmEngine({ store: externalStore, log, loginFn, onReady } = {}) {
  const store = externalStore || createDmStore({ log });
  const accounts = new Map();

  function startAccount(accountId, appState, name) {
    const key = String(accountId);
    let entry = accounts.get(key);
    if (entry) {
      if (entry.account.listener.active || entry.account.loginInFlight) {
        return { ok: false, error: "already_running" };
      }
      entry.account.stopping = false;
      entry.account.appState = appState;
      entry.start();
      return { ok: true };
    }
    entry = createDmAccount({
      id: key,
      name: name || key,
      appState,
      store,
      log,
      loginFn,
      onReady,
    });
    accounts.set(key, entry);
    entry.start();
    return { ok: true };
  }

  function stopAccount(accountId) {
    const entry = accounts.get(String(accountId));
    if (!entry) return { ok: false, error: "not_running" };
    entry.stop();
    return { ok: true };
  }

  function stopAll() {
    for (const entry of accounts.values()) {
      entry.stop();
    }
  }

  function disableDmForAccount(accountId) {
    const entry = accounts.get(String(accountId));
    if (entry) entry.disableDm();
  }

  function enableDmForAccount(accountId) {
    const entry = accounts.get(String(accountId));
    if (entry) entry.enableDm();
  }

  function statuses() {
    return Array.from(accounts.values()).map((entry) => ({
      id: entry.account.id,
      name: entry.account.name,
      status: entry.account.status,
      loggedIn: entry.account.loggedIn,
      listenerActive: entry.account.listenerActive,
      lastError: entry.account.lastError,
    }));
  }

  return {
    store,
    startAccount,
    stopAccount,
    stopAll,
    disableDmForAccount,
    enableDmForAccount,
    statuses,
    accounts,
  };
}

module.exports = { createDmEngine, createDmAccount, isPrivateThread, DEFAULT_COOLDOWN_MS, DEFAULT_DELAY_MS };
