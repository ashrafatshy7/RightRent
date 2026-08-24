import type { ZodType } from "zod";
import { HttpError } from "../http/http-error.js";

export function parse<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  throw new HttpError(
    400,
    "VALIDATION_ERROR",
    "The request body is invalid.",
    result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  );
}
