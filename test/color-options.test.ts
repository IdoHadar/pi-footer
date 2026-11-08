import { describe, expect, it } from "vitest";

import { createHydratedWidgetForTest } from "./helpers/widgets.js";
import { taggedPiTheme } from "./helpers/theme.js";
import { normalizeConfig } from "../src/config.js";
import { colorFields } from "../src/ui/fields.js";
import { registry } from "../src/widgets/registry.js";
import {
  applyColorDigit,
  applyColorOptionField,
  deleteColorDigit,
  EDIT_COLORS_HINT,
  hasCustomAnsiColors,
  resetCustomAnsiColors,
} from "../src/ui/color-options.js";
import type { ColorOptionField } from "../src/ui/model.js";

const field = (id: ColorOptionField["id"]): ColorOptionField => ({ id, label: id, kind: "color" });

describe("color option editing", () => {
  it("toggles bold", () => {
    const widget = createHydratedWidgetForTest("model");

    applyColorOptionField(widget, field("bold"), 1);

    expect(widget.options.bold).toBe(true);
  });

  it("cycles standard and pi foreground and background colors", () => {
    const widget = createHydratedWidgetForTest("model", { fg: "default" });
    const context = createHydratedWidgetForTest("context", {
      warningFg: "default",
      warningBg: "default",
      dangerFg: "default",
      dangerBg: "default",
    });

    applyColorOptionField(widget, field("fg"), 1);
    applyColorOptionField(widget, field("bg"), 2);
    applyColorOptionField(context, field("warningFg"), 3);
    applyColorOptionField(context, field("warningBg"), 4);
    applyColorOptionField(context, field("dangerFg"), 5);
    applyColorOptionField(context, field("dangerBg"), 6);

    expect(widget.options.fg).toBe("black");
    expect(widget.options.bg).toBe("red");
    expect(context.options.warningFg).toBe("green");
    expect(context.options.warningBg).toBe("yellow");
    expect(context.options.dangerFg).toBe("blue");
    expect(context.options.dangerBg).toBe("magenta");

    applyColorOptionField(widget, field("fg"), 16);
    expect(widget.options.fg).toBe("pi:accent");
  });

  it("adjusts ansi foreground and background colors", () => {
    const widget = createHydratedWidgetForTest("model", { fg: "ansi256:10", bg: "ansi256:20" });
    const context = createHydratedWidgetForTest("context", {
      warningFg: "ansi256:30",
      warningBg: "ansi256:40",
      dangerFg: "ansi256:50",
      dangerBg: "ansi256:60",
    });

    applyColorOptionField(widget, field("fgAnsi"), 1);
    applyColorOptionField(widget, field("bgAnsi"), -1);
    applyColorOptionField(context, field("warningFgAnsi"), 1);
    applyColorOptionField(context, field("warningBgAnsi"), -1);
    applyColorOptionField(context, field("dangerFgAnsi"), 1);
    applyColorOptionField(context, field("dangerBgAnsi"), -1);

    expect(widget.options.fg).toBe("ansi256:11");
    expect(widget.options.bg).toBe("ansi256:19");
    expect(context.options.warningFg).toBe("ansi256:31");
    expect(context.options.warningBg).toBe("ansi256:39");
    expect(context.options.dangerFg).toBe("ansi256:51");
    expect(context.options.dangerBg).toBe("ansi256:59");
  });

  it("edits ansi colors with digits", () => {
    const widget = createHydratedWidgetForTest("model");
    const context = createHydratedWidgetForTest("context");

    expect(applyColorDigit(widget, field("fgAnsi"), "9")).toBe(true);
    expect(applyColorDigit(widget, field("fgAnsi"), "9")).toBe(true);
    expect(applyColorDigit(widget, field("fgAnsi"), "9")).toBe(true);
    expect(applyColorDigit(widget, field("bgAnsi"), "6")).toBe(true);
    expect(applyColorDigit(context, field("warningFgAnsi"), "8")).toBe(true);
    expect(applyColorDigit(context, field("warningBgAnsi"), "5")).toBe(true);
    expect(applyColorDigit(context, field("dangerFgAnsi"), "4")).toBe(true);
    expect(applyColorDigit(context, field("dangerBgAnsi"), "7")).toBe(true);
    expect(widget.options.fg).toBe("ansi256:255");
    expect(widget.options.bg).toBe("ansi256:6");
    expect(context.options.warningFg).toBe("ansi256:8");
    expect(context.options.warningBg).toBe("ansi256:5");
    expect(context.options.dangerFg).toBe("ansi256:4");
    expect(context.options.dangerBg).toBe("ansi256:7");

    expect(deleteColorDigit(widget, field("fgAnsi"))).toBe(true);
    expect(deleteColorDigit(widget, field("bgAnsi"))).toBe(true);
    expect(deleteColorDigit(context, field("warningFgAnsi"))).toBe(true);
    expect(deleteColorDigit(context, field("warningBgAnsi"))).toBe(true);
    expect(deleteColorDigit(context, field("dangerFgAnsi"))).toBe(true);
    expect(deleteColorDigit(context, field("dangerBgAnsi"))).toBe(true);
    expect(deleteColorDigit(widget, field("fg"))).toBe(false);
    expect(widget.options.fg).toBe("ansi256:25");
    expect(widget.options.bg).toBe("ansi256:0");
    expect(context.options.warningFg).toBe("ansi256:0");
    expect(context.options.warningBg).toBe("ansi256:0");
    expect(context.options.dangerFg).toBe("ansi256:0");
    expect(context.options.dangerBg).toBe("ansi256:0");

    expect(applyColorDigit(widget, field("fgAnsi"), "x")).toBe(false);
    expect(applyColorDigit(widget, field("fg"), "1")).toBe(false);
  });

  it("detects and resets custom ansi colors", () => {
    const lines = [
      [
        createHydratedWidgetForTest("model", { fg: "ansi256:10", bg: "ansi256:20" }),
        createHydratedWidgetForTest("context", { warningFg: "ansi256:30", dangerBg: "ansi256:40" }),
      ],
    ];

    expect(hasCustomAnsiColors(lines)).toBe(true);
    resetCustomAnsiColors(lines);
    expect(lines[0]?.[0]?.options.fg).toBe("default");
    expect(lines[0]?.[0]?.options.bg).toBe("default");
    expect(lines[0]?.[1]?.options.warningFg).toBe("default");
    expect(lines[0]?.[1]?.options.dangerBg).toBe("default");
    expect(hasCustomAnsiColors(lines)).toBe(false);
  });

  it.each([
    "context",
    "context-length",
    "context-remaining",
    "context-bar",
    "openai-usage-bar",
  ] as const)("preserves the conditional editor field list for %s", (type) => {
    const toggle =
      type === "openai-usage-bar" ? "usageConditionalColors" : "contextConditionalColors";
    const base = ["fg", "bg", "bold", "fgAnsi", "bgAnsi"];
    const conditional = [
      "warningFg",
      "warningBg",
      "warningFgAnsi",
      "warningBgAnsi",
      "dangerFg",
      "dangerBg",
      "dangerFgAnsi",
      "dangerBgAnsi",
    ];
    expect(colorFields(createHydratedWidgetForTest(type)).map(({ id }) => id)).toEqual(base);
    expect(
      colorFields(createHydratedWidgetForTest(type, { [toggle]: true })).map(({ id }) => id),
    ).toEqual([...base, ...conditional]);
    expect(
      colorFields(createHydratedWidgetForTest(type, { [toggle]: false })).map(({ id }) => id),
    ).toEqual(base);
  });

  it("persists Usage warning and danger colors edited through the existing color fields", () => {
    const usage = createHydratedWidgetForTest("openai-usage-bar", {
      usageConditionalColors: true,
      display: "short-only",
    });
    const fields = colorFields(usage);
    const find = (id: ColorOptionField["id"]) => fields.find((field) => field.id === id)!;
    applyColorOptionField(usage, find("warningFg"), 13);
    applyColorDigit(usage, find("warningBgAnsi"), "2");
    applyColorDigit(usage, find("warningBgAnsi"), "5");
    applyColorDigit(usage, find("dangerFgAnsi"), "9");
    applyColorOptionField(usage, find("dangerFgAnsi"), 1);
    applyColorDigit(usage, find("dangerBgAnsi"), "4");
    applyColorDigit(usage, find("dangerBgAnsi"), "8");
    deleteColorDigit(usage, find("dangerBgAnsi"));
    const entry = normalizeConfig({ lines: [[usage.toEntry()]] }).lines[0]![0]!;
    const restored = registry.createWidget(entry.type, entry.options);
    expect(restored.options).toMatchObject({
      usageConditionalColors: true,
      warningFg: "pi:accent",
      warningBg: "ansi256:25",
      dangerFg: "ansi256:10",
      dangerBg: "ansi256:4",
    });
    const context = {
      iconMode: "text" as const,
      minimalist: false,
      colorLevel: "ansi256" as const,
      theme: taggedPiTheme,
    };
    const warningContext = {
      ...context,
      openAIUsage: { "5h": { leftPercent: 25, resetsAtMs: 1 } },
    };
    const dangerContext = { ...context, openAIUsage: { "5h": { leftPercent: 0, resetsAtMs: 1 } } };
    expect(restored.render(warningContext)).toBe(
      "\x1b[48;5;25m<accent>Usage [▓▓▓░░░░░░░]</accent>\x1b[49m",
    );
    expect(restored.render(dangerContext)).toBe(
      "\x1b[48;5;4m\x1b[38;5;10mUsage [░░░░░░░░░░]\x1b[39m\x1b[49m",
    );
  });

  it("documents color editor controls", () => {
    expect(EDIT_COLORS_HINT).toContain("enter toggle");
    expect(EDIT_COLORS_HINT).toContain("type digits for ANSI256");
    expect(EDIT_COLORS_HINT).toContain("backspace delete");
  });
});
