import { z } from 'zod';

const uuid = z.uuid();
const options = {
  model: z.string().trim().min(1).max(200).optional(),
  instructions: z.string().max(262_144).optional(),
  reasoning_effort: z
    .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])
    .optional(),
  verbosity: z.enum(['low', 'medium', 'high']).optional(),
  max_output_tokens: z.number().int().min(1).max(32_768).optional(),
  timeout_ms: z.number().int().min(1000).max(600_000).optional(),
};
export const chatSchema = z.strictObject({
  message: z
    .string()
    .min(1)
    .max(262_144)
    .refine(
      (s) => s.trim().length > 0,
      'Message must contain non-whitespace text.',
    ),
  session_id: uuid.optional(),
  request_id: uuid.optional(),
  ...options,
});
export const sessionsSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('list'),
    limit: z.number().int().min(1).max(100).default(20),
    after: uuid.optional(),
  }),
  z.strictObject({ operation: z.literal('get'), session_id: uuid }),
  z.strictObject({
    operation: z.literal('configure'),
    session_id: uuid,
    ...options,
  }),
  z.strictObject({ operation: z.literal('delete'), session_id: uuid }),
]);
export const requestSchema = z.strictObject({
  request_id: uuid,
  action: z.enum(['inspect', 'recover', 'abandon']).default('inspect'),
});
export type ChatInput = z.infer<typeof chatSchema>;
export type SessionInput = z.infer<typeof sessionsSchema>;
export type RequestInput = z.infer<typeof requestSchema>;

// A common object envelope supports both successful tool results and safe errors.
export const outputSchema = z
  .object({ status: z.string() })
  .catchall(z.unknown());
