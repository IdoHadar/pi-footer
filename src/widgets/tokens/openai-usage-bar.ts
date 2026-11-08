import { defineWidget } from "../types.js";

const MODES = {
  default: { label: "Default bar", width: 32, filled: "█", bracketed: true, showUsage: true },
  short: { label: "Short bar", width: 10, filled: "▓", bracketed: false, showUsage: true },
  "short-only": {
    label: "Short bar only",
    width: 10,
    filled: "▓",
    bracketed: false,
    showUsage: false,
  },
  medium: { label: "Medium bar", width: 16, filled: "█", bracketed: true, showUsage: true },
} as const;

export const OpenAIUsageBarWidget = defineWidget({
  type: "openai-usage-bar",
  label: "OpenAI Usage Bar",
  category: "Tokens",
  description: "OpenAI subscription allowance left",
  dependencies: ["openAIUsage"],
  baseOptions: ["raw", "icon"],
  properties: [
    {
      id: "usageWindow",
      label: "Window",
      kind: "choice",
      description: "Subscription allowance window",
      default: "auto",
      options: {
        choices: [
          { id: "auto", label: "Available window", list: "Available window" },
          { id: "5h", label: "5 hours", list: "5h" },
          { id: "weekly", label: "Weekly", list: "weekly" },
        ],
        showInWidgets: true,
        listProperty: "window",
      },
    },
    {
      id: "display",
      label: "Display",
      kind: "choice",
      description: "Allowance bar display mode",
      default: "default",
      options: {
        choices: (Object.keys(MODES) as (keyof typeof MODES)[]).map((id) => ({
          id,
          label: MODES[id].label,
          list: MODES[id].label,
        })),
        showInWidgets: true,
        listProperty: "display",
      },
    },
  ],
  icons: { emoji: "OpenAI", nerd: "OpenAI", text: "OpenAI" },
  defaultStyle: { fg: "blue", bg: "default", bold: false },
  render({ ctx, options, renderWidget }) {
    const usageWindow =
      options.usageWindow === "auto"
        ? ctx.openAIUsage?.["5h"]
          ? "5h"
          : "weekly"
        : options.usageWindow;
    const window = ctx.openAIUsage?.[usageWindow];
    if (!window) return undefined;
    const mode = MODES[options.display];
    const filled = Math.round((window.leftPercent / 100) * mode.width);
    const meter = `${mode.filled.repeat(filled)}${"░".repeat(mode.width - filled)}`;
    const bar = mode.bracketed ? `[${meter}]` : meter;
    return renderWidget(
      mode.showUsage ? `${bar} ${usageWindow} ${Math.round(window.leftPercent)}% left` : bar,
    );
  },
});
