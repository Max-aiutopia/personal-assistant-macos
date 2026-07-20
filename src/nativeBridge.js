const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

/**
 * Shared utilities for launching native Swift helpers (VoiceRecognizer / CalendarBridge).
 * Voice now prefers direct stdout streaming.
 * Calendar uses file for .app path and direct+stdin/stdout for binary path.
 */

function waitForFile(filePath, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(filePath)) {
      resolve();
      return;
    }

    const startedAt = Date.now();
    let watcher;
    let pollTimer;

    const done = (err) => {
      if (watcher) { try { watcher.close(); } catch {} }
      if (pollTimer) clearInterval(pollTimer);
      if (err) reject(err); else resolve();
    };

    // Prefer fs.watch (efficient, event driven)
    try {
      watcher = fs.watch(path.dirname(filePath), (eventType, filename) => {
        const full = filename ? path.join(path.dirname(filePath), filename) : filePath;
        if (full === filePath && fs.existsSync(filePath)) {
          done();
        }
      });
    } catch {
      // fs.watch not reliable on this FS, fall back
    }

    // Light safety poll
    pollTimer = setInterval(() => {
      if (fs.existsSync(filePath)) {
        done();
      } else if (Date.now() - startedAt >= timeoutMs) {
        done(new Error("等待原生元件回應逾時。"));
      }
    }, 300);

    // Hard timeout guard
    setTimeout(() => {
      if (!fs.existsSync(filePath)) {
        done(new Error("等待原生元件回應逾時。"));
      }
    }, timeoutMs);
  });
}

/**
 * Spawn a native binary directly and collect JSONL from stdout.
 * Returns a promise that resolves with array of parsed payloads when child exits.
 * Good for one-shot bridges (status, sync).
 */
function runDirectBinary(binaryPath, args = [], inputPayload = null, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(binaryPath)) {
      reject(new Error("找不到原生元件，請重新安裝。"));
      return;
    }

    const child = spawn(binaryPath, args, {
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = timeoutMs > 0 ? setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000);
      finish(() => reject(new Error("行事曆同步逾時")));
    }, timeoutMs) : null;

    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

    child.stdin.on("error", () => {});
    child.on("error", (error) => finish(() => reject(error)));
    child.on("exit", (code) => {
      if (code !== 0) {
        finish(() => reject(new Error(`${stderr.trim() || "原生元件結束"}（代碼 ${code}）`)));
        return;
      }
      try {
        const lines = stdout.trim().split("\n").filter(Boolean);
        const result = JSON.parse(lines.at(-1) || "{}");
        finish(() => resolve(result));
      } catch (e) {
        finish(() => reject(new Error("無法解析原生元件輸出：" + e.message)));
      }
    });

    if (inputPayload) {
      child.stdin.end(JSON.stringify(inputPayload));
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Parse incremental JSONL lines (used by streaming voice events).
 */
function processJsonLines(buffered, onPayload) {
  const lines = buffered.split("\n");
  const remainder = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const payload = JSON.parse(line);
      onPayload(payload);
    } catch (e) {
      // caller can log
    }
  }
  return remainder;
}

module.exports = {
  waitForFile,
  runDirectBinary,
  processJsonLines
};
