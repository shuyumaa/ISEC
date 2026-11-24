import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createGateway, generateText, type LanguageModel } from "ai";
import { actor } from "../actor";
import { readDoc, transaction } from "../db";
import { FormError, text } from "../forms";
import { open, seal } from "../secret";

/*
 * The admin's own AI provider ("bring your own key"). The API key is stored
 * encrypted and never sent back to the browser: the settings page only shows
 * its last four characters.
 */

export const PROVIDERS = {
  gateway: { label: "Vercel AI Gateway", hint: "One key for OpenAI, Anthropic, Google and more. Models look like anthropic/… or openai/…" },
  openai: { label: "OpenAI", hint: "Key from platform.openai.com" },
  anthropic: { label: "Anthropic", hint: "Key from console.anthropic.com" },
  google: { label: "Google Gemini", hint: "Key from aistudio.google.com" },
  compatible: { label: "OpenAI-compatible", hint: "Any server that speaks the OpenAI API (OpenRouter, DeepSeek, a local Ollama or LM Studio…)" },
} as const;
export type ProviderId = keyof typeof PROVIDERS;

export interface AiConfig {
  provider: ProviderId;
  model: string;
  /** Only for "compatible". */
  baseURL?: string;
  keySealed?: string;
  /** Last 4 characters, to recognise the key without revealing it. */
  keyHint?: string;
  updatedAt: string;
  updatedBy: string;
}

export const getAiConfig = () => readDoc<AiConfig>("ai", "config");

/** Configured and the stored key can still be decrypted. */
export function aiReady(): boolean {
  const c = getAiConfig();
  return !!c?.model && (!!c.keySealed ? open(c.keySealed) !== undefined : c.provider === "compatible");
}

const isProvider = (v: string): v is ProviderId => v in PROVIDERS;

/** Plain http is only allowed for a model server on this machine (Ollama, LM Studio). */
function checkBaseURL(raw: string) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FormError("Base URL must be a full URL, e.g. https://openrouter.ai/api/v1", "baseURL");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new FormError("Base URL must use https:// (http:// only for localhost).", "baseURL");
  if (u.username || u.password) throw new FormError("Put the key in the API key field, not in the URL.", "baseURL");
  return u.toString().replace(/\/$/, "");
}

export function saveAiConfig(form: FormData): AiConfig {
  const before = getAiConfig();
  const provider = text(form, "provider", { required: true, label: "Provider" });
  if (!isProvider(provider)) throw new FormError("Choose a provider from the list.", "provider");
  const model = text(form, "model", { required: true, max: 120, label: "Model" });
  const baseURL = provider === "compatible" ? checkBaseURL(text(form, "baseURL", { required: true, max: 300, label: "Base URL" })) : undefined;
  const newKey = String(form.get("apiKey") ?? "").trim();
  if (newKey && (newKey.length < 8 || newKey.length > 500 || /\s/.test(newKey))) throw new FormError("That doesn't look like an API key.", "apiKey");
  // Keep the saved key unless a new one is typed or the provider changed.
  const keepKey = !newKey && before?.provider === provider && !form.get("removeKey");
  const keySealed = newKey ? seal(newKey) : keepKey ? before?.keySealed : undefined;
  if (!keySealed && provider !== "compatible") throw new FormError("Paste the API key for this provider.", "apiKey");
  const config: AiConfig = {
    provider,
    model,
    baseURL,
    keySealed,
    keyHint: newKey ? newKey.slice(-4) : keepKey ? before?.keyHint : undefined,
    updatedAt: new Date().toISOString(),
    updatedBy: actor(),
  };
  transaction((tx) => tx.put("ai", "config", config), actor(), newKey ? "set AI provider and key" : "edit AI provider");
  return config;
}

export function clearAiConfig() {
  transaction((tx) => tx.remove("ai", "config"), actor(), "remove AI provider");
}

function apiKey(c: AiConfig) {
  if (!c.keySealed) return undefined;
  const k = open(c.keySealed);
  if (k === undefined) throw new FormError("The saved API key can't be read any more (the server secret changed). Paste it again in AI settings.");
  return k;
}

/** The configured language model, or a FormError the admin can act on. */
export function languageModel(c = getAiConfig()): LanguageModel {
  if (!c?.model) throw new FormError("Set up an AI provider first (Admin → AI assistant → Settings).");
  const key = apiKey(c);
  switch (c.provider) {
    case "gateway":
      return createGateway({ apiKey: key })(c.model);
    case "openai":
      return createOpenAI({ apiKey: key })(c.model);
    case "anthropic":
      return createAnthropic({ apiKey: key })(c.model);
    case "google":
      return createGoogle({ apiKey: key })(c.model);
    case "compatible":
      return createOpenAICompatible({ name: "custom", baseURL: c.baseURL!, apiKey: key, supportsStructuredOutputs: true })(c.model);
  }
}

let modelCache: { at: number; for: string; ids: string[] } | undefined;

/** Model ids the provider offers with this key (for the settings page's suggestions), cached 5 minutes. */
export async function listModels(c = getAiConfig()): Promise<string[]> {
  if (!c) return [];
  if (modelCache && modelCache.for === c.updatedAt && Date.now() - modelCache.at < 300_000) return modelCache.ids;
  const ids = await fetchModels(c);
  modelCache = { at: Date.now(), for: c.updatedAt, ids };
  return ids;
}

async function fetchModels(c: AiConfig): Promise<string[]> {
  const key = apiKey(c);
  const get = async (url: string, headers: Record<string, string>) => {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new FormError(`The provider refused the request (HTTP ${r.status}). Check the key.`);
    return (await r.json()) as Record<string, unknown>;
  };
  let ids: string[] = [];
  switch (c.provider) {
    case "gateway":
      ids = ((await get("https://ai-gateway.vercel.sh/v1/models", {})).data as { id: string; type?: string }[]).filter((m) => m.type === "language").map((m) => m.id);
      break;
    case "openai":
      ids = ((await get("https://api.openai.com/v1/models", { Authorization: `Bearer ${key}` })).data as { id: string }[]).map((m) => m.id);
      break;
    case "anthropic":
      ids = ((await get("https://api.anthropic.com/v1/models?limit=100", { "x-api-key": key!, "anthropic-version": "2023-06-01" })).data as { id: string }[]).map((m) => m.id);
      break;
    case "google":
      ids = ((await get("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { "x-goog-api-key": key! })).models as { name: string; supportedGenerationMethods?: string[] }[])
        .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
        .map((m) => m.name.replace(/^models\//, ""));
      break;
    case "compatible":
      ids = ((await get(`${c.baseURL}/models`, key ? { Authorization: `Bearer ${key}` } : {})).data as { id: string }[]).map((m) => m.id);
      break;
  }
  return [...new Set(ids)].sort();
}

/** A tiny round trip to prove the key and model work. */
export async function testAi(): Promise<string> {
  const { text: reply } = await generateText({
    model: languageModel(),
    prompt: "Reply with the single word: ready",
    maxOutputTokens: 16,
    abortSignal: AbortSignal.timeout(30_000),
  });
  return reply.trim().slice(0, 60) || "(empty reply)";
}
