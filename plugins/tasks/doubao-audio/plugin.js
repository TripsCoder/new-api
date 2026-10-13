// Source: https://docs.volcengine.com/docs/DoubaoVoice/audio-generation-http?lang=zh
// Verified 2026-10-11. Synchronous generation, original_duration <= 120 seconds.
// No model-list endpoint is documented. meta.models is a compatibility declaration.
export const meta = {
  apiVersion: 1,
  key: "doubao-audio",
  name: "Doubao Audio",
  icon: "Doubao.Color",
  version: "1.0.0",
  author: { name: "Local integration" },
  website: "https://docs.volcengine.com/docs/DoubaoVoice/audio-generation-http?lang=zh",
  description: {
    en: "Seed Audio generation; configure models manually, live model discovery is unavailable",
    zh: "豆包音频生成；请手动配置模型，暂无实时模型列表接口",
  },
  baseUrl: "https://openspeech.bytedance.com",
  models: ["seed-audio-1.0"],
  fetchMode: "per_task",
  requiredCapabilities: ["large-submit-json@1"],
  usageSchema: {
    seconds: { type: "number", unit: "second", description: { en: "Audio generation unit price", zh: "音频生成单价" } },
  },
  usageExamples: [
    { label: "10s", facts: { seconds: 10 } },
    { label: "120s", facts: { seconds: 120 } },
  ],
  routes: [
    { method: "POST", path: "/doubao/audio/generations", type: "submit", decode: "decodeSubmit", render: "renderTask" },
    { method: "GET", path: "/doubao/audio/generations/:task_id", type: "query", taskIdParam: "task_id", render: "renderTask" },
  ],
  protocols: [{ name: "openai_responses", supports: ["sync", "background"] }],
};

const FORMATS = {
  wav: { rates: [8000, 16000, 24000, 32000, 40000, 44100, 48000], mime: "audio/wav" },
  mp3: { rates: [8000, 16000, 24000, 32000, 44100, 48000], mime: "audio/mpeg" },
  pcm: { rates: [8000, 16000, 24000, 32000, 40000, 44100, 48000], mime: "application/octet-stream" },
  ogg_opus: { rates: [48000], mime: "audio/ogg" },
};

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(name + " must be an object");
  return value;
}

function text(value, name, max) {
  if (typeof value !== "string" || !value.trim() || Array.from(value).length > max)
    throw new Error(name + " must be non-empty and at most " + max + " characters");
  return value;
}

function onlyKeys(value, keys, name) {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(name + " contains unsupported field " + key);
}

