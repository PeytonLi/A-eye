import { z } from "zod";

export const PlaceContext = z.object({
  name: z.string().nullable(),
  category: z.string().nullable(),
  address: z.string().nullable(),
  hours: z.string().nullable(),
  website: z.string().nullable(),
  phone: z.string().nullable(),
  summary: z.string().nullable(),
  distance_m: z.number().nullable(),
  provider: z.enum(["osm", "context.dev", "osm+context.dev"]),
  sources: z.array(z.string()),
});
export type PlaceContext = z.infer<typeof PlaceContext>;

export const WebBaseline = z.object({
  answer: z.string(),
  source: z.string(),
  option_index: z.number().int().nullable(),
  option: z.string().nullable(),
  confidence: z.enum(["low", "medium", "high"]).nullable(),
  sources: z.array(z.string()),
  partial: z.boolean(),
  fetched_at: z.string().datetime(),
});
export type WebBaseline = z.infer<typeof WebBaseline>;
