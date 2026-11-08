import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpenAIUsageMonitor } from "../src/openai-usage.js";

const NOW = Date.UTC(2026, 6, 19);
const RESET = NOW / 1000 + 3600;

function token(accountId = "account-one"): string {
  return `header.${Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url")}.signature`;
}

function window(seconds = 18_000, used = 27, reset = RESET) {
  return { limit_window_seconds: seconds, used_percent: used, reset_at: reset };
}

function body(primary: unknown = window(), secondary?: unknown) {
  return { rate_limit: { primary_window: primary, secondary_window: secondary } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup() {
  const getProviderAuth = vi.fn<(provider: string) => Promise<unknown>>().mockResolvedValue({
    auth: {
      apiKey: token(),
      headers: { "X-Untrusted": "never-forward" },
      baseUrl: "https://example.com",
    },
  });
  const isUsingOAuth = vi.fn<() => boolean>().mockReturnValue(true);
  const ctx = {
    hasUI: true,
    model: { provider: "openai-codex" },
    modelRegistry: { getProviderAuth, isUsingOAuth },
  } as unknown as ExtensionContext;
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => Response.json(body()));
  vi.stubGlobal("fetch", fetch);
  const changed = vi.fn<() => void>();
  const monitor = new OpenAIUsageMonitor();
  monitors.push(monitor);
  return { monitor, ctx, fetch, changed, getProviderAuth, isUsingOAuth };
}

const monitors: OpenAIUsageMonitor[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  for (const monitor of monitors.splice(0)) monitor.stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("OpenAI allowance parsing through the monitor", () => {
  it.each([
    ["normal", body(window(), window(604_800, 3)), { "5h": 73, weekly: 97 }],
    ["reversed", body(window(604_800, 3), window()), { "5h": 73, weekly: 97 }],
    ["weekly only", body(window(604_800, 3)), { weekly: 97 }],
    ["secondary only", body(null, window()), { "5h": 73 }],
    ["zero left", body(window(18_000, 100)), { "5h": 0 }],
    ["full left", body(window(18_000, 0)), { "5h": 100 }],
    ["duplicate durations", body(window(), window()), undefined],
    ["missing windows", body(null), undefined],
    ["unknown duration", body(window(42)), undefined],
    ["missing rate limit", {}, undefined],
    ["non-object", null, undefined],
  ])("handles %s", async (_name, payload, percentages) => {
    const { monitor, ctx, fetch, changed } = setup();
    fetch.mockResolvedValue(Response.json(payload));
    monitor.bind({ enabled: true, ctx, changed });
    await vi.advanceTimersByTimeAsync(0);
    const expected = percentages
      ? Object.fromEntries(
          Object.entries(percentages).map(([key, leftPercent]) => [
            key,
            {
              leftPercent,
              resetsAtMs: RESET * 1000,
            },
          ]),
        )
      : undefined;
    expect(monitor.snapshot()).toEqual(expected);
  });

  it.each([-1, 101, NaN, Infinity, "27", null, undefined])(
    "rejects malformed used percent %s",
    async (used) => {
      const { monitor, ctx, fetch, changed } = setup();
      fetch.mockResolvedValue({
        ok: true,
        json: async () => body({ ...window(), used_percent: used }, window(604_800, 3)),
      } as Response);
      monitor.bind({ enabled: true, ctx, changed });
      await vi.advanceTimersByTimeAsync(0);
      expect(monitor.snapshot()).toEqual({ weekly: { leftPercent: 97, resetsAtMs: RESET * 1000 } });
    },
  );

  it.each([0, NOW / 1000, -1, NaN, Infinity, Number.MAX_VALUE, 9e12, "42", null, undefined])(
    "rejects invalid reset %s",
    async (reset) => {
      const { monitor, ctx, fetch, changed } = setup();
      fetch.mockResolvedValue({
        ok: true,
        json: async () => body({ ...window(), reset_at: reset }),
      } as Response);
      monitor.bind({ enabled: true, ctx, changed });
      await vi.advanceTimersByTimeAsync(0);
      expect(monitor.snapshot()).toBeUndefined();
    },
  );
});

describe("OpenAI allowance auth and polling", () => {
  it("uses resolved OAuth apiKey and only explicit headers at the fixed endpoint", async () => {
    const { monitor, ctx, fetch, changed, getProviderAuth } = setup();
    monitor.bind({ enabled: true, ctx, changed });
    await vi.advanceTimersByTimeAsync(0);
    expect(getProviderAuth).toHaveBeenCalledWith("openai-codex");
    expect(fetch).toHaveBeenCalledWith("https://chatgpt.com/backend-api/wham/usage", {
      headers: {
        Authorization: `Bearer ${token()}`,
        "ChatGPT-Account-Id": "account-one",
        Accept: "application/json",
      },
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    expect(monitor.snapshot()?.["5h"]?.leftPercent).toBe(73);
    expect(changed).toHaveBeenCalled();
  });

  it.each(["disabled", "headless", "api-key", "openai", "unrelated", "missing-model"])(
    "does not fetch when %s",
    async (mode) => {
      const { monitor, ctx, fetch, changed, isUsingOAuth } = setup();
      if (mode === "api-key") isUsingOAuth.mockReturnValue(false);
      const context = {
        ...ctx,
        hasUI: mode !== "headless",
        model:
          mode === "missing-model"
            ? undefined
            : {
                ...ctx.model,
                provider:
                  mode === "openai"
                    ? "openai"
                    : mode === "unrelated"
                      ? "anthropic"
                      : "openai-codex",
              },
      } as ExtensionContext;
      monitor.bind({ enabled: mode !== "disabled", ctx: context, changed });
      await vi.advanceTimersByTimeAsync(180_000);
      expect(fetch).not.toHaveBeenCalled();
      expect(monitor.snapshot()).toBeUndefined();
      expect(vi.getTimerCount()).toBe(["disabled", "headless"].includes(mode) ? 0 : 1);
    },
  );

  it.each([
    undefined,
    { auth: { apiKey: "api-key" } },
    { auth: { access: token() } },
    { auth: { apiKey: "a.eyJmb28iOjF9.c" } },
    { auth: { apiKey: "a.b.c" } },
    { auth: { apiKey: token("") } },
    { auth: { apiKey: token("account\r\nmalicious") } },
  ])("hides unsupported auth without fetching", async (auth) => {
    const { monitor, ctx, fetch, changed, getProviderAuth } = setup();
    getProviderAuth.mockResolvedValue(auth);
    monitor.bind({ enabled: true, ctx, changed });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(monitor.snapshot()).toBeUndefined();
  });

  it("refreshes while idle, resolves current credentials, and redraws changed data", async () => {
    const { monitor, ctx, fetch, changed, getProviderAuth } = setup();
    monitor.bind({ enabled: true, ctx, changed });
    await vi.advanceTimersByTimeAsync(0);
    changed.mockClear();
    fetch.mockResolvedValue(Response.json(body(window(18_000, 50))));
    getProviderAuth.mockResolvedValue({ auth: { apiKey: token("account-two") } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(monitor.snapshot()?.["5h"]?.leftPercent).toBe(50);
    expect(fetch.mock.calls.at(-1)?.[1]?.headers).toMatchObject({
      "ChatGPT-Account-Id": "account-two",
    });
    expect(changed).toHaveBeenCalled();
  });

  it("waits 60 seconds after completion before polling again", async () => {
    const { monitor, ctx, fetch, changed } = setup();
    const pending = deferred<Response>();
    fetch.mockReturnValueOnce(pending.promise);
    monitor.bind({ enabled: true, ctx, changed });
    await vi.advanceTimersByTimeAsync(5_000);
    pending.resolve(Response.json(body()));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["http", "network", "json", "auth", "logout"])(
    "clears old data on %s failure",
    async (failure) => {
      const { monitor, ctx, fetch, changed, getProviderAuth } = setup();
      monitor.bind({ enabled: true, ctx, changed });
      await vi.advanceTimersByTimeAsync(0);
      changed.mockClear();
      if (failure === "http") fetch.mockResolvedValue(new Response(null, { status: 401 }));
      if (failure === "network") fetch.mockRejectedValue(new Error("offline"));
      if (failure === "json") fetch.mockResolvedValue(new Response("invalid json"));
      if (failure === "auth") getProviderAuth.mockRejectedValue(new Error("auth unavailable"));
      if (failure === "logout") getProviderAuth.mockResolvedValue(undefined);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(monitor.snapshot()).toBeUndefined();
      expect(changed).toHaveBeenCalled();
    },
  );

  it("clears old account data before a new account response completes", async () => {
    const { monitor, ctx, fetch, changed, getProviderAuth } = setup();
    monitor.bind({ enabled: true, ctx, changed });
    await vi.advanceTimersByTimeAsync(0);
    const pending = deferred<Response>();
    getProviderAuth.mockResolvedValue({ auth: { apiKey: token("account-two") } });
    fetch.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(monitor.snapshot()).toBeUndefined();
    pending.resolve(Response.json(body(window(18_000, 50))));
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.snapshot()?.["5h"]?.leftPercent).toBe(50);
  });

  it("expires reset windows independently and requests a redraw", async () => {
    const { monitor, ctx, fetch, changed } = setup();
    fetch.mockResolvedValue(
      Response.json(body(window(18_000, 27, NOW / 1000 + 5), window(604_800, 3))),
    );
    monitor.bind({ enabled: true, ctx, changed });
    await vi.advanceTimersByTimeAsync(0);
    changed.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(monitor.snapshot()).toEqual({ weekly: { leftPercent: 97, resetsAtMs: RESET * 1000 } });
    expect(changed).toHaveBeenCalled();
  });

  it("expires data after two minutes even when auth never resolves", async () => {
    const { monitor, ctx, changed, getProviderAuth } = setup();
    monitor.bind({ enabled: true, ctx, changed });
    await vi.advanceTimersByTimeAsync(0);
    getProviderAuth.mockReturnValue(new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(119_999);
    expect(monitor.snapshot()?.["5h"]?.leftPercent).toBe(73);
    changed.mockClear();
    await vi.advanceTimersByTimeAsync(1);
    expect(monitor.snapshot()).toBeUndefined();
    expect(changed).toHaveBeenCalled();
  });

  it("aborts a timed-out request and rejects its late result", async () => {
    const { monitor, ctx, fetch, changed } = setup();
    const pending = deferred<Response>();
    fetch.mockReturnValueOnce(pending.promise);
    monitor.bind({ enabled: true, ctx, changed });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    pending.resolve(Response.json(body()));
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.snapshot()).toBeUndefined();
  });

  it.each(["stop", "release", "disable"])(
    "%s cancels requests, clears data, and prevents future polls",
    async (action) => {
      const { monitor, ctx, fetch, changed } = setup();
      const release = monitor.bind({ enabled: true, ctx, changed });
      await vi.advanceTimersByTimeAsync(0);
      const pending = deferred<Response>();
      fetch.mockReturnValueOnce(pending.promise);
      await vi.advanceTimersByTimeAsync(60_000);
      if (action === "stop") {
        monitor.stop();
        monitor.stop();
      }
      if (action === "release") release();
      if (action === "disable") monitor.bind({ enabled: false, ctx, changed });
      expect(fetch.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true);
      expect(monitor.snapshot()).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      pending.resolve(Response.json(body()));
      await vi.advanceTimersByTimeAsync(180_000);
      expect(monitor.snapshot()).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("ignores late auth after disposal without starting a fetch", async () => {
    const { monitor, ctx, fetch, changed, getProviderAuth } = setup();
    const pending = deferred<{ auth: { apiKey: string } }>();
    getProviderAuth.mockReturnValue(pending.promise);
    const release = monitor.bind({ enabled: true, ctx, changed });
    release();
    pending.resolve({ auth: { apiKey: token() } });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(fetch).not.toHaveBeenCalled();
    expect(monitor.snapshot()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["auth", "fetch"])(
    "old %s completion and disposal cannot overwrite a new binding",
    async (stage) => {
      const { monitor, ctx, fetch, changed, getProviderAuth } = setup();
      const oldAuth = deferred<{ auth: { apiKey: string } }>();
      const oldFetch = deferred<Response>();
      if (stage === "auth") getProviderAuth.mockReturnValueOnce(oldAuth.promise);
      else fetch.mockReturnValueOnce(oldFetch.promise);
      const releaseOld = monitor.bind({ enabled: true, ctx, changed });
      await vi.advanceTimersByTimeAsync(0);
      getProviderAuth.mockResolvedValue({ auth: { apiKey: token("account-two") } });
      fetch.mockImplementation(async () => Response.json(body(window(18_000, 50))));
      monitor.bind({ enabled: true, ctx, changed });
      releaseOld();
      await vi.advanceTimersByTimeAsync(0);
      expect(monitor.snapshot()?.["5h"]?.leftPercent).toBe(50);
      oldAuth.resolve({ auth: { apiKey: token() } });
      oldFetch.resolve(Response.json(body()));
      await vi.advanceTimersByTimeAsync(0);
      expect(monitor.snapshot()?.["5h"]?.leftPercent).toBe(50);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(monitor.snapshot()?.["5h"]?.leftPercent).toBe(50);
    },
  );
});
