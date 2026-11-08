import { normalizeColor } from "../../colors.js";
import { defineWidget } from "../types.js";
import { colorPair } from "../utils/colors.js";

const MODES = {
  default: { label: "Default bar", width: 32, filled: "█", bracketed: true, showUsage: true },
  short: { label: "Short bar", width: 10, filled: "▓", bracketed: true, showUsage: true },
  "short-only": {
    label: "Short bar only",
    width: 10,
    filled: "▓",
    bracketed: true,
    showUsage: false,
  },
  medium: { label: "Medium bar", width: 16, filled: "█", bracketed: true, showUsage: true },
} as const;

function formatResetCountdown(resetsAtMs: number, nowMs: number): string {
  const remainingMs = Math.max(0, resetsAtMs - nowMs);
  const hours = Math.floor(remainingMs / 3_600_000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours >= 1) return `${hours}h`;
  const minutes = Math.floor(remainingMs / 60_000);
  if (minutes >= 1) return `${minutes}m`;
  return remainingMs > 0 ? "<1m" : "0m";
}

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
    {
      id: "showResetCountdown",
      label: "Show reset countdown",
      kind: "boolean",
      description: "Show time until the selected subscription allowance resets",
      default: false,
      options: {
        label: "reset-countdown",
        showInWidgets: true,
        showInColors: false,
        listProperty: "",
      },
    },
    {
      id: "usageConditionalColors",
      label: "Conditional colors",
      kind: "boolean",
      description: "Use warning/danger colors based on remaining subscription allowance",
      default: false,
      options: {
        label: "with-colors",
        showInWidgets: true,
        showInColors: true,
        listProperty: "",
      },
    },
    {
      id: "usageWarningPercent",
      label: "Warning at remaining %",
      kind: "number",
      description: "Use warning colors at or below this remaining allowance percentage",
      default: 30,
      showWhen: { property: "usageConditionalColors", equals: true },
      options: { min: 0, max: 100, showInWidgets: false, showInColors: false },
    },
    {
      id: "usageDangerPercent",
      label: "Danger at remaining %",
      kind: "number",
      description: "Use danger colors at or below this remaining allowance percentage",
      default: 10,
      showWhen: { property: "usageConditionalColors", equals: true },
      options: { min: 0, max: 100, showInWidgets: false, showInColors: false },
    },
    {
      id: "warningFg",
      label: "Warning foreground",
      kind: "text",
      description: "Warning foreground",
      default: "yellow",
      showWhen: { property: "usageConditionalColors", equals: true },
      options: { showInFields: false, showInWidgets: false, showInColors: false },
    },
    {
      id: "warningBg",
      label: "Warning background",
      kind: "text",
      description: "Warning background",
      default: "default",
      showWhen: { property: "usageConditionalColors", equals: true },
      options: { showInFields: false, showInWidgets: false, showInColors: false },
    },
    {
      id: "dangerFg",
      label: "Danger foreground",
      kind: "text",
      description: "Danger foreground",
      default: "red",
      showWhen: { property: "usageConditionalColors", equals: true },
      options: { showInFields: false, showInWidgets: false, showInColors: false },
    },
    {
      id: "dangerBg",
      label: "Danger background",
      kind: "text",
      description: "Danger background",
      default: "default",
      showWhen: { property: "usageConditionalColors", equals: true },
      options: { showInFields: false, showInWidgets: false, showInColors: false },
    },
  ],
  icons: { emoji: "Usage", nerd: "Usage", text: "Usage" },
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
    let colors = colorPair(options.fg, options.bg);
    if (options.usageConditionalColors) {
      if (window.leftPercent <= options.usageDangerPercent) {
        colors = colorPair(
          normalizeColor(options.dangerFg) ?? options.fg,
          normalizeColor(options.dangerBg) ?? options.bg,
        );
      } else if (window.leftPercent <= options.usageWarningPercent) {
        colors = colorPair(
          normalizeColor(options.warningFg) ?? options.fg,
          normalizeColor(options.warningBg) ?? options.bg,
        );
      }
    }
    const countdown =
      options.showResetCountdown && mode.showUsage
        ? ` ${formatResetCountdown(window.resetsAtMs, Date.now())}`
        : "";
    return renderWidget(
      mode.showUsage ? `${bar} ${Math.round(window.leftPercent)}%${countdown}` : bar,
      colors,
    );
  },
});
