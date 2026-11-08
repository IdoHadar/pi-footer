import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ConfigModule from "../src/config.js";
import type * as GitModule from "../src/git.js";
import { loadConfig, normalizeConfig, saveConfig } from "../src/config.js";
import statuslineExtension from "../src/index.js";
import { openStatuslineConfigUi } from "../src/ui.js";
import { identityPiTheme } from "./helpers/theme.js";

vi.mock("../src/config.js", async (original) => ({
  ...(await original<typeof ConfigModule>()),
  loadConfig: vi.fn<() => Promise<unknown>>(),
  saveConfig: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

vi.mock("../src/ui.js", () => ({
  openStatuslineConfigUi: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("../src/git.js", async (original) => {
  const actual = await original<typeof GitModule>();
  return {
    ...actual,
    loadGitInfo: vi.fn<() => Promise<unknown>>().mockResolvedValue(actual.EMPTY_GIT_INFO),
  };
});

const NOW = Date.UTC(2026, 6, 19);
type Footer = { dispose(): void; render(width: number): string[] };
type Handler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
type FooterData = {
  getGitBranch(): null;
  getExtensionStatuses(): ReadonlyMap<string, string>;
  onBranchChange(callback: () => void): () => void;
};
type Factory = (tui: { requestRender(): void }, theme: Theme, data: FooterData) => Footer;

async function setup(
  options: {
    enabled?: boolean;
    widgetEnabled?: boolean;
    hasUI?: boolean;
    widgetPresent?: boolean;
  } = {},
) {
  const config = normalizeConfig({
    enabled: options.enabled ?? true,
    iconMode: "text",
    separator: "none",
    terminal: { colorLevel: "none" },
    lines: [
      [
        {
          type: options.widgetPresent === false ? "model" : "openai-usage-bar",
          enabled: options.widgetEnabled ?? true,
          options: { display: "short" },
        },
      ],
    ],
  });
  vi.mocked(loadConfig).mockResolvedValue(config);
  const handlers = new Map<string, Handler>();
  const commands = new Map<
    string,
    { handler(args: string, ctx: ExtensionContext): Promise<void> }
  >();
  const redraw = vi.fn<() => void>();
  const footers: Footer[] = [];
  let current: Footer | undefined;
  const ctx = {
    hasUI: options.hasUI ?? true,
    cwd: "/project",
    model: { id: "codex", provider: "openai-codex" },
    modelRegistry: {
      isUsingOAuth: () => true,
      getProviderAuth: async () => ({
        auth: {
          apiKey: `header.${Buffer.from(
            JSON.stringify({
              "https://api.openai.com/auth": { chatgpt_account_id: "account" },
            }),
          ).toString("base64url")}.signature`,
        },
      }),
    },
    getContextUsage: () => undefined,
    sessionManager: { getSessionId: () => "session", getBranch: () => [], getEntries: () => [] },
    ui: {
      theme: identityPiTheme,
      notify: () => {},
      setStatus: () => {},
      setFooter: (factory?: Factory) => {
        if (!factory) {
          current?.dispose();
          current = undefined;
          return;
        }
        current = factory({ requestRender: redraw }, identityPiTheme, {
          getGitBranch: () => null,
          getExtensionStatuses: () => new Map(),
          onBranchChange: () => () => {},
        });
        footers.push(current);
      },
    },
  } as unknown as ExtensionContext;
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    events: { on: () => {} },
    registerCommand: (
      name: string,
      command: { handler(args: string, ctx: ExtensionContext): Promise<void> },
    ) => commands.set(name, command),
    getSessionName: () => "session",
    getThinkingLevel: () => "low",
    getActiveTools: () => [],
  } as unknown as ExtensionAPI;
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () =>
    Response.json({
      rate_limit: {
        primary_window: {
          limit_window_seconds: 604_800,
          used_percent: 3,
          reset_at: NOW / 1000 + 3600,
        },
      },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  await statuslineExtension(pi);
  const emit = async (event: string, context = ctx) => {
    await handlers.get(event)?.({}, context);
  };
  cleanups.push(() => emit("session_shutdown"));
  return { config, ctx, fetch, redraw, footers, commands, emit, current: () => current };
}

const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("OpenAI allowance footer lifecycle", () => {
  it("starts outside rendering, redraws new data, and does not fetch on render", async () => {
    const app = await setup();
    await app.emit("session_start");
    await vi.advanceTimersByTimeAsync(0);
    expect(app.fetch).toHaveBeenCalledTimes(1);
    expect(app.redraw).toHaveBeenCalled();
    expect(app.current()?.render(100)).toEqual(["Usage [▓▓▓▓▓▓▓▓▓▓] 97%"]);
    app.current()?.render(100);
    expect(app.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(app.fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["disabled-footer", "disabled-widget", "absent-widget", "headless"])(
    "does not fetch for %s",
    async (mode) => {
      const app = await setup({
        enabled: mode !== "disabled-footer",
        widgetEnabled: mode !== "disabled-widget",
        widgetPresent: mode !== "absent-widget",
        hasUI: mode !== "headless",
      });
      await app.emit("session_start");
      await vi.advanceTimersByTimeAsync(180_000);
      expect(app.fetch).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("a replaced footer's delayed disposal cannot stop the new binding", async () => {
    const app = await setup();
    await app.emit("session_start");
    await vi.advanceTimersByTimeAsync(0);
    const oldFooter = app.current();
    await app.emit("model_select");
    oldFooter?.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(app.current()?.render(100)).toEqual(["Usage [▓▓▓▓▓▓▓▓▓▓] 97%"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(app.fetch).toHaveBeenCalledTimes(3);
  });

  it.each(["disable", "dispose", "shutdown", "headless"])(
    "%s stops polling and removes cached allowance",
    async (mode) => {
      const app = await setup();
      await app.emit("session_start");
      await vi.advanceTimersByTimeAsync(0);
      if (mode === "disable") await app.commands.get("footer")?.handler("off", app.ctx);
      if (mode === "dispose") app.current()?.dispose();
      if (mode === "shutdown") await app.emit("session_shutdown");
      if (mode === "headless") await app.emit("model_select", { ...app.ctx, hasUI: false });
      expect(app.footers[0]?.render(100)).toEqual([]);
      await vi.advanceTimersByTimeAsync(180_000);
      expect(app.fetch).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("preview receives the existing snapshot without starting a second poller", async () => {
    const app = await setup();
    await app.emit("session_start");
    await vi.advanceTimersByTimeAsync(0);
    const captured: unknown[] = [];
    vi.mocked(openStatuslineConfigUi).mockImplementation(async (_ctx, config, data) => {
      captured.push(data.openAIUsage);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(app.fetch).toHaveBeenCalledTimes(2);
      return { config, saved: false };
    });
    await app.commands.get("footer")?.handler("", app.ctx);
    expect(captured).toEqual([{ weekly: { leftPercent: 97, resetsAtMs: NOW + 3_600_000 } }]);
    expect(vi.mocked(saveConfig)).not.toHaveBeenCalled();
  });
});
