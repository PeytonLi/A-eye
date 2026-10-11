import { z } from "zod";

const MODEL_ID = "eleven_flash_v2_5";
const DEFAULT_VOICE_ID = "EXAVITQu4vr4xnSDxMaL";
const MAX_BODY_BYTES = 16 * 1024;
const MAX_CACHE_ENTRIES = 200;
const MAX_CACHE_BYTES = 25 * 1024 * 1024;

const TtsInput = z.object({
  text: z.string().trim().min(1).max(1000),
  voice_id: z.string().regex(/^[A-Za-z0-9]{10,40}$/).optional(),
});

type CachedAudio = {
  audio: Uint8Array;
  size: number;
};

const audioCache = new Map<string, CachedAudio>();
let cacheBytes = 0;

function jsonError(status: number, error: string, message?: string): Response {
  return Response.json(message ? { error, message } : { error }, { status });
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function saveAudio(key: string, audio: Uint8Array): void {
  const previous = audioCache.get(key);
  if (previous) {
    cacheBytes -= previous.size;
    audioCache.delete(key);
  }
  if (audio.byteLength > MAX_CACHE_BYTES) return;
  audioCache.set(key, { audio: new Uint8Array(audio), size: audio.byteLength });
  cacheBytes += audio.byteLength;
  while (audioCache.size > MAX_CACHE_ENTRIES || cacheBytes > MAX_CACHE_BYTES) {
    const oldestKey = audioCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = audioCache.get(oldestKey)!;
    cacheBytes -= oldest.size;
    audioCache.delete(oldestKey);
  }
}

function cachedAudio(key: string): Uint8Array | null {
  const cached = audioCache.get(key);
  if (!cached) return null;
  audioCache.delete(key);
  audioCache.set(key, cached);
  return new Uint8Array(cached.audio);
}

export async function handleTts(req: Request): Promise<Response> {
  const length = Number(req.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return jsonError(413, "too_large");

  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return jsonError(400, "invalid", "Request body must be valid JSON.");
  }
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) return jsonError(413, "too_large");

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonError(400, "invalid", "Request body must be valid JSON.");
  }
  const parsed = TtsInput.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, "invalid", parsed.error.issues[0]?.message ?? "Invalid request.");
  }
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return jsonError(503, "tts_unavailable");

  const voiceId = parsed.data.voice_id ?? process.env.ELEVENLABS_VOICE_ID ?? DEFAULT_VOICE_ID;
  const cacheKey = `${voiceId}:${MODEL_ID}:${parsed.data.text}`;
  const cached = cachedAudio(cacheKey);
  if (cached) {
    return new Response(toArrayBuffer(cached), {
      headers: {
        "content-type": "audio/mpeg",
        "cache-control": "public, max-age=86400",
        "x-tts-cache": "hit",
      },
    });
  }

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "content-type": "application/json",
          accept: "audio/mpeg",
        },
        body: JSON.stringify({ text: parsed.data.text, model_id: MODEL_ID }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) return jsonError(502, "tts_failed", `ElevenLabs ${response.status}`);
    const audio = new Uint8Array(await response.arrayBuffer());
    saveAudio(cacheKey, audio);
    return new Response(toArrayBuffer(audio), {
      headers: {
        "content-type": "audio/mpeg",
        "cache-control": "public, max-age=86400",
        "x-tts-cache": "miss",
      },
    });
  } catch {
    return jsonError(502, "tts_failed", "ElevenLabs request failed");
  }
}
