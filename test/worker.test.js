import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker from "../src/index.js";

// test doubles
//
// the worker never creates its own KV store, rate limiter or API key: the
// runtime hands them in as `env`. that is what makes it testable. we hand it
// small fakes instead, which record how they were used.

const ALLOWED = "https://pokemon-finder-react-b8o.pages.dev";
const UPSTREAM = "https://api.pokemontcg.io/v2/cards";
const QUERY = "?q=name:pikachu&pageSize=1";
const CARDS = { data: [{ id: "base1-58", name: "Pikachu" }] };

function makeEnv({ allowed = true, cached = null, kvThrows = false } = {}) {
  const store = new Map();
  if (cached) store.set(`tcg:${QUERY}`, cached);

  return {
    TCG_API_KEY: "test-key",
    TCG_RATE_LIMITER: {
      limit: vi.fn(async () => ({ success: allowed })),
    },
    TCG_CACHE: {
      get: vi.fn(async (key) => {
        if (kvThrows) throw new Error("KV is down");
        return store.get(key) ?? null;
      }),
      put: vi.fn(async (key, value) => {
        store.set(key, JSON.parse(value));
      }),
    },
  };
}

function makeRequest({ origin = ALLOWED, method = "GET", query = QUERY } = {}) {
  const headers = { "CF-Connecting-IP": "203.0.113.7" };
  if (origin) headers.Origin = origin;
  return new Request(`https://tcg-proxy.test/${query}`, { method, headers });
}

// one fake upstream answer: what fetch() resolves to
function upstream(status, body) {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
  });
}

let fetchMock;

beforeEach(() => {
  fetchMock = vi.fn(async () => upstream(200, CARDS));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// CORS

describe("CORS", () => {
  it("echoes an allowed origin back", async () => {
    const res = await worker.fetch(makeRequest(), makeEnv());

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED);
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("allows the React app's per-deploy preview subdomains", async () => {
    const preview = "https://1f089d80.pokemon-finder-react-b8o.pages.dev";
    const res = await worker.fetch(makeRequest({ origin: preview }), makeEnv());

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(preview);
  });

  it("allows the ui-rehaul branch preview through the pattern", async () => {
    const branch = "https://ui-rehaul.pokemon-finder-react-b8o.pages.dev";
    const res = await worker.fetch(makeRequest({ origin: branch }), makeEnv());

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(branch);
  });

  it.each([
    "https://evil.example",
    "https://pokemon-finder-react-b8o.pages.dev.evil.com",
    "http://pokemon-finder-react-b8o.pages.dev",
    "https://pokemon-finder-5wx.pages.dev",
  ])("gives no permission to %s", async (origin) => {
    const res = await worker.fetch(makeRequest({ origin }), makeEnv());

    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("answers a preflight without calling the TCG API", async () => {
    const env = makeEnv();
    const res = await worker.fetch(makeRequest({ method: "OPTIONS" }), env);

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, OPTIONS",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(env.TCG_RATE_LIMITER.limit).not.toHaveBeenCalled();
  });
});

// refusals: each one still carries the CORS headers
describe("refusals", () => {
  it("rate-limits by client IP, with CORS headers", async () => {
    const env = makeEnv({ allowed: false });
    const res = await worker.fetch(makeRequest(), env);

    expect(res.status).toBe(429);
    expect(env.TCG_RATE_LIMITER.limit).toHaveBeenCalledWith({
      key: "203.0.113.7",
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses methods other than GET, with CORS headers", async () => {
    const res = await worker.fetch(makeRequest({ method: "POST" }), makeEnv());

    expect(res.status).toBe(405);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// cache-aside
describe("cache", () => {
  it("answers from KV on a hit, without calling the TCG API", async () => {
    const res = await worker.fetch(makeRequest(), makeEnv({ cached: CARDS }));

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("HIT");
    expect(await res.json()).toEqual(CARDS);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("on a miss, forwards the query with the secret key and caches the answer for 24 hours", async () => {
    const env = makeEnv();
    const res = await worker.fetch(makeRequest(), env);

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("MISS");
    expect(await res.json()).toEqual(CARDS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${UPSTREAM}${QUERY}`);
    expect(init.headers["X-Api-Key"]).toBe("test-key");

    expect(env.TCG_CACHE.put).toHaveBeenCalledWith(
      `tcg:${QUERY}`,
      JSON.stringify(CARDS),
      {
        expirationTtl: 86400,
      },
    );
  });
});

// upstream failures
describe("upstream failures", () => {
  it("retries once after a server error and returns the second answer", async () => {
    fetchMock
      .mockResolvedValueOnce(upstream(500, { error: "busy" }))
      .mockResolvedValueOnce(upstream(200, CARDS));

    const res = await worker.fetch(makeRequest(), makeEnv());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(CARDS);
  });

  it("answers 502 with CORS headers after two empty bodies, and caches nothing", async () => {
    fetchMock.mockImplementation(async () => upstream(200));
    const env = makeEnv();

    const res = await worker.fetch(makeRequest(), env);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(502);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED);
    expect(env.TCG_CACHE.put).not.toHaveBeenCalled();
  });

  it("does not retry or cache a client error", async () => {
    fetchMock.mockResolvedValueOnce(upstream(404, { error: "not found" }));
    const env = makeEnv();

    const res = await worker.fetch(makeRequest(), env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(404);
    expect(env.TCG_CACHE.put).not.toHaveBeenCalled();
  });

  it("turns an unexpected crash into a 500 that still carries CORS headers", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await worker.fetch(makeRequest(), makeEnv({ kvThrows: true }));

    expect(res.status).toBe(500);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED);
  });
});
