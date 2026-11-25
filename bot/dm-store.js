const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./atomic-file");

const DEFAULT_FILE = path.join(__dirname, "data", "dm-settings.json");

const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_DELAY_MS = 60_000;

function createDmStore({ filePath, log } = {}) {
  const storePath = filePath || DEFAULT_FILE;
  let data = {};
  let loaded = false;

  function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = fs.readFileSync(storePath, "utf8");
      data = JSON.parse(raw);
      if (!data || typeof data !== "object") data = {};
    } catch (error) {
      if (error.code !== "ENOENT") {
        log.warn("dm-store", "تعذر تحميل إعدادات الرسائل الخاصة", { message: error.message });
      }
      data = {};
    }
  }

  function persist() {
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      writeFileAtomic(storePath, JSON.stringify(data, null, 2));
    } catch (error) {
      log.error("dm-store", "تعذر حفظ إعدادات الرسائل الخاصة", { message: error.message });
    }
  }

  function getAccountSettings(accountId) {
    load();
    const key = String(accountId);
    if (!data[key]) return null;
    return data[key];
  }

  function setAccountSettings(accountId, settings) {
    load();
    const key = String(accountId);
    data[key] = {
      targetUserId: String(settings.targetUserId || ""),
      enabled: Boolean(settings.enabled),
      cooldownMs: Number(settings.cooldownMs) || DEFAULT_COOLDOWN_MS,
      delayMs: Number(settings.delayMs) || DEFAULT_DELAY_MS,
      messageText: String(settings.messageText || ""),
      createdAt: data[key]?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    persist();
    return data[key];
  }

  function updateAccountSettings(accountId, patch) {
    load();
    const key = String(accountId);
    const current = data[key] || {};
    return setAccountSettings(accountId, { ...current, ...patch });
  }

  function removeAccountSettings(accountId) {
    load();
    const key = String(accountId);
    if (!data[key]) return false;
    delete data[key];
    persist();
    return true;
  }

  function listAll() {
    load();
    return Object.entries(data).map(([id, s]) => ({ accountId: id, ...s }));
  }

  return {
    getAccountSettings,
    setAccountSettings,
    updateAccountSettings,
    removeAccountSettings,
    listAll,
  };
}

module.exports = { createDmStore, DEFAULT_COOLDOWN_MS, DEFAULT_DELAY_MS };
