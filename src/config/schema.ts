import { z } from "zod";

// .strict() on all objects to reject typos in repo configs — fail-closed is safer than silently ignoring unknown keys (CFG-05).
const NotificationsSchema = z
  .object({
    // channel required when slack block is present — natural enforcement through nested required field (CFG-06).
    slack: z.object({ channel: z.string().min(1) }).strict().optional(),
    // chat_id required when telegram block is present — same pattern as slack (CFG-06).
    telegram: z.object({ chat_id: z.string().min(1) }).strict().optional(),
  })
  .strict()
  .optional();

export const ConfigSchema = z
  .object({
    main_branch: z.string().min(1),
    release_branch: z.string().min(1).optional(),
    dev_branch: z.string().min(1),
    notifications: NotificationsSchema,
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
