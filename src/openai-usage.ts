import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { isRecord, type StatuslineConfig } from "./types.js";

export type UsageWindow = "5h" | "weekly";
export type RemainingWindow = Readonly<{ leftPercent: number; resetsAtMs: number }>;
export type OpenAIUsage = Readonly<Partial<Record<UsageWindow, RemainingWindow>>>;

type AccountAuth = { accountId: string; bearer: string };
type Binding = {
  ctx: ExtensionContext;
  changed: () => void;
  accountId?: string | undefined;
  pollTimer?: ReturnType<typeof setTimeout>;
  expiryTimer?: ReturnType<typeof setTimeout>;
  request?: AbortController | undefined;
  requestTimer?: ReturnType<typeof setTimeout>;
};

const WINDOW_SECONDS = { "5h": 18_000, weekly: 604_800 } as const;
const FRESHNESS_MS = 120_000;

export function hasEnabledOpenAIUsageWidget(config: StatuslineConfig): boolean {
  return config.lines.some((line) =>
    line.some((widget) => widget.enabled && widget.type === "openai-usage-bar"),
  );
}

export class OpenAIUsageMonitor {
  private binding: Binding | undefined;
  private data: { usage: OpenAIUsage; receivedAt: number } | undefined;

  bind(input: { enabled: boolean; ctx: ExtensionContext; changed: () => void }): () => void {
    this.stop();
    if (!input.enabled || !input.ctx.hasUI) return () => {};
    const binding: Binding = { ctx: input.ctx, changed: input.changed };
    this.binding = binding;
    void this.poll(binding);
    return () => {
      if (this.binding === binding) this.stop();
    };
  }

  snapshot(): OpenAIUsage | undefined {
    if (!this.data || Date.now() >= this.data.receivedAt + FRESHNESS_MS) return undefined;
    const usage: Partial<Record<UsageWindow, RemainingWindow>> = {};
    for (const window of ["5h", "weekly"] as const) {
      const value = this.data.usage[window];
      if (value && value.resetsAtMs > Date.now()) usage[window] = value;
    }
    return Object.keys(usage).length ? usage : undefined;
  }

  stop(): void {
    const binding = this.binding;
    this.binding = undefined;
    if (binding) {
      clearTimeout(binding.pollTimer);
      clearTimeout(binding.expiryTimer);
      clearTimeout(binding.requestTimer);
      binding.request?.abort();
    }
    const hadData = this.data !== undefined;
    this.data = undefined;
    if (hadData) binding?.changed();
  }

  private publish(binding: Binding, usage: OpenAIUsage | undefined, receivedAt = Date.now()): void {
    clearTimeout(binding.expiryTimer);
    const previous = this.data?.usage;
    this.data = usage ? { usage, receivedAt } : undefined;
    if (JSON.stringify(previous) !== JSON.stringify(usage)) binding.changed();
    if (usage) {
      const expiresAt = Math.min(
        receivedAt + FRESHNESS_MS,
        ...Object.values(usage).map((window) => window.resetsAtMs),
      );
      binding.expiryTimer = setTimeout(() => {
        if (this.binding !== binding) return;
        this.publish(binding, this.snapshot(), receivedAt);
      }, expiresAt - Date.now());
    }
  }

  private async poll(binding: Binding): Promise<void> {
    try {
      const account = await resolveAccount(binding.ctx);
      if (this.binding !== binding) return;
      if (binding.accountId !== account?.accountId || !account) this.publish(binding, undefined);
      binding.accountId = account?.accountId;
      if (account) {
        const request = new AbortController();
        binding.request = request;
        const timeout = setTimeout(() => {
          request.abort();
          if (this.binding === binding) this.publish(binding, undefined);
        }, 10_000);
        binding.requestTimer = timeout;
        try {
          const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
            headers: {
              Authorization: `Bearer ${account.bearer}`,
              "ChatGPT-Account-Id": account.accountId,
              Accept: "application/json",
            },
            redirect: "error",
            signal: request.signal,
          });
          const usage = response.ok ? parseUsage(await response.json()) : undefined;
          if (
            this.binding === binding &&
            binding.accountId === account.accountId &&
            !request.signal.aborted
          ) {
            this.publish(binding, usage);
          } else if (this.binding === binding && request.signal.aborted) {
            this.publish(binding, undefined);
          }
        } finally {
          clearTimeout(timeout);
          if (binding.request === request) binding.request = undefined;
        }
      }
    } catch {
      if (this.binding === binding) this.publish(binding, undefined);
    } finally {
      if (this.binding === binding) {
        binding.pollTimer = setTimeout(() => void this.poll(binding), 60_000);
      }
    }
  }
}

async function resolveAccount(ctx: ExtensionContext): Promise<AccountAuth | undefined> {
  if (ctx.model?.provider !== "openai-codex" || !ctx.modelRegistry.isUsingOAuth(ctx.model)) {
    return undefined;
  }
  const result = await ctx.modelRegistry.getProviderAuth("openai-codex");
  const bearer = result?.auth?.apiKey;
  if (typeof bearer !== "string" || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(bearer)) return undefined;
  try {
    const [, encodedPayload = ""] = bearer.split(".");
    const payload: unknown = JSON.parse(Buffer.from(encodedPayload, "base64url").toString());
    if (!isRecord(payload)) return undefined;
    const auth = payload["https://api.openai.com/auth"];
    if (!isRecord(auth)) return undefined;
    const accountId = auth.chatgpt_account_id;
    if (typeof accountId !== "string" || !/^[\x21-\x7e]+$/.test(accountId)) return undefined;
    return { accountId, bearer };
  } catch {
    return undefined;
  }
}

function parseUsage(body: unknown): OpenAIUsage | undefined {
  if (!isRecord(body) || !isRecord(body.rate_limit)) return undefined;
  const candidates = [body.rate_limit.primary_window, body.rate_limit.secondary_window];
  const usage: Partial<Record<UsageWindow, RemainingWindow>> = {};
  for (const window of ["5h", "weekly"] as const) {
    const matches = candidates.filter(
      (candidate) =>
        isRecord(candidate) && candidate.limit_window_seconds === WINDOW_SECONDS[window],
    );
    if (matches.length !== 1) continue;
    const candidate = matches[0];
    if (!isRecord(candidate)) continue;
    const { used_percent: used, reset_at: reset } = candidate;
    if (
      typeof used !== "number" ||
      !Number.isFinite(used) ||
      used < 0 ||
      used > 100 ||
      typeof reset !== "number" ||
      !Number.isFinite(reset) ||
      !Number.isFinite(new Date(reset * 1000).getTime()) ||
      reset * 1000 <= Date.now()
    ) {
      continue;
    }
    usage[window] = { leftPercent: 100 - used, resetsAtMs: reset * 1000 };
  }
  return Object.keys(usage).length ? usage : undefined;
}
