import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, normalizeConfig } from "../../../src/config.js";
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

describe("OpenAI Usage Bar", () => {
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
