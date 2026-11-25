const { getStartMessage: getQasfStartMessage } = require("./قصف");
const { DEFAULT_COOLDOWN_MS, DEFAULT_DELAY_MS } = require("../dm-store");
const { getDmEngine } = require("../dm-ref");

const STEP_ASK_ID = "ask_id";
const STEP_CONFIRM = "confirm";

const pendingSetup = new Map();

function getDmStore() {
  const engine = getDmEngine();
  return engine ? engine.store : null;
}

function getSpamText() {
  try {
    return getQasfStartMessage() || "";
  } catch {
    return "";
  }
}

function isValidUserId(id) {
  return /^\d{10,20}$/.test(String(id || "").trim());
}

async function execute(api, event) {
  const threadID = String(event.threadID || "");
  const senderID = String(event.senderID || "");
  const body = (event.body || "").trim();
  const engine = getDmEngine();

  if (body === "zedhellking ايقاف" || body === "zedhellking إيقاف") {
    if (!engine) {
      await api.sendMessage("❌ نظام الرسائل الخاصة غير متاح.", threadID);
      return;
    }
    const botID =
      typeof api.getCurrentUserID === "function"
        ? String(api.getCurrentUserID() || "")
        : "";
    const settings = getDmStore()?.getAccountSettings(botID);
    if (!settings || !settings.enabled) {
      await api.sendMessage("⚠️ نظام الرسائل الخاصة غير مفعّل لهذا الحساب.", threadID);
      return;
    }
    getDmStore().updateAccountSettings(botID, { enabled: false });
    engine.disableDmForAccount(botID);
    await api.sendMessage("✅ تم إيقاف نظام الرسائل الخاصة فوراً لهذا الحساب.", threadID);
    return;
  }

  if (body === "zedhellking حالة") {
    if (!engine) {
      await api.sendMessage("❌ نظام الرسائل الخاصة غير متاح.", threadID);
      return;
    }
    const botID =
      typeof api.getCurrentUserID === "function"
        ? String(api.getCurrentUserID() || "")
        : "";
    const settings = getDmStore()?.getAccountSettings(botID);
    if (!settings) {
      await api.sendMessage("ℹ️ لا توجد إعدادات للرسائل الخاصة لهذا الحساب.", threadID);
      return;
    }
    const status = settings.enabled ? "مفعّل ✅" : "متوقف ⛔";
    await api.sendMessage(
      `📊 حالة zedhellking:\n` +
        `الحساب: ${botID}\n` +
        `الهدف: ${settings.targetUserId}\n` +
        `الحالة: ${status}\n` +
        `التأخير: ${Math.round((settings.delayMs || DEFAULT_DELAY_MS) / 1000)} ثانية\n` +
        `التهدئة: ${Math.round((settings.cooldownMs || DEFAULT_COOLDOWN_MS) / 1000)} ثانية`,
      threadID,
    );
    return;
  }

  if (body === "zedhellking") {
    const botID =
      typeof api.getCurrentUserID === "function"
        ? String(api.getCurrentUserID() || "")
        : "";

    pendingSetup.set(`${botID}:${senderID}`, {
      step: STEP_ASK_ID,
      botID,
      threadID,
      senderID,
      createdAt: Date.now(),
    });

    await api.sendMessage("ضع ID الشخص المستهدف.", threadID);
    return;
  }

  if (body.startsWith("zedhellking ")) {
    const rest = body.slice("zedhellking ".length).trim();
    if (rest && !isValidUserId(rest)) {
      await api.sendMessage("❌ ID غير صالح. يجب أن يكون رقماً (10-20 رقم).", threadID);
      return;
    }
    if (!rest) return;
    await processTargetId(api, event, rest);
  }
}

async function processTargetId(api, event, targetId) {
  const threadID = String(event.threadID || "");
  const senderID = String(event.senderID || "");
  const botID =
    typeof api.getCurrentUserID === "function"
      ? String(api.getCurrentUserID() || "")
      : "";

  const settings = getDmStore()?.getAccountSettings(botID) || {};
  const spamText = settings.messageText || getSpamText();

  pendingSetup.set(`${botID}:${senderID}`, {
    step: STEP_CONFIRM,
    botID,
    targetUserId: targetId,
    threadID,
    senderID,
    messageText: spamText,
  });

  await api.sendMessage(
    `📋 تأكيد التفعيل:\n` +
      `الحساب المنفذ: ${botID}\n` +
      `الهدف: ${targetId}\n` +
      `نص الرسالة: (نص قصف الحالي)\n` +
      `التأخير: ${Math.round(DEFAULT_DELAY_MS / 1000)} ثانية\n` +
      `التهدئة: ${Math.round(DEFAULT_COOLDOWN_MS / 1000)} ثانية\n\n` +
      `أرسل "تأكيد" للتفعيل أو "إلغاء" للإلغاء.`,
    threadID,
  );
}

async function handleReply(api, event) {
  const body = (event.body || "").trim();
  const senderID = String(event.senderID || "");
  const botID =
    typeof api.getCurrentUserID === "function"
      ? String(api.getCurrentUserID() || "")
      : "";

  const key = `${botID}:${senderID}`;
  const pending = pendingSetup.get(key);

  if (!pending) return false;

  if (Date.now() - pending.createdAt > 120000) {
    pendingSetup.delete(key);
    return false;
  }

  if (pending.step === STEP_ASK_ID) {
    const targetId = body.trim();
    if (!isValidUserId(targetId)) {
      await api.sendMessage("❌ ID غير صالح. يجب أن يكون رقماً (10-20 رقم).", pending.threadID);
      return true;
    }
    pendingSetup.delete(key);
    await processTargetId(api, event, targetId);
    return true;
  }

  if (pending.step === STEP_CONFIRM) {
    if (body === "تأكيد" || body === "تاكيد") {
      const store = getDmStore();
      if (!store) {
        await api.sendMessage("❌ نظام الرسائل الخاصة غير متاح.", pending.threadID);
        pendingSetup.delete(key);
        return true;
      }

      store.setAccountSettings(pending.botID, {
        targetUserId: pending.targetUserId,
        enabled: true,
        cooldownMs: DEFAULT_COOLDOWN_MS,
        delayMs: DEFAULT_DELAY_MS,
        messageText: pending.messageText,
      });

      const engine = getDmEngine();
      if (engine) {
        engine.enableDmForAccount(pending.botID);
      }

      await api.sendMessage(
        `✅ تم تفعيل نظام الرسائل الخاصة:\n` +
          `الحساب: ${pending.botID}\n` +
          `الهدف: ${pending.targetUserId}\n` +
          `التأخير: ${Math.round(DEFAULT_DELAY_MS / 1000)} ثانية\n` +
          `التهدئة: ${Math.round(DEFAULT_COOLDOWN_MS / 1000)} ثانية\n\n` +
          `للإيقاف: zedhellking ايقاف`,
        pending.threadID,
      );
      pendingSetup.delete(key);
      return true;
    }

    if (body === "إلغاء" || body === "الغاء") {
      await api.sendMessage("❌ تم إلغاء الإعداد.", pending.threadID);
      pendingSetup.delete(key);
      return true;
    }

    return true;
  }

  return false;
}

function stopAll() {
  pendingSetup.clear();
}

module.exports = {
  name: "zedhellking",
  execute,
  handleReply,
  stopAll,
  isValidUserId,
};
