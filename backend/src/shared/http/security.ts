import type { RequestHandler } from "express";
import { env } from "../../config/env.js";
import { HttpError } from "./http-error.js";

const requests = new Map<string, { windowStartedAt: number; count: number }>();

export const cors: RequestHandler = (request, response, next) => {
  const origin = request.header("origin");
  if (origin && env.corsOrigins.includes(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Internal-Token");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  }
  if (request.method === "OPTIONS") {
    if (origin && !env.corsOrigins.includes(origin)) {
      next(new HttpError(403, "ORIGIN_NOT_ALLOWED", "The request origin is not allowed."));
      return;
    }
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

export const rateLimit: RequestHandler = (request, response, next) => {
  const now = Date.now();
  const key = request.ip ?? request.socket.remoteAddress ?? "unknown";
  const current = requests.get(key);
  const entry = !current || now - current.windowStartedAt >= 60_000
    ? { windowStartedAt: now, count: 1 }
    : { ...current, count: current.count + 1 };
  requests.set(key, entry);
  response.setHeader("RateLimit-Limit", String(env.requestLimitPerMinute));
  response.setHeader("RateLimit-Remaining", String(Math.max(0, env.requestLimitPerMinute - entry.count)));
  if (entry.count > env.requestLimitPerMinute) {
    response.setHeader("Retry-After", String(Math.ceil((60_000 - (now - entry.windowStartedAt)) / 1_000)));
    next(new HttpError(429, "RATE_LIMIT_EXCEEDED", "Too many requests; try again shortly."));
    return;
  }
  next();
};
