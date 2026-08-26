import { Router } from "express";
import { env } from "../../config/env.js";
import { getStore } from "../../shared/data/store.js";
import { checkNerReadiness } from "../analyses/anonymization.service.js";
import { MONITORED_LAW_SOURCES } from "../law/law-source.catalog.js";

export const healthRouter = Router();

healthRouter.get("/", (_request, response) => {
  response.json({
    status: "ok",
    service: "rightrent-backend",
    timestamp: new Date().toISOString(),
  });
});

healthRouter.get("/ready", async (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  try {
    const [store, ner] = await Promise.all([
      (await getStore()).healthCheck(),
      checkNerReadiness(),
    ]);
    const aiReady = env.analysisProvider === "deterministic" || (
      store.activeLawCount === MONITORED_LAW_SOURCES.length
      && store.activeEmbeddingCount > 0
      && store.vectorSearch
      && ner.ready
    );
    const ready = store.database && aiReady;
    response.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "not_ready",
      database: store.database,
      analysisProvider: env.analysisProvider,
      activeLaws: `${store.activeLawCount}/${MONITORED_LAW_SOURCES.length}`,
      activeEmbeddingCount: store.activeEmbeddingCount,
      vectorSearch: store.vectorSearch,
      piiNer: ner,
      timestamp: new Date().toISOString(),
    });
  } catch {
    response.status(503).json({
      status: "not_ready",
      database: false,
      analysisProvider: env.analysisProvider,
      timestamp: new Date().toISOString(),
    });
  }
});
