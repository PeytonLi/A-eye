import { afterEach, describe, expect, it, vi } from "vitest";
import { handleStt } from "./stt.js";

function requestWithAudio(
  name: string,
  type: string,
  content: Uint8Array = new Uint8Array([1, 2, 3]),
): Request {
  const form = new FormData();
  form.set("audio", new File([content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer], name, { type }));
  return new Request("http://localhost/api/stt", { method: "POST", body: form });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("handleStt", () => {
  it("rejects a missing audio field and unsupported media types", async () => {
    const missing = await handleStt(
      new Request("http://localhost/api/stt", { method: "POST", body: new FormData() }),
    );
    const unsupported = await handleStt(requestWithAudio("sample.txt", "text/plain"));

    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "invalid" });
    expect(unsupported.status).toBe(415);
    expect(await unsupported.json()).toEqual({ error: "unsupported_type" });
  });

  it("rejects empty and oversized audio files", async () => {
    const empty = await handleStt(requestWithAudio("empty.mp3", "audio/mpeg", new Uint8Array()));
    const large = await handleStt(
      requestWithAudio("large.mp3", "audio/mpeg", new Uint8Array(10 * 1024 * 1024 + 1)),
    );

    expect(empty.status).toBe(413);
    expect(await empty.json()).toEqual({ error: "too_large" });
    expect(large.status).toBe(413);
    expect(await large.json()).toEqual({ error: "too_large" });
  });

  it("rejects an oversized request from its content-length before parsing", async () => {
    const response = await handleStt(
      new Request("http://localhost/api/stt", {
        method: "POST",
        headers: { "content-length": String(11 * 1024 * 1024 + 1) },
      }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "too_large" });
  });

  it("requires the API key", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "");

    const response = await handleStt(requestWithAudio("sample.webm", "video/webm"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "stt_unavailable" });
  });

  it("sends scribe_v2 and the uploaded file to ElevenLabs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ text: "A line is forming.", language_code: "eng" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("ELEVENLABS_API_KEY", "test-key");

    const response = await handleStt(requestWithAudio("recording.mp3", "audio/mpeg"));
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const sentForm = init.body as FormData;

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(init.headers).toMatchObject({ "xi-api-key": "test-key" });
    expect(sentForm.get("model_id")).toBe("scribe_v2");
    expect(sentForm.get("file")).toBeInstanceOf(File);
    expect((sentForm.get("file") as File).name).toBe("recording.mp3");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "A line is forming.", language_code: "eng" });
  });

  it("maps upstream failures to stt_failed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("upstream", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("ELEVENLABS_API_KEY", "test-key");

    const response = await handleStt(requestWithAudio("recording.wav", "audio/wav"));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "stt_failed" });
  });
});
