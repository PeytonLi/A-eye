import { afterEach, describe, expect, it, vi } from "vitest";
import { placeContext, webBaseline } from "./context.js";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("placeContext", () => {
  it("maps OSM fields and retries an unnamed POI without the layer", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          name: "",
          type: "toilets",
          display_name: "Berkeley, California",
          lat: "37.8716",
          lon: "-122.2536",
          osm_type: "node",
          osm_id: 42,
          extratags: {
            opening_hours: "24/7",
            "contact:website": "https://example.org",
            "contact:phone": "555-0100",
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ name: "Campus Restroom" }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("CONTEXT_DEV_API_KEY", "");

    const place = await placeContext(37.8716, -122.2536);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    const secondUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(firstUrl.searchParams.get("layer")).toBe("poi");
    expect(secondUrl.searchParams.has("layer")).toBe(false);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { "User-Agent": "A-eye/0.1 (+https://a-eye-1zsv.onrender.com)" },
    });
    expect(place).toMatchObject({
      name: "Campus Restroom",
      category: "toilets",
      address: "Berkeley, California",
      hours: "24/7",
      website: "https://example.org",
      phone: "555-0100",
      provider: "osm",
      sources: ["https://www.openstreetmap.org/node/42"],
    });
    expect(place?.distance_m).toBe(0);
  });

  it("returns OSM-only context and never calls Context.dev without a key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        name: "Ladle and Leaf",
        type: "cafe",
        display_name: "Ladle and Leaf, Berkeley",
        lat: "37.87235",
        lon: "-122.25432",
        osm_type: "way",
        osm_id: 787,
        extratags: { website: "https://ladleandleaf.example" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("CONTEXT_DEV_API_KEY", "");

    const place = await placeContext(37.87235, -122.25432);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get("layer")).toBe("poi");
    expect(place).toMatchObject({ name: "Ladle and Leaf", category: "cafe", provider: "osm" });
  });

  it("enriches OSM context with Context.dev search", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ name: "Cafe", type: "cafe", display_name: "1 Main St" }))
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            { url: "https://www.example.com/cafe", title: "Cafe listing", description: "Open until 5." },
            { url: "https://reviews.example/cafe", title: "Reviews" },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("CONTEXT_DEV_API_KEY", "test-key");

    const place = await placeContext(5, 6);
    const searchInit = fetchMock.mock.calls[1]?.[1] as RequestInit;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.context.dev/v1/web/search");
    expect(searchInit.headers).toMatchObject({ Authorization: "Bearer test-key" });
    expect(JSON.parse(String(searchInit.body))).toEqual({ query: "Cafe 1 Main St", numResults: 10 });
    expect(place).toMatchObject({
      website: "https://www.example.com/cafe",
      summary: "Open until 5.",
      provider: "osm+context.dev",
      sources: [
        "https://www.openstreetmap.org/",
        "https://www.example.com/cafe",
        "https://reviews.example/cafe",
      ],
    });
  });

  it("builds a Context.dev-only place when the reverse lookup fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ results: [{ url: "https://example.com/place", title: "A Place" }] }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("CONTEXT_DEV_API_KEY", "test-key");

    const place = await placeContext(7, 8);

    expect(place).toMatchObject({
      name: "A Place",
      address: null,
      provider: "context.dev",
      website: null,
      summary: "A Place",
      sources: ["https://example.com/place"],
    });
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toEqual({
      query: "places near 7, 8",
      numResults: 10,
    });
  });

  it("returns null without throwing when the OSM request times out", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("CONTEXT_DEV_API_KEY", "");

    await expect(placeContext(25, 26, { timeoutMs: 10 })).resolves.toBeNull();
  });

  it("returns cached context without another fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ name: "Cache Place", type: "park" }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("CONTEXT_DEV_API_KEY", "");

    const first = await placeContext(44.123456, 5.123456);
    const second = await placeContext(44.123451, 5.123451);

    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("webBaseline", () => {
  it("does not fetch without a key", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("CONTEXT_DEV_API_KEY", "");

    await expect(webBaseline("Is it open?", ["Yes", "No"], 1, 2)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("matches exact options case-insensitively and records partial results", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        partial: true,
        json_content: {
          answer: "The listings say the cafe is open.",
          option: "YES",
          confidence: "high",
          source_url: "https://www.example.com/hours",
        },
        sources: ["https://example.com/other", "javascript:alert(1)"],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("CONTEXT_DEV_API_KEY", "test-key");

    const baseline = await webBaseline("Is it open?", ["Yes", "No"], 1, 2);

    expect(baseline).toMatchObject({
      answer: "The listings say the cafe is open.",
      source: "example.com",
      option_index: 0,
      option: "Yes",
      confidence: "high",
      sources: ["https://www.example.com/hours", "https://example.com/other"],
      partial: true,
    });
    expect(baseline?.fetched_at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("matches a contained single answer, but leaves ambiguous answers unmatched", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ json_content: { answer: "The answer appears to be No.", option: "", confidence: "medium" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ json_content: { answer: "Yes or no is unclear.", option: "", confidence: "unknown" } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("CONTEXT_DEV_API_KEY", "test-key");

    const contained = await webBaseline("Question?", ["Yes", "No"], 1, 2);
    const ambiguous = await webBaseline("Question?", ["Yes", "No"], 3, 4);

    expect(contained).toMatchObject({ option_index: 1, option: "No", confidence: "medium" });
    expect(ambiguous).toMatchObject({ option_index: null, option: null, confidence: null });
  });

  it("sends the required request shape and treats status/errors as null", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ json_content: { answer: "maybe", option: "maybe" } }, 503))
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("CONTEXT_DEV_API_KEY", "test-key");

    await expect(webBaseline("Will it rain?", ["Yes", "No"], 1, 2, { placeName: "The Cafe", timeoutMs: 25000 })).resolves.toBeNull();
    const request = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(request).toMatchObject({
      mode: "fast",
      json_format: { answer: "", option: "", confidence: "low|medium|high", source_url: "" },
      timeoutOpts: { milliseconds: 24500, behavior: "return-partial" },
    });
    expect(request.task).toContain("(The Cafe)");
    expect(request.task).toContain('1. Yes; 2. No');
    await expect(webBaseline("Will it rain?", ["Yes", "No"], 1, 2)).resolves.toBeNull();
  });

  it("returns null when the fetch is aborted at the client timeout", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("CONTEXT_DEV_API_KEY", "test-key");

    await expect(webBaseline("Question?", ["Yes", "No"], 1, 2, { timeoutMs: 10 })).resolves.toBeNull();
  });
});
