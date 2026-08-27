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

export type CredentialsInput = z.infer<typeof credentialsSchema>;
export type PlanBodyInput = z.infer<typeof planInputSchema>;
