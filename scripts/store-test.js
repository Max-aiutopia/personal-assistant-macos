const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStore } = require("../src/store");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "glow-store-test-"));
try {
  const store = createStore(directory);
  const initial = store.read();
  assert.equal(initial.revision, 0);
  initial.tasks.push({ id: "one", title: "測試" });
  const first = store.write(initial);
  assert.equal(first.revision, 1);
  store.flush();

  const second = store.write(first);
  assert.equal(second.revision, 2);
  store.flush();
  assert.ok(fs.existsSync(`${store.dataPath}.bak`));

  const durableInput = store.read();
  durableInput.tasks.push({ id: "durable", title: "立即保存" });
  const durable = store.writeDurable(durableInput);
  assert.equal(durable.revision, 3);
  assert.equal(
    JSON.parse(fs.readFileSync(store.dataPath, "utf8")).tasks.at(-1).title,
    "立即保存",
    "writeDurable 回傳前應已寫入磁碟"
  );
  const durableReload = createStore(directory).read();
  assert.equal(durableReload.revision, 3);
  assert.equal(durableReload.tasks.at(-1).title, "立即保存");

  const beforeFailure = store.read();
  const beforeFailureDisk = fs.readFileSync(store.dataPath, "utf8");
  const originalFsyncSync = fs.fsyncSync;
  fs.fsyncSync = () => {
    const error = new Error("injected fsync failure");
    error.code = "EIO";
    throw error;
  };
  try {
    const failedInput = structuredClone(beforeFailure);
    failedInput.tasks.push({ id: "must-not-commit", title: "不應提交" });
    assert.throws(
      () => store.writeDurable(failedInput),
      /injected fsync failure/
    );
  } finally {
    fs.fsyncSync = originalFsyncSync;
  }
  assert.equal(store.read().revision, beforeFailure.revision);
  assert.deepEqual(store.read().tasks, beforeFailure.tasks);
  assert.equal(fs.readFileSync(store.dataPath, "utf8"), beforeFailureDisk);
  const failureReload = createStore(directory).read();
  assert.equal(failureReload.revision, beforeFailure.revision);
  assert.deepEqual(failureReload.tasks, beforeFailure.tasks);

  fs.writeFileSync(store.dataPath, "{broken", "utf8");
  let recovery;
  const recoveredStore = createStore(directory, { onRecovery: (value) => { recovery = value; } });
  const originalConsoleError = console.error;
  console.error = () => {};
  let recovered;
  try {
    recovered = recoveredStore.read();
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(recovery?.restored, true);
  assert.equal(recovered.tasks.at(-1).title, "測試");
  assert.ok(fs.readdirSync(directory).some((name) => name.includes(".corrupt-")));
  console.log("✓ revision 遞增、durable 即時落盤、失敗回滾、原子備份與損毀還原");
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
