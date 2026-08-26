import { randomUUID } from "node:crypto";
import { env } from "../../config/env.js";
import { getStore } from "../../shared/data/store.js";
import { syncLawKnowledgeBase } from "./law-sync.service.js";

export const LAW_SYNC_INTERVAL_MS = 60 * 60 * 1_000;

let timer: NodeJS.Timeout | null = null;
let running = false;
const schedulerOwnerId = randomUUID();

async function runScheduledCheck() {
  if (running) return;
  running = true;
  let leaseAcquired = false;
  let completed = false;
  try {
    const store = await getStore();
    leaseAcquired = await store.acquireLawSyncLease(
      schedulerOwnerId,
      new Date(Date.now() + env.lawSyncLeaseMinutes * 60_000),
    );
    if (!leaseAcquired) return;
    const results = await syncLawKnowledgeBase();
    const counts = Object.fromEntries(
      [...new Set(results.map((result) => result.status))]
        .map((status) => [status, results.filter((result) => result.status === status).length]),
    );
    console.log(`Hourly law check completed: ${JSON.stringify(counts)}.`);
    completed = true;
  } catch (error) {
    console.error("Hourly law check failed before completion.", error);
  } finally {
    if (leaseAcquired && !completed) {
      await (await getStore()).releaseLawSyncLease(schedulerOwnerId).catch(() => undefined);
    }
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
