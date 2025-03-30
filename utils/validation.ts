import { z } from "zod";

// Define Zod schema for event validation matching the Event type
export const EventSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().min(1, "Description is required"),
  start_at: z.string().regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:.\d{3}Z|[-+]\d{2}:\d{2})$/, // Allow ISO strings with Z or offset
    "start_at must be in ISO format YYYY-MM-DDThh:mm:ssZ or with timezone offset"
  ),
  end_at: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:.\d{3}Z|[-+]\d{2}:\d{2})$/,
      "end_at must be in ISO format YYYY-MM-DDThh:mm:ssZ or with timezone offset"
    )
    .optional(),
  url: z.string().url("URL must be a valid URL"),
  location: z.string().min(1, "Location is required"),
  external_id: z.string().min(1, "External ID is required"),
});

// Define Zod schema for validating an array of events
export const EventsArraySchema = z.array(EventSchema);

// Type for a single validated event, inferred from the schema
export type ValidatedEvent = z.infer<typeof EventSchema>;
