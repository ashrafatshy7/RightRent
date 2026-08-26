import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = fileURLToPath(new URL("../../", import.meta.url));

function integer(name: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function csv(value: string | undefined) {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function decimal(name: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a number between ${minimum} and ${maximum}.`);
  }
  return value;
}

function choice<const T extends readonly string[]>(name: string, value: string, choices: T): T[number] {
  if (!choices.includes(value)) throw new Error(`${name} must be one of: ${choices.join(", ")}.`);
  return value as T[number];
}

const nodeEnv = process.env.NODE_ENV ?? "development";
const jwtSecret = process.env.JWT_SECRET ?? "development-only-change-me-rightrent";
const dataDriver = choice(
  "DATA_DRIVER",
  process.env.DATA_DRIVER ?? (process.env.MONGODB_URI ? "mongodb" : "memory"),
  ["memory", "mongodb"] as const,
);
const analysisProvider = choice(
  "ANALYSIS_PROVIDER",
  process.env.ANALYSIS_PROVIDER ?? "deterministic",
  ["deterministic", "anthropic"] as const,
);
const piiNerMode = choice(
  "PII_NER_MODE",
  process.env.PII_NER_MODE ?? "regex",
  ["regex", "dictabert"] as const,
);
const manageMongoVectorIndex = choice(
  "MONGODB_MANAGE_VECTOR_INDEX",
  process.env.MONGODB_MANAGE_VECTOR_INDEX ?? "true",
  ["true", "false"] as const,
) === "true";

if (nodeEnv === "production" && jwtSecret.length < 32) {
  throw new Error("JWT_SECRET must contain at least 32 characters in production.");
}

if (nodeEnv === "production" && !process.env.MONGODB_URI) {
  throw new Error("MONGODB_URI is required in production.");
}

if (nodeEnv === "production" && dataDriver !== "mongodb") {
  throw new Error("DATA_DRIVER must be mongodb in production.");
}

if (nodeEnv === "production" && analysisProvider !== "anthropic") {
  throw new Error("ANALYSIS_PROVIDER must be anthropic in production so legal claims use the verified RAG corpus.");
}

if (analysisProvider === "anthropic" && (!process.env.OPENAI_API_KEY || !process.env.ANTHROPIC_API_KEY)) {
  throw new Error("OPENAI_API_KEY and ANTHROPIC_API_KEY are required when ANALYSIS_PROVIDER=anthropic.");
}

if (analysisProvider === "anthropic" && piiNerMode !== "dictabert") {
  throw new Error("PII_NER_MODE must be dictabert when ANALYSIS_PROVIDER=anthropic.");
}

export const env = Object.freeze({
  nodeEnv,
  port: integer("PORT", 3000, 1, 65_535),
  uploadDirectory: path.resolve(backendRoot, process.env.UPLOAD_DIR ?? "storage/uploads"),
  markedPdfDirectory: path.resolve(
    backendRoot,
    process.env.MARKED_PDF_DIR ?? "storage/marked-pdfs",
  ),
  dataDriver,
  mongodbUri: process.env.MONGODB_URI,
  mongodbDatabase: process.env.MONGODB_DATABASE ?? "rightrent",
  mongodbVectorIndex: process.env.MONGODB_VECTOR_INDEX ?? "law_vector_index",
  manageMongoVectorIndex,
  jwtSecret,
  jwtExpiresInSeconds: integer("JWT_EXPIRES_IN_SECONDS", 60 * 60 * 24, 300, 2_592_000),
  bcryptRounds: integer("BCRYPT_ROUNDS", 12, 10, 15),
  corsOrigins: csv(process.env.CORS_ORIGINS),
  internalApiToken: process.env.INTERNAL_API_TOKEN,
  openAiApiKey: process.env.OPENAI_API_KEY,
  openAiEmbeddingModel: process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small",
  openAiEmbeddingDimensions: integer("OPENAI_EMBEDDING_DIMENSIONS", 1_536, 256, 3_072),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5",
  analysisProvider,
  piiNerMode,
  piiNerEndpoint: process.env.PII_NER_ENDPOINT ?? "http://127.0.0.1:8001",
  piiNerToken: process.env.PII_NER_TOKEN,
  piiNerModel: process.env.PII_NER_MODEL ?? "dicta-il/dictabert-ner",
  piiNerMinimumConfidence: decimal("PII_NER_MINIMUM_CONFIDENCE", 0.8, 0.5, 1),
  piiNerTimeoutMs: integer("PII_NER_TIMEOUT_MS", 30_000, 1_000, 120_000),
  ocrLanguage: process.env.OCR_LANGUAGE ?? "heb+eng",
  requestLimitPerMinute: integer("REQUEST_LIMIT_PER_MINUTE", 120, 10, 10_000),
  lawSyncRetentionDays: integer("LAW_SYNC_RETENTION_DAYS", 90, 7, 3_650),
  lawSyncLeaseMinutes: integer("LAW_SYNC_LEASE_MINUTES", 55, 5, 59),
  analysisTargetMs: integer("ANALYSIS_TARGET_MS", 90_000, 10_000, 600_000),
});
