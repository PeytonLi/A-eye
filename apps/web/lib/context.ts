import type { PlaceContext, WebBaseline } from "@a-eye/shared";

const CONTEXT_API = "https://api.context.dev/v1";
const NOMINATIM_API = "https://nominatim.openstreetmap.org/reverse";
const NOMINATIM_USER_AGENT = "A-eye/0.1 (+https://a-eye-1zsv.onrender.com)";
const PLACE_CACHE_LIMIT = 500;
const placeCache = new Map<string, PlaceContext>();

type NominatimResult = {
  name?: string;
  type?: string;
  display_name?: string;
  lat?: string;
  lon?: string;
  osm_type?: string;
  osm_id?: number;
  extratags?: Record<string, string | undefined>;
};

type ContextSearchResult = {
  url?: string;
  title?: string;
  description?: string;
};

function roundedKey(lat: number, lng: number): string {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

function cachePlace(key: string, value: PlaceContext): void {
  placeCache.delete(key);
  placeCache.set(key, value);
  if (placeCache.size > PLACE_CACHE_LIMIT) {
    const oldest = placeCache.keys().next().value;
    if (oldest !== undefined) placeCache.delete(oldest);
  }
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const radians = (value: number) => (value * Math.PI) / 180;
  const earthRadius = 6_371_000;
  const deltaLat = radians(lat2 - lat1);
  const deltaLng = radians(lng2 - lng1);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(deltaLng / 2) ** 2;
  return Math.round(earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function validHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

async function nominatimReverse(
  lat: number,
  lng: number,
  signal: AbortSignal,
  includeLayer: boolean,
): Promise<NominatimResult | null> {
  const url = new URL(NOMINATIM_API);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lng));
  url.searchParams.set("zoom", "18");
  url.searchParams.set("extratags", "1");
  if (includeLayer) url.searchParams.set("layer", "poi");
  const response = await fetch(url, {
    headers: { "User-Agent": NOMINATIM_USER_AGENT },
    signal,
  });
  if (!response.ok) return null;
  return (await response.json()) as NominatimResult;
}

async function contextSearch(query: string, signal: AbortSignal): Promise<ContextSearchResult[]> {
  const response = await fetch(`${CONTEXT_API}/web/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.CONTEXT_DEV_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, numResults: 10 }),
    signal,
  });
  if (!response.ok) return [];
  const payload = (await response.json()) as { results?: ContextSearchResult[] };
  return Array.isArray(payload.results) ? payload.results : [];
}

function placeFromOsm(lat: number, lng: number, result: NominatimResult): PlaceContext {
  const source =
    result.osm_type && result.osm_id !== undefined
      ? `https://www.openstreetmap.org/${result.osm_type}/${result.osm_id}`
      : "https://www.openstreetmap.org/";
  const extra = result.extratags ?? {};
  const resultLat = Number(result.lat);
  const resultLng = Number(result.lon);
  const distance = Number.isFinite(resultLat) && Number.isFinite(resultLng)
    ? haversineMeters(lat, lng, resultLat, resultLng)
    : null;
  return {
    name: result.name?.trim() || null,
    category: result.type ?? null,
    address: result.display_name ?? null,
    hours: extra.opening_hours ?? null,
    website: extra.website ?? extra["contact:website"] ?? null,
    phone: extra.phone ?? extra["contact:phone"] ?? null,
    summary: null,
    distance_m: distance,
    provider: "osm",
    sources: [source],
  };
}

export async function placeContext(
  lat: number,
  lng: number,
  opts: { timeoutMs?: number } = {},
): Promise<PlaceContext | null> {
  const key = roundedKey(lat, lng);
  const cached = placeCache.get(key);
  if (cached) {
    placeCache.delete(key);
    placeCache.set(key, cached);
    return cached;
  }

  const timeoutMs = opts.timeoutMs ?? 4000;
  const signal = AbortSignal.timeout(timeoutMs);
  let place: PlaceContext | null = null;
  try {
    let osm = await nominatimReverse(lat, lng, signal, true);
    if (osm && !osm.name?.trim() && !signal.aborted) {
      try {
        const fallback = await nominatimReverse(lat, lng, signal, false);
        if (fallback?.name?.trim()) osm = { ...osm, name: fallback.name };
      } catch {
        // Keep the POI-layer result when the fallback lookup is unavailable.
      }
    }
    if (osm) place = placeFromOsm(lat, lng, osm);
  } catch {
    place = null;
  }

  if (!process.env.CONTEXT_DEV_API_KEY || signal.aborted) {
    if (place) cachePlace(key, place);
    return place;
  }

  try {
    const query = place
      ? [place.name, place.address].filter(Boolean).join(" ")
      : `places near ${lat}, ${lng}`;
    const results = await contextSearch(query, signal);
    if (results.length) {
      const first = results[0]!;
      const resultUrls = results.map((result) => validHttpUrl(result.url)).filter((url): url is string => Boolean(url));
      if (!place) {
        place = {
          name: first.title?.trim() || null,
          category: null,
          address: null,
          hours: null,
          website: null,
          phone: null,
          summary: first.description ?? first.title ?? null,
          distance_m: null,
          provider: "context.dev",
          sources: [],
        };
      } else {
        place = {
          ...place,
          website: place.website ?? resultUrls[0] ?? null,
          summary: first.description ?? first.title ?? null,
          provider: "osm+context.dev",
        };
      }
      place = { ...place, sources: [...new Set([...place.sources, ...resultUrls])] };
    }
  } catch {
    // Return the OSM result when Context.dev is unavailable.
  }

  if (place) cachePlace(key, place);
  return place;
}

function inferOptionIndex(option: unknown, answer: string, options: string[]): number | null {
  if (typeof option === "string" && option.trim()) {
    const normalized = option.trim().toLocaleLowerCase();
    const exact = options.findIndex((candidate) => candidate.trim().toLocaleLowerCase() === normalized);
    if (exact >= 0) return exact;
  }
  const answerLower = answer.toLocaleLowerCase();
  const contained = options
    .map((candidate, index) => ({ candidate: candidate.trim(), index }))
    .filter(({ candidate }) => candidate && answerLower.includes(candidate.toLocaleLowerCase()));
  return contained.length === 1 ? contained[0]!.index : null;
}

export async function webBaseline(
  question: string,
  options: string[],
  lat: number,
  lng: number,
  opts: { placeName?: string; timeoutMs?: number } = {},
): Promise<WebBaseline | null> {
  const apiKey = process.env.CONTEXT_DEV_API_KEY;
  if (!apiKey) return null;

  const timeoutMs = opts.timeoutMs ?? 4000;
  const signal = AbortSignal.timeout(timeoutMs);
  const optionList = options.map((option, index) => `${index + 1}. ${option}`).join("; ");
  const task =
    `Someone at latitude ${lat}, longitude ${lng}${opts.placeName ? ` (${opts.placeName})` : ""} is asked: "${question}". Options: ${optionList}. Using current web information (business hours, listings, forecasts, news, reviews), what does the web suggest the answer is right now? Set "option" to the exact text of the single most likely option, "answer" to one short sentence with the evidence, "confidence" to low, medium or high, and "source_url" to the best supporting URL.`.slice(0, 2000);

  try {
    const response = await fetch(`${CONTEXT_API}/web/answers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        mode: "fast",
        task,
        json_format: { answer: "", option: "", confidence: "low|medium|high", source_url: "" },
        timeoutOpts: { milliseconds: Math.max(1000, timeoutMs - 500), behavior: "return-partial" },
      }),
      signal,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      partial?: boolean;
      json_content?: {
        answer?: unknown;
        option?: unknown;
        confidence?: unknown;
        source_url?: unknown;
      };
      sources?: unknown;
    };
    const content = payload.json_content;
    const answer = typeof content?.answer === "string" ? content.answer.trim() : "";
    if (!answer) return null;
    const sourceUrls = [content?.source_url, ...(Array.isArray(payload.sources) ? payload.sources : [])]
      .map(validHttpUrl)
      .filter((url): url is string => Boolean(url));
    const sources = [...new Set(sourceUrls)];
    const optionIndex = inferOptionIndex(content?.option, answer, options);
    const confidence =
      content?.confidence === "low" || content?.confidence === "medium" || content?.confidence === "high"
        ? content.confidence
        : null;
    let source = "Context.dev web search";
    if (sources[0]) {
      try {
        source = new URL(sources[0]).hostname.replace(/^www\./, "");
      } catch {
        source = "Context.dev web search";
      }
    }
    return {
      answer,
      source,
      option_index: optionIndex,
      option: optionIndex === null ? null : options[optionIndex]!,
      confidence,
      sources,
      partial: Boolean(payload.partial),
      fetched_at: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
