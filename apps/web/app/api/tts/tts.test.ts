import { afterEach, describe, expect, it, vi } from "vitest";
import { handleTts } from "./tts.js";

function request(body: unknown): Request {
  return new Request("http://localhost/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("handleTts", () => {
  it("rejects invalid text and an oversized body", async () => {
    const invalid = await handleTts(request({ text: "   " }));
    const invalidVoice = await handleTts(request({ text: "Hello", voice_id: "bad" }));
    const tooLong = await handleTts(request({ text: "a".repeat(20_000) }));

    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: "invalid" });
    expect(invalidVoice.status).toBe(400);
    expect(tooLong.status).toBe(413);
    expect(await tooLong.json()).toMatchObject({ error: "too_large" });
  });

  it("requires the API key", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "");

    const response = await handleTts(request({ text: "Hello there." }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "tts_unavailable" });
  });

  it("returns audio and serves an identical request from cache", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("ELEVENLABS_API_KEY", "test-key");

    const first = await handleTts(request({ text: "Cache this sentence." }));
    const second = await handleTts(request({ text: "Cache this sentence." }));

    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("audio/mpeg");
    expect(first.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(first.headers.get("x-tts-cache")).toBe("miss");
    expect(second.headers.get("x-tts-cache")).toBe("hit");
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL?output_format=mp3_44100_128",
    );
  });

  it("evicts the oldest entry after the LRU capacity is exceeded", async () => {
    const fetchMock = vi.fn().mockImplementation(() => new Response(new Uint8Array([7]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("ELEVENLABS_API_KEY", "test-key");

    await handleTts(request({ text: "LRU oldest entry" }));
    for (let index = 0; index < 200; index += 1) {
      await handleTts(request({ text: `LRU entry ${index}` }));
    }
    const refetched = await handleTts(request({ text: "LRU oldest entry" }));

    expect(refetched.headers.get("x-tts-cache")).toBe("miss");
    expect(fetchMock).toHaveBeenCalledTimes(202);
  });

  it("maps upstream status errors without exposing their body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("secret upstream details", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("ELEVENLABS_API_KEY", "test-key");

    const response = await handleTts(request({ text: "Try this." }));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "tts_failed", message: "ElevenLabs 429" });
  });
});
