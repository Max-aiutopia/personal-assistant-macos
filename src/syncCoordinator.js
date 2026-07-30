function createCoalescedRunner(runOnce) {
  if (typeof runOnce !== "function") {
    throw new TypeError("runOnce 必須是函式。");
  }

  let activePromise = null;
  let requested = false;

  async function drain() {
    let latestResult;
    let latestError = null;
    do {
      requested = false;
      try {
        latestResult = await runOnce();
        latestError = null;
      } catch (error) {
        latestError = error;
      }
    } while (requested);

    if (latestError) throw latestError;
    return latestResult;
  }

  function run() {
    requested = true;
    if (!activePromise) {
      activePromise = drain();
      activePromise.then(
        () => {
          activePromise = null;
        },
        () => {
          activePromise = null;
        }
      );
    }
    return activePromise;
  }

  return {
    run,
    isRunning: () => Boolean(activePromise)
  };
}

module.exports = { createCoalescedRunner };
