const assert = require("node:assert/strict");
const { mergeJournalPatch } = require("../src/utils");

const differentFields = mergeJournalPatch(
  { done: "舊完成", feeling: "平靜" },
  { feeling: "很好" },
  { done: "舊完成\n語音新增", feeling: "平靜" }
);
assert.deepEqual(differentFields.conflicts, []);
assert.equal(differentFields.entry.done, "舊完成\n語音新增");
assert.equal(differentFields.entry.feeling, "很好");

const appendedDone = mergeJournalPatch(
  { done: "開始" },
  { done: "開始\n畫面新增" },
  { done: "開始\n語音新增" }
);
assert.deepEqual(appendedDone.conflicts, []);
assert.equal(appendedDone.entry.done, "開始\n語音新增\n畫面新增");

const sameFieldConflict = mergeJournalPatch(
  { feeling: "普通" },
  { feeling: "開心" },
  { feeling: "疲倦" }
);
assert.deepEqual(sameFieldConflict.conflicts, ["feeling"]);
assert.equal(sameFieldConflict.entry.feeling, "疲倦");

const substringAppend = mergeJournalPatch(
  { done: "" },
  { done: "cat" },
  { done: "scatter" }
);
assert.deepEqual(substringAppend.conflicts, []);
assert.equal(substringAppend.entry.done, "scatter\ncat");

console.log("✓ 日誌逐欄位合併、追加保留與衝突偵測");
