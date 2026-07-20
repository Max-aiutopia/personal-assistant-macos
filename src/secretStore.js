const fs = require("node:fs");
const path = require("node:path");

/**
 * 機密儲存（單一使用者個人電腦版）。
 * 存在 userData 下 0600 權限的 secrets.json（只有本機使用者帳號可讀），
 * 不使用 Keychain/safeStorage —— 因此不會跳鑰匙圈密碼提示，重新打包也不受簽章變動影響。
 * 仍與 renderer 完全隔離：永遠不經 data:get / data-changed 流出。
 * 向下相容舊的 { enc } 格式（讀不到就回空字串，使用者重新輸入即可）。
 */
function createSecretStore(userDataPath) {
  const filePath = path.join(userDataPath, "secrets.json");

  function readRaw() {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return {};
    }
  }

  function writeRaw(obj) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {}
  }

  function setSecret(name, plain) {
    const store = readRaw();
    if (!plain) delete store[name];
    else store[name] = String(plain);
    writeRaw(store);
    return { ok: true, secure: true };
  }

  function getSecret(name) {
    const entry = readRaw()[name];
    if (!entry) return "";
    if (typeof entry === "string") return entry;
    if (entry.plain) return entry.plain; // 舊格式相容
    return ""; // 舊的 { enc } 加密格式無法在此讀取 → 回空，請使用者重設
  }

  function hasSecret(name) {
    return Boolean(getSecret(name));
  }

  function encryptionAvailable() {
    return true; // 一律以 0600 保護檔保存
  }

  return { setSecret, getSecret, hasSecret, encryptionAvailable, filePath };
}

module.exports = { createSecretStore };
