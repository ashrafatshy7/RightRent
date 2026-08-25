import { app } from "./app.js";
import { env } from "./config/env.js";
import { startLawSyncScheduler, stopLawSyncScheduler } from "./modules/law/law-sync.scheduler.js";
import { closeStore } from "./shared/data/store.js";

const server = app.listen(env.port, () => {
  console.log(`RightRent backend listening on http://localhost:${env.port}`);
  startLawSyncScheduler();
});

function shutdown(signal: string) {
  console.log(`${signal} received. Closing HTTP server.`);
  stopLawSyncScheduler();
  server.close(async (error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
    await closeStore();
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
