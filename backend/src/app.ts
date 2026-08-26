import express from "express";
import helmet from "helmet";
import { analysesRouter } from "./modules/analyses/analyses.routes.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { contractsRouter } from "./modules/contracts/contracts.routes.js";
import { healthRouter } from "./modules/health/health.routes.js";
import { historyRouter } from "./modules/history/history.routes.js";
import { lawRouter } from "./modules/law/law.routes.js";
import { negotiationsRouter } from "./modules/negotiations/negotiations.routes.js";
import { usersRouter } from "./modules/users/users.routes.js";
import { errorHandler } from "./shared/http/error-handler.js";
import { notFoundHandler } from "./shared/http/not-found.js";
import { cors, rateLimit, requireHttps } from "./shared/http/security.js";

export const app = express();

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: "same-site" } }));
app.use(requireHttps);
app.use(cors);
app.use(rateLimit);
app.use(express.json({ limit: "1mb" }));

app.use("/api/health", healthRouter);
app.use("/api/auth", authRouter);
app.use("/api/users", usersRouter);
app.use("/api/contracts", contractsRouter);
app.use("/api/analyses", analysesRouter);
app.use("/api/negotiation", negotiationsRouter);
app.use("/api/history", historyRouter);
app.use("/internal/law", lawRouter);

app.use(notFoundHandler);
app.use(errorHandler);
