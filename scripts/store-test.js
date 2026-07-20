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
  assert.equal(recovered.tasks[0].title, "測試");
  assert.ok(fs.readdirSync(directory).some((name) => name.includes(".corrupt-")));
  console.log("✓ revision 遞增、原子備份與損毀還原");
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