function mediaURL(value, name) {
  text(value, name, 8192);
  if (!/^https:\/\/[^\s/@?#]+(?:[/?#]|$)/i.test(value) || /[\\<>"]/.test(value) || Array.from(value).some((char) => char.charCodeAt(0) <= 32))
    throw new Error(name + " must be an HTTPS URL without credentials");
  return value;
}

function payload(input, model) {
  const req = object(input, "request");
  onlyKeys(req, ["model", "text_prompt", "references", "audio_config", "watermark"], "request");
  const result = { model: model, text_prompt: text(req.text_prompt, "text_prompt", 3000) };
  if (req.references !== undefined) {
    if (!Array.isArray(req.references) || req.references.length > 3) throw new Error("references must be an array with at most 3 entries");
    let audioCount = 0;
    let imageCount = 0;
    result.references = req.references.map(function (ref) {
      object(ref, "reference");
      const keys = Object.keys(ref);
      const choices = ["speaker", "audio_data", "audio_url", "image_data", "image_url"];
      if (keys.length !== 1 || !choices.includes(keys[0]))
        throw new Error("each reference must contain exactly one speaker, audio_data, audio_url, image_data or image_url");
      const key = keys[0];
      const value = ref[key];
      if (key.startsWith("image_")) imageCount++;
      else audioCount++;
      if (key.endsWith("_url")) mediaURL(value, key);
      else if (key.endsWith("_data")) {
        // 10 MiB decoded maximum. URL reference byte/duration checks remain upstream-owned.
        const maxEncoded = 4 * Math.ceil((10 * 1024 * 1024) / 3);
        if (typeof value !== "string" || value.length === 0 || value.length > maxEncoded || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
          throw new Error(key + " must be Base64 within 10 MiB");
        const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
        if ((value.length / 4) * 3 - padding > 10 * 1024 * 1024) throw new Error(key + " exceeds 10 MiB");
      } else text(value, key, 256);
      return { [key]: value };
    });
    if (imageCount > 1 || (imageCount && audioCount)) throw new Error("at most one image is allowed; image and audio references cannot be mixed");
  }
  if (req.audio_config !== undefined) {
    const config = object(req.audio_config, "audio_config");
    onlyKeys(config, ["format", "sample_rate", "pitch_rate", "speech_rate", "loudness_rate", "enable_subtitle"], "audio_config");
    const format = config.format === undefined ? "wav" : config.format;
    if (!Object.prototype.hasOwnProperty.call(FORMATS, format)) throw new Error("unsupported audio format");
    if (config.sample_rate !== undefined && !FORMATS[format].rates.includes(config.sample_rate)) throw new Error("sample_rate is not supported for " + format);
    for (const key of ["pitch_rate", "speech_rate", "loudness_rate"]) {
      const v = config[key];
      const min = key === "pitch_rate" ? -12 : -50;
      const max = key === "pitch_rate" ? 12 : 100;
      if (v !== undefined && (!Number.isInteger(v) || v < min || v > max)) throw new Error(key + " is outside its integer range");
    }
    if (config.enable_subtitle !== undefined && typeof config.enable_subtitle !== "boolean") throw new Error("enable_subtitle must be boolean");
    result.audio_config = Object.assign({}, config);
  }
  if (req.watermark !== undefined) {
    const watermark = object(req.watermark, "watermark");
    onlyKeys(watermark, ["aigc_watermark", "aigc_metadata"], "watermark");
    if (watermark.aigc_watermark !== undefined && typeof watermark.aigc_watermark !== "boolean") throw new Error("aigc_watermark must be boolean");
    result.watermark = Object.assign({}, watermark);
    if (watermark.aigc_metadata !== undefined) {
      const metadata = object(watermark.aigc_metadata, "aigc_metadata");
      onlyKeys(metadata, ["enable", "content_producer", "produce_id", "content_propagator", "propagate_id"], "aigc_metadata");
      for (const key of Object.keys(metadata)) {
        if (key === "enable") {
          if (typeof metadata[key] !== "boolean") throw new Error("aigc_metadata.enable must be boolean");
        } else text(metadata[key], key, 1024);
      }
      result.watermark.aigc_metadata = Object.assign({}, metadata);
    }
  }
  return result;
}

function originalSeconds(data) {
  const value = data && data.original_duration;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 120)
    throw new Error("original_duration must be a number greater than 0 and at most 120 seconds");
  return value;
}

export function buildSubmitRequest(ctx) {
  const model = ctx.upstreamModel || ctx.model;
  if (model !== "seed-audio-1.0") throw new Error("unsupported upstream model");
  const base = String(ctx.baseUrl || meta.baseUrl).replace(/\/+$/, "");
  mediaURL(base, "baseUrl");
  if (/[?#]/.test(base)) throw new Error("baseUrl cannot contain query or fragment");
  if (typeof ctx.apiKey !== "string" || !ctx.apiKey.trim() || /[\r\n]/.test(ctx.apiKey)) throw new Error("a valid Doubao Speech API Key is required");
  return {
    url: base + "/api/v3/tts/create",
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": ctx.apiKey.trim(), "X-Api-Request-Id": ctx.publicTaskId || utils.uuid() },
    body: payload(ctx.requestBody, model),
  };
}

export function parseSubmitResponse(ctx, response) {
  const data = object(response.body, "upstream response");
  if (response.statusCode !== 200 || (data.code !== undefined && data.code !== 0)) {
    // Do not echo arbitrary upstream messages, which may contain credentials or user input.
    throw new Error("Doubao audio generation failed (HTTP " + response.statusCode + ", code " + (Number.isInteger(data.code) ? data.code : "unknown") + ")");
  }
  const seconds = originalSeconds(data);
  const url = mediaURL(data.url, "audio URL");
  if (typeof data.duration !== "number" || !Number.isFinite(data.duration) || data.duration <= 0 || data.duration > 3600)
    throw new Error("invalid processed audio duration");
  const format = (ctx.requestBody && ctx.requestBody.audio_config && ctx.requestBody.audio_config.format) || "wav";
  const taskData = { url: url, duration: data.duration, original_duration: seconds, format: format, expires_at: utils.unixNow() + 7200 };
  if (data.subtitle !== undefined) taskData.subtitle = object(data.subtitle, "subtitle");
  // Base64 audio is intentionally not persisted: task JSON is limited to 1 MiB.
  // The credentialless host content proxy exposes the provider's two-hour URL.
  text(ctx.publicTaskId, "public task ID", 128);
  return { taskId: ctx.publicTaskId, taskData: taskData, immediate: { status: "SUCCESS", progress: "100%", url: url } };
}

export function extractUsage(ctx) {
  if (ctx.usagePurpose === "billing_ratios") return null;
  payload(ctx.requestBody, ctx.upstreamModel || ctx.model);
  // Duration is controlled by prose, not a trustworthy numeric request field.
  // Reserve the documented maximum, then settle/refund using original_duration.
  return { seconds: 120 };
}

export function extractUsageOnComplete(task, result, data) {
  if (result.status !== "SUCCESS") return {};
  return { seconds: originalSeconds(data) };
}

export function buildQueryRequest() {
  throw new Error("Doubao audio completes during submission; there is no upstream polling API");
}
export function parseTaskResult() {
  return { status: "UNKNOWN" };
}

export function listArtifacts(task) {
  if (task.status !== "SUCCESS" || !task.data || !task.data.url) return [];
  const format = task.data.format || "wav";
  return [{ key: "audio", type: "audio", mimeType: FORMATS[format] ? FORMATS[format].mime : "application/octet-stream" }];
}

export function buildContentRequest(ctx) {
  if (ctx.artifactKey !== "audio" || !ctx.data) throw new Error("audio artifact not found");
  if (utils.unixNow() >= ctx.data.expires_at) throw new Error("the two-hour upstream audio URL has expired");
  return { url: mediaURL(ctx.data.url, "audio URL"), method: ctx.clientRequest.method, credentialless: true };
}

export const native = {
  decodeSubmit: function (ctx) {
    if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
    const req = object(ctx.body.value, "request");
    const model = text(req.model, "model", 256);
    return { kind: "submit", model: model, action: "audio_generation", requestBody: payload(req, model) };
  },
  renderTask: function (ctx, task) {
    return { task_id: task.task_id, status: task.status, fail_reason: task.fail_reason || "", data: task.data || null };
  },
  error: function (ctx, error) {
    return { error: { code: error.code, message: error.message } };
  },
};

export const protocols = {
  openai_responses: {
    decodeRequest: function (ctx) {
      if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
      const req = object(ctx.body.value, "request");
      const params = req.metadata === undefined ? {} : object(req.metadata, "metadata");
      onlyKeys(params, ["references", "audio_config", "watermark"], "metadata");
      const body = Object.assign({}, params, { model: ctx.model, text_prompt: text(req.input, "input", 3000) });
      return { kind: "submit", model: ctx.model, action: "audio_generation", requestBody: payload(body, ctx.model) };
    },
    renderFinal: function (ctx, task) {
      const artifact = ctx.artifacts && ctx.artifacts.audio;
      if (!artifact || !artifact.url) throw new Error("audio artifact is unavailable");
      const url = String(artifact.url).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return {
        output: [
          {
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: '<audio controls src="' + url + '"></audio>', annotations: [], logprobs: [] }],
          },
        ],
        metadata: { vendor: "doubao-audio", original_duration: String(task.data.original_duration), expires_at: String(task.data.expires_at) },
      };
    },
  },
};
