import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_FILE = path.join(__dirname, "ai-models.env");
const SUPPORTED_PROVIDERS = new Set(["openai", "openai-compatible", "deepseek", "qwen", "moonshot", "zhipu", "anthropic", "gemini"]);
let cachedConfig = null;

function stripQuotes(value) {
  const trimmed = String(value ?? "").trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
}

function parseEnvText(text) {
  const values = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const assignment = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = assignment.indexOf("=");
    if (separator < 1) continue;
    const key = assignment.slice(0, separator).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    values[key] = stripQuotes(assignment.slice(separator + 1));
  }
  return values;
}

function boolValue(value, fallback = true) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function integerValue(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeModel(index, values, warnings) {
  const prefix = `AI_MODEL_${index}_`;
  const read = (suffix, fallback = "") => values[`${prefix}${suffix}`] ?? fallback;
  const id = read("ID");
  const name = read("NAME", id);
  const provider = read("PROVIDER", "openai-compatible").toLowerCase();
  const baseUrl = read("BASE_URL").replace(/\/$/, "");
  const model = read("MODEL", id);
  const apiKeyEnv = read("API_KEY_ENV");
  const validApiKeyEnv = /^[A-Z][A-Z0-9_]*$/.test(apiKeyEnv);
  // 兼容旧配置误把真实 Key 写入 API_KEY_ENV，同时不把它当作环境变量名返回。
  const apiKey = validApiKeyEnv ? (process.env[apiKeyEnv] || read("API_KEY")) : (apiKeyEnv || read("API_KEY"));
  const item = {
    index, id, name, provider, baseUrl, model, apiKey, apiKeyEnv: validApiKeyEnv ? apiKeyEnv : "",
    enabled: boolValue(read("ENABLED"), true),
    timeoutMs: integerValue(read("TIMEOUT_MS"), 30_000), maxTokens: integerValue(read("MAX_TOKENS"), 2_000),
  };
  if (id && apiKeyEnv && !validApiKeyEnv) warnings.push(`${id}: API_KEY_ENV 不是合法环境变量名，已按直接 API Key 兼容读取；建议迁移到 API_KEY_ENV=OPENROUTER_API_KEY`);
  if (!id) warnings.push(`AI_MODEL_${index}_ID 未填写，已跳过该模型`);
  if (id && !SUPPORTED_PROVIDERS.has(provider)) warnings.push(`${id}: provider=${provider} 暂不支持，调用时会失败`);
  if (id && !baseUrl) warnings.push(`${id}: BASE_URL 未填写`);
  if (id && !model) warnings.push(`${id}: MODEL 未填写`);
  return item;
}

function buildConfig(values, filePath, exists) {
  const indexes = [...new Set(Object.keys(values).map((key) => key.match(/^AI_MODEL_(\d+)_/)).filter(Boolean).map((match) => Number(match[1])))].sort((a, b) => a - b);
  const warnings = [];
  const models = indexes.map((index) => normalizeModel(index, values, warnings)).filter((model) => model.id);
  return { filePath, exists, models, warnings, loadedAt: new Date().toISOString() };
}

export async function loadAiModelsConfig(filePath = process.env.AI_MODELS_FILE || DEFAULT_CONFIG_FILE, options = {}) {
  const resolvedPath = path.resolve(filePath);
  if (!options.reload && cachedConfig?.filePath === resolvedPath) return cachedConfig;
  try {
    const text = await readFile(resolvedPath, "utf8");
    cachedConfig = buildConfig(parseEnvText(text), resolvedPath, true);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    cachedConfig = buildConfig({}, resolvedPath, false);
    cachedConfig.warnings.push(`未找到 ${resolvedPath}，当前不会调用第三方模型`);
  }
  return cachedConfig;
}

export function getPublicAiModelConfigs(config) {
  return config.models.map((model) => ({
    id: model.id, name: model.name, provider: model.provider, model: model.model,
    baseUrl: model.baseUrl, enabled: model.enabled,
    configured: Boolean(model.apiKey), apiKeyEnv: model.apiKeyEnv || null,
  }));
}

export async function getAiModelConfig(modelId, options = {}) {
  const config = await loadAiModelsConfig(options.filePath, options);
  const model = config.models.find((item) => item.id === modelId);
  if (!model) throw Object.assign(new Error(`未找到模型配置：${modelId}`), { code: "AI_MODEL_NOT_FOUND", status: 404 });
  if (!model.enabled) throw Object.assign(new Error(`模型已禁用：${modelId}`), { code: "AI_MODEL_DISABLED", status: 409 });
  return model;
}

function providerUrl(model, suffix) {
  return `${model.baseUrl}${suffix}`;
}

function requestHeaders(model) {
  const headers = { Accept: "application/json", "Content-Type": "application/json" };
  if (model.provider === "anthropic") {
    headers["x-api-key"] = model.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (model.provider !== "gemini") {
    headers.Authorization = `Bearer ${model.apiKey}`;
  }
  return headers;
}

function openAiMessages(input) {
  const messages = [];
  if (input.systemPrompt) messages.push({ role: "system", content: input.systemPrompt });
  messages.push(...(Array.isArray(input.messages) ? input.messages : []));
  return messages;
}

function extractText(provider, payload) {
  if (provider === "anthropic") return payload.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") || "";
  if (provider === "gemini") return payload.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
  return payload.choices?.[0]?.message?.content || "";
}

export async function requestAiModel(modelId, input, options = {}) {
  const model = await getAiModelConfig(modelId, options);
  if (!model.apiKey) throw Object.assign(new Error(`模型 ${modelId} 未配置 API Key`), { code: "AI_API_KEY_MISSING", status: 503 });
  const timeoutMs = options.timeoutMs || model.timeoutMs;
  let url;
  let body;
  if (model.provider === "anthropic") {
    url = providerUrl(model, "/messages");
    body = { model: model.model, max_tokens: options.maxTokens || model.maxTokens, system: input.systemPrompt || undefined, messages: Array.isArray(input.messages) ? input.messages : [] };
  } else if (model.provider === "gemini") {
    url = `${providerUrl(model, `/models/${encodeURIComponent(model.model)}:generateContent`)}?key=${encodeURIComponent(model.apiKey)}`;
    const contents = (Array.isArray(input.messages) ? input.messages : []).map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: String(message.content || "") }] }));
    if (input.systemPrompt) contents.unshift({ role: "user", parts: [{ text: input.systemPrompt }] });
    body = { contents, generationConfig: { temperature: options.temperature ?? 0.2, maxOutputTokens: options.maxTokens || model.maxTokens } };
  } else {
    url = providerUrl(model, "/chat/completions");
    body = { model: model.model, messages: openAiMessages(input), temperature: options.temperature ?? 0.2, max_tokens: options.maxTokens || model.maxTokens };
    if (input.responseFormat) body.response_format = input.responseFormat;
  }
  let response;
  try {
    response = await fetch(url, { method: "POST", headers: requestHeaders(model), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw Object.assign(new Error(`模型 ${modelId} 请求失败`), { code: error.name === "TimeoutError" ? "AI_REQUEST_TIMEOUT" : "AI_REQUEST_FAILED", status: 502, cause: error });
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(`模型 ${modelId} 返回 HTTP ${response.status}`), { code: "AI_PROVIDER_ERROR", status: 502, details: { status: response.status, provider: model.provider } });
  return { model: { id: model.id, provider: model.provider, model: model.model }, text: extractText(model.provider, payload), payload };
}

export function clearAiModelsConfigCache() {
  cachedConfig = null;
}
