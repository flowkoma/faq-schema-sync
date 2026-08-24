// Debounced, deduplicated, sequential job queue.
//
// - enqueueDebounced(key, jobFn): waits `debounceMs`; if the same key arrives
//   again in that window, the timer resets and only the LAST jobFn runs.
//   This absorbs the burst of collection_item_changed events an editor
//   produces while saving repeatedly.
// - Jobs execute one at a time. Actual API pacing is enforced inside
//   webflowClient, so this stays simple.
// - If a job for a key is already running and the same key is enqueued again,
//   it will run once more after the current run completes (never in parallel).

import { config } from './config.js';

const debounceTimers = new Map(); // key -> { timer, jobFn }
const pending = [];               // [{ key, jobFn }]
const pendingKeys = new Set();
let running = false;

export function enqueueDebounced(key, jobFn, debounceMs = config.debounceMs) {
  const existing = debounceTimers.get(key);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(() => {
    debounceTimers.delete(key);
    push(key, jobFn);
  }, debounceMs);

  debounceTimers.set(key, { timer, jobFn });
  console.log(`[queue] debounced "${key}" (${debounceMs}ms window)`);
}

export function enqueueImmediate(key, jobFn) {
  push(key, jobFn);
}

function push(key, jobFn) {
  if (pendingKeys.has(key)) {
    console.log(`[queue] "${key}" already pending — deduped`);
    return;
  }
  pending.push({ key, jobFn });
  pendingKeys.add(key);
  void drain();
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (pending.length > 0) {
      const { key, jobFn } = pending.shift();
      pendingKeys.delete(key);
      const started = Date.now();
      console.log(`[queue] ▶ running "${key}"`);
      try {
        const outcome = await jobFn();
        console.log(`[queue] ✔ "${key}" — ${outcome ?? 'done'} (${Date.now() - started}ms)`);
      } catch (err) {
        console.error(`[queue] ✖ "${key}" failed after ${Date.now() - started}ms:`, err.message);
      }
    }
  } finally {
    running = false;
  }
}

export function queueStats() {
  return {
    debouncing: debounceTimers.size,
    pending: pending.length,
    running,
  };
}
