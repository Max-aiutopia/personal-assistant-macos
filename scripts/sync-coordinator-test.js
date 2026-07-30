const assert = require("node:assert/strict");
const { createCoalescedRunner } = require("../src/syncCoordinator");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(message);
}

async function testTrailingRunUsesLatestState() {
  let version = 1;
  const calls = [];
  const pending = [];
  const runner = createCoalescedRunner(() => {
    calls.push(version);
    const next = deferred();
    pending.push(next);
    return next.promise;
  });

  const first = runner.run();
  await waitFor(() => calls.length === 1, "第一輪同步未啟動");
  version = 2;
  const second = runner.run();
  pending[0].resolve("第一輪");
  await waitFor(() => calls.length === 2, "同步期間的新要求沒有觸發尾隨同步");
  assert.deepEqual(calls, [1, 2]);
  pending[1].resolve("第二輪");
  assert.equal(await first, "第二輪");
  assert.equal(await second, "第二輪");
  assert.equal(runner.isRunning(), false);
}

async function testQueuedRetryCanRecover() {
  let calls = 0;
  const pending = [];
  const runner = createCoalescedRunner(() => {
    calls += 1;
    const next = deferred();
    pending.push(next);
    return next.promise;
  });

  const first = runner.run();
  await waitFor(() => calls === 1, "失敗測試第一輪未啟動");
  const second = runner.run();
  pending[0].reject(new Error("暫時失敗"));
  await waitFor(() => calls === 2, "失敗後沒有執行已排隊的最新同步");
  pending[1].resolve("已恢復");
  assert.equal(await first, "已恢復");
  assert.equal(await second, "已恢復");
}

async function testUnqueuedFailurePropagates() {
  const runner = createCoalescedRunner(async () => {
    throw new Error("同步失敗");
  });
  await assert.rejects(runner.run(), /同步失敗/);
  assert.equal(runner.isRunning(), false);
}

async function main() {
  await testTrailingRunUsesLatestState();
  await testQueuedRetryCanRecover();
  await testUnqueuedFailurePropagates();
  console.log("✓ 同步要求合併、尾隨重跑、錯誤恢復與失敗傳遞");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
