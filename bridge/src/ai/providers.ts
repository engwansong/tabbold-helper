// Minimal model clients. Both return parsed JSON; callers validate it.
// Network: Node's built-in fetch, 30 s timeout, no retries (the UI can retry).

export interface JsonRequest {
  model: string;
  /** Stable instructions + context; cached where the provider supports it. */
  system: string;
  /** The per-call input (untrusted page data goes here, clearly delimited). */
  user: string;
  toolName: string;
  toolDescription: string;
  schema: Record<string, unknown>;
  maxTokens: number;
  /** Cancels the request (the panel's Cancel button). */
  signal?: AbortSignal;
}

export interface JsonResult {
  value: unknown;
  usage?: { input?: number; output?: number; cacheRead?: number };
}

export interface Provider {
  name: string;
  json(req: JsonRequest): Promise<JsonResult>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Node's fetch says only "fetch failed"; the real reason is in err.cause.
 * Turn it into something you can act on.
 */
export function networkError(err: unknown, url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Error {
  let host = url;
  let local = false;
  try {
    const u = new URL(url);
    host = u.host;
    local = /^(localhost|127\.|\[?::1\]?$|0\.0\.0\.0)/.test(u.hostname);
  } catch {
    /* keep url */
  }
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string; name?: string } };
  const code = e?.cause?.code ?? e?.cause?.name ?? e?.name ?? "";
  const detail = e?.cause?.message ?? e?.message ?? String(err);
  const proxyHint = "If your network needs a proxy, re-run scripts/install-host.sh with --proxy http://HOST:PORT.";
  if (/TimeoutError|AbortError|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT/.test(code)) {
    if (local) {
      return new Error(
        `The local model at ${host} didn't answer within ${Math.round(timeoutMs / 1000)} s. It may still be loading or too slow for this prompt: ` +
          `raise ai.timeoutMs, lower ai.batchSize, or keep the model loaded (e.g. OLLAMA_KEEP_ALIVE=30m).`,
      );
    }
    return new Error(`Timed out reaching ${host}. ${proxyHint}`);
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) {
    return new Error(`Couldn't look up ${host} (offline, or DNS is blocked). ${proxyHint}`);
  }
  if (code === "ECONNREFUSED") {
    return new Error(`Nothing is answering at ${host}. Check ai.baseUrl; if it's a local model, make sure it's running (e.g. "ollama serve").`);
  }
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ERR_TLS/.test(code)) {
    return new Error(
      `Couldn't verify ${host}'s certificate (${code}). Work networks often re-sign HTTPS with a company certificate. ` +
        "Re-run scripts/install-host.sh so the helper uses your system's certificates (needs Node 22.15+ or 23.8+).",
    );
  }
  if (/ECONNRESET|EPIPE|UND_ERR_SOCKET/.test(code)) {
    return new Error(`The connection to ${host} was cut (${code}). A proxy or firewall may be blocking it. ${proxyHint}`);
  }
  return new Error(`Couldn't reach ${host}: ${detail}${code ? ` (${code})` : ""}`);
}

export class CancelledError extends Error {
  constructor() {
    super("Cancelled");
  }
}

async function request(url: string, init: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS, cancel?: AbortSignal): Promise<Response> {
  if (cancel?.aborted) throw new CancelledError();
  const signal = cancel ? AbortSignal.any([AbortSignal.timeout(timeoutMs), cancel]) : AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(url, { ...init, signal });
  } catch (err) {
    if (cancel?.aborted) throw new CancelledError();
    throw networkError(err, url, timeoutMs);
  }
}

/** Cheap connectivity + key check: lists models, costs no tokens. */
export async function probe(
  kind: "anthropic" | "openai-compatible",
  baseUrl: string,
  apiKey?: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cancel?: AbortSignal,
): Promise<string> {
  const url =
    kind === "anthropic" ? `${baseUrl.replace(/\/$/, "")}/v1/models?limit=1` : `${baseUrl.replace(/\/$/, "")}/models`;
  const headers: Record<string, string> =
    kind === "anthropic"
      ? { "x-api-key": apiKey ?? "", "anthropic-version": "2023-06-01" }
      : apiKey
        ? { authorization: `Bearer ${apiKey}` }
        : {};
  const res = await request(url, { method: "GET", headers }, Math.min(timeoutMs, 15_000), cancel);
  if (res.status === 401 || res.status === 403) throw new Error(`Reached ${new URL(url).host}, but the API key was rejected (${res.status}).`);
  if (!res.ok) throw new Error(`Reached ${new URL(url).host}, but it answered ${res.status}.`);
  return `Connected to ${new URL(url).host}; the API key works.`;
}

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs = DEFAULT_TIMEOUT_MS, cancel?: AbortSignal): Promise<any> {
  const res = await request(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    timeoutMs,
    cancel,
  );
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      msg = j?.error?.message ?? j?.message ?? msg;
    } catch {
      /* keep text */
    }
    throw new Error(`AI provider returned ${res.status}: ${msg}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("AI provider returned invalid JSON");
  }
}

/** Anthropic Messages API with a forced tool call for structured output. */
export function anthropic(apiKey: string, baseUrl = "https://api.anthropic.com", timeoutMs = DEFAULT_TIMEOUT_MS): Provider {
  return {
    name: "anthropic",
    async json(req) {
      const data = await post(
        `${baseUrl.replace(/\/$/, "")}/v1/messages`,
        { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        {
          model: req.model,
          max_tokens: req.maxTokens,
          system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: req.user }],
          tools: [{ name: req.toolName, description: req.toolDescription, input_schema: req.schema }],
          tool_choice: { type: "tool", name: req.toolName },
        },
        timeoutMs,
        req.signal,
      );
      const block = (data?.content ?? []).find((b: any) => b?.type === "tool_use" && b?.name === req.toolName);
      if (!block) throw new Error("AI response had no structured result");
      return {
        value: block.input,
        usage: {
          input: data?.usage?.input_tokens,
          output: data?.usage?.output_tokens,
          cacheRead: data?.usage?.cache_read_input_tokens,
        },
      };
    },
  };
}

/** OpenAI-compatible Chat Completions (OpenRouter, Ollama, LM Studio, …) in JSON mode. */
export function openaiCompatible(baseUrl: string, apiKey?: string, timeoutMs = DEFAULT_TIMEOUT_MS): Provider {
  return {
    name: "openai-compatible",
    async json(req) {
      const data = await post(
        `${baseUrl.replace(/\/$/, "")}/chat/completions`,
        apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        {
          model: req.model,
          max_tokens: req.maxTokens,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: `${req.system}\n\nRespond with only a JSON object matching this JSON Schema (${req.toolDescription}):\n${JSON.stringify(req.schema)}`,
            },
            { role: "user", content: req.user },
          ],
        },
        timeoutMs,
        req.signal,
      );
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("AI response had no content");
      const json = content.replace(/^```(?:json)?\s*|\s*```$/g, "");
      try {
        return {
          value: JSON.parse(json),
          usage: { input: data?.usage?.prompt_tokens, output: data?.usage?.completion_tokens },
        };
      } catch {
        throw new Error("AI response was not valid JSON");
      }
    },
  };
}
