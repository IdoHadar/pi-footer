import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG, loadConfig, normalizeConfig, saveConfig } from "../../../src/config.js";
import { hasEnabledOpenAIUsageWidget } from "../../../src/openai-usage.js";
import type { WidgetOptions } from "../../../src/types.js";
import {
  colorFields,
  fieldsForWidget,
  formatWidgetColorOptions,
  formatWidgetOptions,
} from "../../../src/ui/fields.js";
import { applyOptionField } from "../../../src/ui/option-edit.js";
import { registry } from "../../../src/widgets/registry.js";
import type { WidgetContext } from "../../../src/widgets/types.js";

function widget(options: WidgetOptions = {}) {
  return registry.createWidget("openai-usage-bar", options);
}

function ctx(
  overrides: Partial<WidgetContext<["openAIUsage"]>> = {},
): WidgetContext<["openAIUsage"]> {
  return {
    iconMode: "text",
    minimalist: false,
    colorLevel: "none",
    openAIUsage: {
      "5h": { leftPercent: 25, resetsAtMs: 1 },
      weekly: { leftPercent: 50, resetsAtMs: 2 },
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("OpenAI Usage Bar", () => {
  it.each([
    [154 * 3_600_000, "6d 10h"],
    [24 * 3_600_000, "1d 0h"],
    [24 * 3_600_000 - 1, "23h"],
    [3_600_000, "1h"],
    [3_600_000 - 1, "59m"],
    [60_000, "1m"],
    [59_999, "<1m"],
    [1, "<1m"],
    [0, "0m"],
    [-1, "0m"],
  ])("renders the countdown at %s ms as %s", (remaining, expected) => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 6, 19);
    vi.setSystemTime(now);
    expect(
      widget({ showResetCountdown: true, display: "short" }).render(
        ctx({ openAIUsage: { weekly: { leftPercent: 50, resetsAtMs: now + remaining } } }),
      ),
    ).toBe(`Usage [▓▓▓▓▓░░░░░] 50% ${expected}`);
  });

  it.each(["default", "short", "medium", "short-only"])(
    "preserves %s mode, raw output, and custom icons with countdown enabled",
    (display) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const context = ctx({
        openAIUsage: { "5h": { leftPercent: 25, resetsAtMs: 3_600_000 } },
      });
      const suffix = display === "short-only" ? "" : " 1h";
      expect(widget({ display, showResetCountdown: true }).render(context)).toBe(
        `${widget({ display }).render(context)}${suffix}`,
      );
      expect(widget({ display, raw: true, showResetCountdown: true }).render(context)).toBe(
        `${widget({ display, raw: true }).render(context)}${suffix}`,
      );
      expect(widget({ display, icon: "Quota", showResetCountdown: true }).render(context)).toBe(
        `${widget({ display, icon: "Quota" }).render(context)}${suffix}`,
      );
    },
  );

  it.each([
    ["auto", true, "Usage [▓▓▓░░░░░░░] 25% 1h"],
    ["5h", true, "Usage [▓▓▓░░░░░░░] 25% 1h"],
    ["weekly", true, "Usage [▓▓▓▓▓░░░░░] 50% 6d 10h"],
    ["auto", false, "Usage [▓▓▓▓▓░░░░░] 50% 6d 10h"],
    ["5h", false, undefined],
  ])("uses the selected %s deadline with 5h present %s", (usageWindow, fiveHour, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    expect(
      widget({ display: "short", usageWindow, showResetCountdown: true }).render(
        ctx({
          openAIUsage: {
            ...(fiveHour ? { "5h": { leftPercent: 25, resetsAtMs: 3_600_000 } } : {}),
            weekly: { leftPercent: 50, resetsAtMs: 154 * 3_600_000 },
          },
        }),
      ),
    ).toBe(expected);
  });

  it.each([undefined, {}])("hides missing allowance with countdown enabled", (openAIUsage) => {
    expect(widget({ showResetCountdown: true }).render(ctx({ openAIUsage }))).toBeUndefined();
  });

  it.each([
    [25, 33, 45],
    [5, 31, 46],
    [50, 36, 44],
  ])("keeps countdown within the selected colors at %s remaining", (leftPercent, fg, bg) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const context = ctx({
      colorLevel: "ansi16",
      openAIUsage: { "5h": { leftPercent, resetsAtMs: 3_600_000 } },
    });
    const bar = widget({
      display: "short",
      showResetCountdown: true,
      usageConditionalColors: true,
      fg: "cyan",
      bg: "blue",
      bold: true,
      warningBg: "magenta",
      dangerBg: "cyan",
    });
    const output = bar.render(context);
    expect(output).toMatch(new RegExp(`^\\x1b\\[1m\\x1b\\[${bg}m\\x1b\\[${fg}mUsage `));
    expect(output).toContain(` ${leftPercent}% 1h\x1b[39m\x1b[49m\x1b[22m`);
  });

  it("normalizes, toggles, saves and restores countdown through metadata", async () => {
    const bar = widget();
    expect(bar.options.showResetCountdown).toBe(false);
    expect(widget({ showResetCountdown: "true" }).options.showResetCountdown).toBe(false);
    const toggle = fieldsForWidget(bar).find(({ id }) => id === "showResetCountdown")!;
    expect(toggle).toMatchObject({ label: "Show reset countdown", kind: "boolean" });
    expect(applyOptionField(bar, toggle, 1)).toBe("changed");
    expect(bar.options.showResetCountdown).toBe(true);
    expect(formatWidgetOptions(bar)).toContain("reset-countdown");
    expect(formatWidgetColorOptions(bar)).not.toContain("reset-countdown");
    expect(colorFields(bar).map(({ id }) => id)).not.toContain("showResetCountdown");
    const directory = await mkdtemp(join(tmpdir(), "pi-footer-countdown-"));
    try {
      const path = join(directory, "config.json");
      const config = normalizeConfig({ lines: [[registry.createEntry(bar.type, bar.options)]] });
      await saveConfig(config, path);
      const restored = await loadConfig(path);
      expect(restored.lines[0]?.[0]?.options.showResetCountdown).toBe(true);
      expect(applyOptionField(bar, toggle, 1)).toBe("changed");
      expect(bar.options.showResetCountdown).toBe(false);
      expect(formatWidgetOptions(bar)).not.toContain("reset-countdown");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each([
    ["default", "[████████░░░░░░░░░░░░░░░░░░░░░░░░] 25%", "[████████████████░░░░░░░░░░░░░░░░] 50%"],
    ["short", "[▓▓▓░░░░░░░] 25%", "[▓▓▓▓▓░░░░░] 50%"],
    ["short-only", "[▓▓▓░░░░░░░]", "[▓▓▓▓▓░░░░░]"],
    ["medium", "[████░░░░░░░░░░░░] 25%", "[████████░░░░░░░░] 50%"],
  ])("fills remaining allowance in %s mode for both windows", (display, fiveHour, weekly) => {
    expect(widget({ raw: true, display, usageWindow: "5h" }).render(ctx())).toBe(fiveHour);
    expect(widget({ raw: true, display, usageWindow: "weekly" }).render(ctx())).toBe(weekly);
  });

  it("defaults to the available window, preferring 5h when both are present", () => {
    expect(widget({ raw: true, display: "short" }).render(ctx())).toBe("[▓▓▓░░░░░░░] 25%");
    expect(
      widget({ display: "short" }).render(
        ctx({
          openAIUsage: {
            weekly: { leftPercent: 97, resetsAtMs: 1 },
          },
        }),
      ),
    ).toBe("Usage [▓▓▓▓▓▓▓▓▓▓] 97%");
  });

  it("hides unknown and explicitly unavailable windows instead of showing a full bar", () => {
    expect(widget().render(ctx({ openAIUsage: undefined }))).toBeUndefined();
    expect(widget().render(ctx({ openAIUsage: {} }))).toBeUndefined();
    expect(
      widget({ usageWindow: "5h" }).render(
        ctx({
          openAIUsage: {
            weekly: { leftPercent: 97, resetsAtMs: 1 },
          },
        }),
      ),
    ).toBeUndefined();
    expect(
      widget({ usageWindow: "weekly" }).render(
        ctx({
          openAIUsage: {
            "5h": { leftPercent: 25, resetsAtMs: 1 },
          },
        }),
      ),
    ).toBeUndefined();
  });

  it("keeps known zero visible and does not fall back to weekly", () => {
    expect(
      widget({ display: "short" }).render(
        ctx({
          openAIUsage: {
            "5h": { leftPercent: 0, resetsAtMs: 1 },
            weekly: { leftPercent: 97, resetsAtMs: 1 },
          },
        }),
      ),
    ).toBe("Usage [░░░░░░░░░░] 0%");
  });

  it.each(["emoji", "nerd", "text"] as const)(
    "labels the subscription as Usage in %s mode",
    (iconMode) => {
      expect(widget({ display: "short-only" }).render(ctx({ iconMode }))).toBe(
        "Usage [▓▓▓░░░░░░░]",
      );
    },
  );

  it("discovers Window and Display choices entirely through metadata", () => {
    expect(registry.definitions).toContainEqual({
      type: "openai-usage-bar",
      label: "OpenAI Usage Bar",
      category: "Tokens",
      description: "OpenAI subscription allowance left",
    });
    expect(fieldsForWidget(widget()).map((field) => field.id)).toEqual([
      "enabled",
      "raw",
      "icon",
      "usageWindow",
      "display",
      "showResetCountdown",
      "usageConditionalColors",
    ]);
    expect(formatWidgetOptions(widget({ usageWindow: "weekly", display: "short" }))).toContain(
      "window=weekly",
    );
    expect(formatWidgetOptions(widget({ usageWindow: "weekly", display: "short" }))).toContain(
      "display=Short bar",
    );
    const choices = registry
      .spec("openai-usage-bar")
      .properties.find((property) => property.id === "usageWindow")?.options?.choices;
    expect(choices?.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "auto", label: "Available window" },
      { id: "5h", label: "5 hours" },
      { id: "weekly", label: "Weekly" },
    ]);
  });

  it("normalizes valid options and replaces invalid ones with metadata defaults", () => {
    const normalized = normalizeConfig({
      lines: [
        [
          { type: "openai-usage-bar", options: { usageWindow: "weekly", display: "medium" } },
          { type: "openai-usage-bar", options: { usageWindow: "monthly", display: "wide" } },
        ],
      ],
    });
    expect(normalized.lines[0]?.[0]?.options).toMatchObject({
      usageWindow: "weekly",
      display: "medium",
    });
    expect(normalized.lines[0]?.[1]?.options).toMatchObject({
      usageWindow: "auto",
      display: "default",
    });
  });

  it("keeps custom base colors by default even at zero remaining", () => {
    const bar = widget({ fg: "cyan", bg: "blue", bold: true, display: "short-only" });
    expect(bar.options.usageConditionalColors).toBe(false);
    expect(
      bar.render(
        ctx({
          colorLevel: "ansi16",
          openAIUsage: {
            "5h": { leftPercent: 0, resetsAtMs: 1 },
          },
        }),
      ),
    ).toBe("\x1b[1m\x1b[44m\x1b[36mUsage [░░░░░░░░░░]\x1b[39m\x1b[49m\x1b[22m");
  });

  it.each([
    [30.01, 34],
    [30, 33],
    [29.99, 33],
    [10.01, 33],
    [10, 31],
    [9.99, 31],
    [0, 31],
  ])("colors unrounded remaining %s inclusively", (leftPercent, code) => {
    const output = widget({ usageConditionalColors: true, display: "short" }).render(
      ctx({
        colorLevel: "ansi16",
        openAIUsage: { "5h": { leftPercent, resetsAtMs: 1 } },
      }),
    );
    expect(output).toMatch(new RegExp(`^\\x1b\\[${code}mUsage `));
    expect(output).toContain(` ${Math.round(leftPercent)}%`);
  });

  it.each([
    [60, 20, 50, 33],
    [60, 20, 20, 31],
    [60, 20, 61, 34],
    [40, 40, 40, 31],
    [10, 30, 20, 31],
    [10, 30, 5, 31],
  ])(
    "uses warning %s and danger %s at %s with danger precedence",
    (warning, danger, leftPercent, code) => {
      expect(
        widget({
          usageConditionalColors: true,
          usageWarningPercent: warning,
          usageDangerPercent: danger,
        }).render(
          ctx({
            colorLevel: "ansi16",
            openAIUsage: {
              "5h": { leftPercent, resetsAtMs: 1 },
            },
          }),
        ),
      ).toMatch(new RegExp(`^\\x1b\\[${code}mUsage `));
    },
  );

  it.each([
    [
      "auto",
      { "5h": { leftPercent: 25, resetsAtMs: 1 }, weekly: { leftPercent: 5, resetsAtMs: 1 } },
      33,
    ],
    [
      "weekly",
      { "5h": { leftPercent: 25, resetsAtMs: 1 }, weekly: { leftPercent: 5, resetsAtMs: 1 } },
      31,
    ],
    ["auto", { weekly: { leftPercent: 5, resetsAtMs: 1 } }, 31],
  ])("colors the selected %s window", (usageWindow, openAIUsage, code) => {
    expect(
      widget({ usageConditionalColors: true, usageWindow }).render(
        ctx({
          colorLevel: "ansi16",
          openAIUsage,
        }),
      ),
    ).toMatch(new RegExp(`^\\x1b\\[${code}mUsage `));
  });

  it.each([
    [25, 33, 45],
    [5, 31, 46],
    [50, 36, 44],
  ])(
    "keeps backgrounds, bold, prefix and short-only format at %s remaining",
    (leftPercent, fg, bg) => {
      const output = widget({
        usageConditionalColors: true,
        display: "short-only",
        fg: "cyan",
        bg: "blue",
        bold: true,
        warningBg: "magenta",
        dangerBg: "cyan",
      }).render(
        ctx({
          colorLevel: "ansi16",
          openAIUsage: {
            "5h": { leftPercent, resetsAtMs: 1 },
          },
        }),
      );
      const bars: Record<number, string> = {
        25: "[▓▓▓░░░░░░░]",
        5: "[▓░░░░░░░░░]",
        50: "[▓▓▓▓▓░░░░░]",
      };
      expect(output).toBe(
        `\x1b[1m\x1b[${bg}m\x1b[${fg}mUsage ${bars[leftPercent]}\x1b[39m\x1b[49m\x1b[22m`,
      );
    },
  );

  it("hides missing windows with conditional colors enabled", () => {
    const bar = widget({ usageConditionalColors: true, usageWindow: "weekly" });
    expect(bar.render(ctx({ openAIUsage: undefined }))).toBeUndefined();
    expect(bar.render(ctx({ openAIUsage: {} }))).toBeUndefined();
    expect(
      bar.render(ctx({ openAIUsage: { "5h": { leftPercent: 0, resetsAtMs: 1 } } })),
    ).toBeUndefined();
  });

  it("toggles threshold visibility and bounds through the existing editor", () => {
    const bar = widget();
    expect(bar.options).toMatchObject({
      usageWarningPercent: 30,
      usageDangerPercent: 10,
      warningFg: "yellow",
      dangerFg: "red",
      warningBg: "default",
      dangerBg: "default",
    });
    expect(fieldsForWidget(bar).map(({ id }) => id)).not.toContain("usageWarningPercent");
    const toggle = fieldsForWidget(bar).find(({ id }) => id === "usageConditionalColors")!;
    expect(applyOptionField(bar, toggle, 1)).toBe("changed");
    for (const id of ["usageWarningPercent", "usageDangerPercent"]) {
      const field = fieldsForWidget(bar).find((field) => field.id === id)!;
      expect(field).toMatchObject({ kind: "number", min: 0, max: 100 });
      applyOptionField(bar, field, -200);
      expect(bar.options[id]).toBe(0);
      applyOptionField(bar, field, 200);
      expect(bar.options[id]).toBe(100);
    }
    expect(formatWidgetOptions(bar)).toContain("with-colors");
    expect(formatWidgetColorOptions(bar)).toContain("with-colors");
    applyOptionField(bar, toggle, 1);
    expect(fieldsForWidget(bar).map(({ id }) => id)).not.toContain("usageDangerPercent");
    expect(colorFields(bar).map(({ id }) => id)).not.toContain("warningFg");
    expect(formatWidgetOptions(bar)).not.toContain("with-colors");
    expect(widget({ usageWarningPercent: -5, usageDangerPercent: 110 }).options).toMatchObject({
      usageWarningPercent: 0,
      usageDangerPercent: 100,
    });
    expect(
      widget({ usageWarningPercent: "invalid", usageDangerPercent: "invalid" }).options,
    ).toMatchObject({
      usageWarningPercent: 30,
      usageDangerPercent: 10,
    });
  });

  it("only enables monitoring when an instance is enabled, without changing presets", () => {
    expect(hasEnabledOpenAIUsageWidget(DEFAULT_CONFIG)).toBe(false);
    const entry = registry.createEntry("openai-usage-bar");
    expect(
      hasEnabledOpenAIUsageWidget({ ...DEFAULT_CONFIG, lines: [[{ ...entry, enabled: false }]] }),
    ).toBe(false);
    expect(
      hasEnabledOpenAIUsageWidget({
        ...DEFAULT_CONFIG,
        lines: [[entry, registry.cloneEntry(entry)]],
      }),
    ).toBe(true);
  });
});
