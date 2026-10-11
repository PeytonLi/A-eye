const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_CONTENT_LENGTH = 11 * 1024 * 1024;

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

function isFile(value: FormDataEntryValue | null): value is File {
  return typeof File !== "undefined" && value instanceof File;
}

export async function handleStt(req: Request): Promise<Response> {
  const contentLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_CONTENT_LENGTH) return jsonError(413, "too_large");

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonError(400, "invalid");
  }
  const audio = form.get("audio");
  if (!isFile(audio)) return jsonError(400, "invalid");
  if (audio.size === 0 || audio.size > MAX_AUDIO_BYTES) return jsonError(413, "too_large");
  const type = audio.type.toLowerCase();
  if (
    type &&
    !type.startsWith("audio/") &&
    type !== "video/webm" &&
    type !== "video/mp4"
  ) {
    return jsonError(415, "unsupported_type");
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return jsonError(503, "stt_unavailable");

  const upstreamForm = new FormData();
  upstreamForm.set("model_id", "scribe_v2");
  upstreamForm.set("file", new Blob([await audio.arrayBuffer()], { type: audio.type }), audio.name || "audio");

  try {
    const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: upstreamForm,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return jsonError(502, "stt_failed");
    const payload = (await response.json()) as { text?: unknown; language_code?: unknown };
    if (typeof payload.text !== "string") return jsonError(502, "stt_failed");
    return Response.json({
      text: payload.text,
      language_code: typeof payload.language_code === "string" ? payload.language_code : null,
    });
  } catch {
    return jsonError(502, "stt_failed");
  }
}
