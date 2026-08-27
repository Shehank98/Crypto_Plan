import { z } from "zod";

export const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

const allocationSchema = z.object({
  coinId: z.number().int().positive(),
  pct: z.number().min(0).max(100),
});

export const planInputSchema = z.object({
  name: z.string().min(1).max(120),
  monthlyAmountLkr: z.number().positive(),
  // 1-28 keeps every month valid (no Feb 29/30/31 edge cases).
  purchaseDayOfMonth: z.number().int().min(1).max(28),
  // ISO date (YYYY-MM-DD) the plan's contributions begin.
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "startDate must be YYYY-MM-DD")
    .refine((s) => !Number.isNaN(Date.parse(s)), "startDate is not a valid date"),
  allocations: z
    .array(allocationSchema)
    .min(1, "At least one allocation is required")
    .superRefine((allocs, ctx) => {
      const total = allocs.reduce((s, a) => s + a.pct, 0);
      if (Math.abs(total - 100) > 0.01) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Allocation percentages must sum to 100 (got ${total})`,
        });
      }
      const ids = allocs.map((a) => a.coinId);
      if (new Set(ids).size !== ids.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate coinId in allocations" });
      }
    }),
});

export const purchaseInputSchema = z.object({
  coinId: z.number().int().positive(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
    .refine((s) => !Number.isNaN(Date.parse(s)), "date is not a valid date")
    .refine((s) => s <= new Date().toISOString().slice(0, 10), "date cannot be in the future"),
  amountLkr: z.number().positive(),
});

export type CredentialsInput = z.infer<typeof credentialsSchema>;
export type PlanBodyInput = z.infer<typeof planInputSchema>;
export type PurchaseBodyInput = z.infer<typeof purchaseInputSchema>;
