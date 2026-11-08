import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, normalizeConfig } from "../../../src/config.js";
import { hasEnabledOpenAIUsageWidget } from "../../../src/openai-usage.js";
import type { WidgetOptions } from "../../../src/types.js";
import { fieldsForWidget, formatWidgetOptions } from "../../../src/ui/fields.js";
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
