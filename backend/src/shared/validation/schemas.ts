import { z } from "zod";
import { ACCEPTED_SECURITY_KINDS, ADDITIONAL_NOTES_MAX_LENGTH, normalizePreferences } from "../../domain/models.js";

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
  acceptedSecurityKinds: z.array(z.enum(ACCEPTED_SECURITY_KINDS)).max(ACCEPTED_SECURITY_KINDS.length),
  maxMonthlyTotalCostIls: z.number().nonnegative().max(1_000_000).nullable(),
  acceptsIndexation: z.boolean(),
  earlyExitRequired: z.boolean(),
  roommatesRequired: z.boolean(),
  renewalOptionRequired: z.boolean(),
  minEntryNoticeHours: z.union([z.literal(24), z.literal(48)]).nullable(),
  acceptsBrokerFee: z.boolean(),
  additionalNotes: z.string().trim().max(ADDITIONAL_NOTES_MAX_LENGTH),
}).strict().transform((preferences) => normalizePreferences(preferences));

export const analyzeRequestSchema = z.object({
  confirmPreferences: z.literal(true),
  preferences: preferencesSchema.optional(),
}).strict();

const amount = z.number().nonnegative().max(10_000_000);
const chargeKind = z.enum(["ARNONA", "WATER", "ELECTRICITY", "GAS", "VAAD_BAYIT", "BUILDING_INSURANCE", "SPECIAL_BUILDING_EXPENSES", "CONTENTS_INSURANCE", "OTHER"]);
const oneTimeKind = z.enum(["BROKER_FEE", "LEGAL_FEE", "CLEANING", "OTHER"]);

export const financialOverridesSchema = z.object({
  monthlyRent: amount.optional(),
  leaseTermMonths: z.number().int().min(1).max(120).optional(),
  leaseStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
  indexationLinked: z.boolean().optional(),
  indexationFrequency: z.enum(["MONTHLY", "ANNUAL", "AT_RENEWAL"]).optional(),
  annualIncreasePercent: z.number().min(0).max(100).optional(),
  optionMonths: z.number().int().min(0).max(120).optional(),
  optionRent: amount.optional(),
  optionIncreasePercent: z.number().min(0).max(100).optional(),
  securityAmount: amount.optional(),
  lateVacatingPerDay: amount.optional(),
  latePaymentPerDay: amount.optional(),
  earlyExitKind: z.enum(["UNTIL_REPLACEMENT", "UNTIL_END", "FIXED_MONTHS", "FIXED_AMOUNT", "ALLOWED_WITH_NOTICE", "NOT_ALLOWED"]).optional(),
  earlyExitMonths: z.number().int().min(0).max(120).optional(),
  earlyExitNoticeDays: z.number().int().min(0).max(365).optional(),
  chargeAmounts: z.partialRecord(chargeKind, amount).optional(),
  oneTimeAmounts: z.partialRecord(oneTimeKind, amount).optional(),
}).strict();

export const costScenarioSchema = z.object({
  annualInflationPercent: z.number().min(-10).max(30).optional(),
  includeOption: z.boolean().optional(),
  exitAfterMonth: z.number().int().min(1).max(119).nullable().optional(),
  replacementAfterMonths: z.number().int().min(0).max(24).optional(),
  lateVacatingDays: z.number().int().min(0).max(365).optional(),
  latePaymentDays: z.number().int().min(0).max(365).optional(),
}).strict();

export const costSimulationRequestSchema = z.object({ scenario: costScenarioSchema.optional() }).strict();

export const negotiationRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("START"), restart: z.boolean().optional() }).strict(),
  z.object({
    action: z.literal("SAVE_DRAFT"),
    draft: z.string().trim().min(1).max(3_000),
  }).strict(),
  z.object({ action: z.literal("FINALIZE_DRAFT") }).strict(),
  z.object({ action: z.literal("COMPLETE") }).strict(),
]);

export const negotiationMessageSchema = z.object({
  text: z.string().trim().min(1).max(1_000),
}).strict();
