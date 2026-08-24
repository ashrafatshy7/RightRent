import { z } from "zod";

export const credentialsSchema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(10).max(128),
}).strict();

export const preferencesSchema = z.object({
  maxMonthlyRentIls: z.number().nonnegative().max(1_000_000),
  repairUrgencyHours: z.union([z.literal(24), z.literal(48), z.literal(72), z.literal(168)]),
  leaseLengthMonths: z.number().int().min(1).max(120),
  maxAnnualRentIncreasePercent: z.number().nonnegative().max(100),
  petsRequired: z.boolean(),
  furnishedRequired: z.boolean(),
  acceptsGuarantorRequirement: z.boolean(),
}).strict();

export const analyzeRequestSchema = z.object({
  confirmPreferences: z.literal(true),
  preferences: preferencesSchema.optional(),
}).strict();

export const negotiationRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("START") }).strict(),
  z.object({
    action: z.literal("SET_PRIORITIES"),
    clauseIds: z.array(z.string().min(1)).min(1),
  }).strict(),
  z.object({
    action: z.literal("CHOOSE_STRATEGY"),
    clauseId: z.string().min(1),
    strategy: z.enum(["CITE_LAW", "PROPOSE_ALTERNATIVE", "CONCEDE"]),
  }).strict(),
  z.object({
    action: z.literal("SAVE_DRAFT"),
    draft: z.string().trim().min(1).max(5_000),
  }).strict(),
  z.object({ action: z.literal("COMPLETE") }).strict(),
]);
