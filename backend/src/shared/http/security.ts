import { createHash } from "node:crypto";
import type { RequestHandler } from "express";
import { env } from "../../config/env.js";
import { getStore } from "../data/store.js";
import { HttpError } from "./http-error.js";

export const cors: RequestHandler = (request, response, next) => {
  const origin = request.header("origin");
  if (origin && !env.corsOrigins.includes(origin)) {
    next(new HttpError(403, "ORIGIN_NOT_ALLOWED", "The request origin is not allowed."));
    return;
  }
  if (origin && env.corsOrigins.includes(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Internal-Token");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  }
  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }
  next();
};

export const requireHttps: RequestHandler = (request, _response, next) => {
  if (env.nodeEnv === "production" && !request.secure) {
    next(new HttpError(400, "HTTPS_REQUIRED", "HTTPS is required."));
    return;
  }
  next();
};

export const rateLimit: RequestHandler = async (request, response, next) => {
  if (request.originalUrl.startsWith("/api/health")) {
    next();
    return;
  }
  const now = Date.now();
  const windowStartedAt = Math.floor(now / 60_000) * 60_000;
  const address = request.ip ?? request.socket.remoteAddress ?? "unknown";
  const key = `${windowStartedAt}:${createHash("sha256").update(address).digest("hex")}`;
  const count = await (await getStore()).consumeRateLimit(key, new Date(windowStartedAt + 120_000));
  response.setHeader("RateLimit-Limit", String(env.requestLimitPerMinute));
  response.setHeader("RateLimit-Remaining", String(Math.max(0, env.requestLimitPerMinute - count)));
  if (count > env.requestLimitPerMinute) {
    response.setHeader("Retry-After", String(Math.ceil((windowStartedAt + 60_000 - now) / 1_000)));
    next(new HttpError(429, "RATE_LIMIT_EXCEEDED", "Too many requests; try again shortly."));
    return;
  }
  next();
};
