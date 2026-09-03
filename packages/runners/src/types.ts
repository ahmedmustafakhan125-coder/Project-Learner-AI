import { z } from 'zod';

export const SubmittedFileSchema = z.object({
  path: z.string(),
  contents: z.string(),
});
export type SubmittedFile = z.infer<typeof SubmittedFileSchema>;

export const LayerResultSchema = z.object({
  layer: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  passed: z.boolean(),
  message: z.string(),
  details: z.array(z.string()).optional(),
});
export type LayerResult = z.infer<typeof LayerResultSchema>;

export const VerificationResultSchema = z.object({
  passed: z.boolean(),
  layers: z.array(LayerResultSchema),
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

export const CheckpointInputSchema = z.object({
  requiredFiles: z.array(z.string()),
  requiredSymbols: z.array(z.string()),
  tests: z.array(
    z.object({
      name: z.string(),
      code: z.string(),
      failureMessage: z.string(),
    }),
  ),
  runtime: z.union([z.literal('web'), z.literal('python'), z.literal('none')]),
});
export type CheckpointInput = z.infer<typeof CheckpointInputSchema>;
