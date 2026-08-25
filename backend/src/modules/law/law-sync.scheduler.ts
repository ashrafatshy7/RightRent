import { syncLawKnowledgeBase } from "./law-sync.service.js";

export const LAW_SYNC_INTERVAL_MS = 60 * 60 * 1_000;

let timer: NodeJS.Timeout | null = null;
let running = false;

async function runScheduledCheck() {
  if (running) return;
  running = true;
  try {
    const results = await syncLawKnowledgeBase();
    const failures = results.filter((result) => result.status === "FAILED").length;
    console.log(`Hourly law check completed: ${results.length - failures} succeeded, ${failures} failed.`);
  } catch (error) {
    console.error("Hourly law check failed before completion.", error);
  } finally {
    running = false;
  }
}

export function startLawSyncScheduler() {
  if (timer) return;
  void runScheduledCheck();
  timer = setInterval(() => void runScheduledCheck(), LAW_SYNC_INTERVAL_MS);
}

export function stopLawSyncScheduler() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
