const H3_MODEL = "MiniMax-H3";
const DEFAULT_SECONDS = 4;
const DEFAULT_RESOLUTION = "768P";
const DEFAULT_RATIO = "9:16";

const SIZE_SPECS = {
  "720x1280": { resolution: "768P", ratio: "9:16" },
  "1280x720": { resolution: "768P", ratio: "16:9" },
  "1024x1792": { resolution: "2K", ratio: "9:16" },
  "1792x1024": { resolution: "2K", ratio: "16:9" },
};

const RESOLUTIONS = ["480p", "768P", "1080p", "2K"];
const RATIOS = ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
const FILE_FIELDS = {
  input_reference: { type: "image_url", role: "reference_image", mimeType: "image/png", maxBytes: 30 * 1024 * 1024 },
  reference_image: { type: "image_url", role: "reference_image", mimeType: "image/png", maxBytes: 30 * 1024 * 1024 },
  reference_video: { type: "video_url", role: "reference_video", mimeType: "video/mp4", maxBytes: 50 * 1024 * 1024 },
  video_reference: { type: "video_url", role: "reference_video", mimeType: "video/mp4", maxBytes: 50 * 1024 * 1024 },
  reference_audio: { type: "audio_url", role: "reference_audio", mimeType: "audio/mpeg", maxBytes: 15 * 1024 * 1024 },
  audio_reference: { type: "audio_url", role: "reference_audio", mimeType: "audio/mpeg", maxBytes: 15 * 1024 * 1024 },
};

export const meta = {
  apiVersion: 1,
  key: "minimax-meta",
  name: "MiniMax-Meta",
  icon: "Minimax.Color",
  description: {
    en: "Metaso MiniMax H3 video generation through the OpenAI video protocol",
    zh: "通过 OpenAI 视频协议调用 Metaso MiniMax H3，支持图片、视频和音频参考素材",
  },
  version: "1.2.2",
  author: { name: "Metaso" },
  models: [H3_MODEL],
  fetchMode: "per_task",
  usageSchema: {
    seconds: {
      type: "number",
      unit: "second",
      description: { en: "Requested video duration in seconds.", zh: "请求的视频时长，单位为秒。" },
    },
    resolution: {
      enum: RESOLUTIONS,
      description: { en: "Requested output resolution.", zh: "请求的输出分辨率。" },
    },
    duration_band: {
      enum: ["4-15s", "16-30s"],
      description: {
        en: "Output duration tier; each resolution and tier has independent prices.",
        zh: "输出时长档位；每种分辨率、每个时长档位可独立设置价格。",
      },
    },
    input_images: {
      type: "number",
      unit: "count",
      description: { en: "Input image materials beyond the first five.", zh: "超过前五张的输入图片素材数量。" },
    },
    input_video_seconds: {
      type: "number",
      unit: "second",
      description: {
        en: "Reference video seconds, rounded up; reserve 15 seconds when metadata is unavailable, then settle upstream usage.",
        zh: "参考视频总秒数向上取整；无元数据时预扣 15 秒，完成后按上游实际用量结算。",
      },
    },
  },
  usageExamples: [
    { label: "480p 15s", facts: { seconds: 15, resolution: "480p", duration_band: "4-15s", input_images: 0, input_video_seconds: 0 } },
    { label: "480p 30s", facts: { seconds: 30, resolution: "480p", duration_band: "16-30s", input_images: 2, input_video_seconds: 8 } },
    { label: "768P 15s", facts: { seconds: 15, resolution: "768P", duration_band: "4-15s", input_images: 2, input_video_seconds: 8 } },
    { label: "768P 16s", facts: { seconds: 16, resolution: "768P", duration_band: "16-30s", input_images: 2, input_video_seconds: 8 } },
    { label: "1080p 15s", facts: { seconds: 15, resolution: "1080p", duration_band: "4-15s", input_images: 0, input_video_seconds: 0 } },
    { label: "2K 8s with input video", facts: { seconds: 8, resolution: "2K", duration_band: "4-15s", input_images: 2, input_video_seconds: 12 } },
  ],
  protocols: [{ name: "openai_responses", supports: ["stream", "sync", "background"] }, "openai_video"],
};

function trimmed(value) {
  return String(value == null ? "" : value).trim();
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function metadataOf(req) {
  return objectValue(req && req.metadata);
}

function nestedMetasoMetadata(req) {
  return objectValue(metadataOf(req).metaso);
}

function firstValue(req, keys) {
  const metadata = metadataOf(req);
  const metaso = nestedMetasoMetadata(req);
  for (const key of keys) {
    if (req && req[key] !== undefined && req[key] !== null && trimmed(req[key]) !== "") return req[key];
    if (metadata[key] !== undefined && metadata[key] !== null && trimmed(metadata[key]) !== "") return metadata[key];
    if (metaso[key] !== undefined && metaso[key] !== null && trimmed(metaso[key]) !== "") return metaso[key];
  }
  return undefined;
}

function mediaURL(value) {
  if (typeof value === "string") return trimmed(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  if (value.file_id !== undefined && value.file_id !== null) {
    const fileId = trimmed(value.file_id);
    if (fileId.startsWith("mm_file://")) return fileId;
    if (!/^\d+$/.test(fileId)) throw new Error("input_reference.file_id must be a numeric Metaso file id");
    return "mm_file://" + fileId;
  }
  if (typeof value.url === "string") return trimmed(value.url);
  if (typeof value.image_url === "string") return trimmed(value.image_url);
  if (value.image_url && typeof value.image_url === "object") return mediaURL(value.image_url);
  return "";
}

function mediaItem(type, role, url) {
  const key = type;
  return {
    type: type,
    role: role,
    [key]: { url: url },
  };
}

function fileItem(file) {
  const spec = FILE_FIELDS[file.field];
  if (!spec) throw new Error("unsupported MiniMax-Meta file field: " + file.field);
  return mediaItem(spec.type, spec.role, {
    __fileRef: file.ref,
    encoding: "dataUrl",
    mimeType: trimmed(file.mimeType) || spec.mimeType,
    maxBytes: spec.maxBytes,
  });
}

function contentHasType(content, type) {
  return content.some(function (item) {
    return item && item.type === type;
  });
}

function buildH3Content(req, files) {
  const metadata = metadataOf(req);
  const supplied = Array.isArray(req && req.content) ? req.content : Array.isArray(metadata.metaso_content) ? metadata.metaso_content : [];
  const content = [];
  let hasText = false;

  for (const item of supplied) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (item.type === "text" && trimmed(item.text)) hasText = true;
    content.push(item);
  }

  const standardImage = mediaURL(req && (req.input_reference || req.image));
  if (standardImage) {
    content.push(mediaItem("image_url", "reference_image", standardImage));
  }

  for (const file of files || []) content.push(fileItem(file));

  const prompt = trimmed(req && req.prompt);
  if (!hasText && prompt) content.unshift({ type: "text", text: prompt });
  if (
    !content.some(function (item) {
      return item && item.type === "text" && trimmed(item.text);
    })
  ) {
    throw new Error("field prompt or metadata.metaso_content text is required");
  }
  for (const [type, limit] of [
    ["image_url", 9],
    ["video_url", 3],
    ["audio_url", 3],
  ]) {
    if (
      content.filter(function (item) {
        return item.type === type;
      }).length > limit
    ) {
      throw new Error(type + " materials must not exceed " + limit);
    }
  }
  return content;
}

function outputSpec(req) {
  const size = trimmed(req && req.size);
  const fromSize = SIZE_SPECS[size];
  const rawResolution = trimmed(firstValue(req, ["resolution", "metaso_resolution"])) || (fromSize && fromSize.resolution) || DEFAULT_RESOLUTION;
  const resolution =
    RESOLUTIONS.find(function (value) {
      return value.toLowerCase() === rawResolution.toLowerCase();
    }) || rawResolution;
  const ratio = trimmed(firstValue(req, ["ratio", "metaso_ratio"])) || (fromSize && fromSize.ratio) || DEFAULT_RATIO;
  if (!RESOLUTIONS.includes(resolution)) throw new Error("resolution must be 480p, 768P, 1080p or 2K");
  if (!RATIOS.includes(ratio)) throw new Error("ratio is not supported");
  return { resolution: resolution, ratio: ratio };
}

function durationOf(req) {
  const raw = req && req.seconds !== undefined ? req.seconds : req && req.duration;
  const duration = raw === undefined || raw === null || raw === "" ? DEFAULT_SECONDS : Number(raw);
  const resolution = outputSpec(req).resolution;
  const maximum = resolution === "1080p" || resolution === "2K" ? 15 : 30;
  if (!Number.isInteger(duration) || duration < 4 || duration > maximum) {
    throw new Error("seconds must be an integer between 4 and " + maximum + " for " + resolution);
  }
  return duration;
}

function actionForContent(content) {
  if (contentHasType(content, "video_url") || contentHasType(content, "audio_url")) return "multimodal_to_video";
  if (contentHasType(content, "image_url")) return "image_to_video";
  return "text_to_video";
}

function imageCountAfterFree(req, files) {
  const content = buildH3Content(req, files);
  let count = 0;
  for (const item of content) {
    if (item && item.type === "image_url") count += 1;
  }
  return Math.max(0, count - 5);
}

function inputVideoSeconds(ctx) {
  const count = buildH3Content(ctx.requestBody || {}, ctx.files || []).filter(function (item) {
    return item.type === "video_url";
  }).length;
  if (!count) return 0;
  const videos = ctx && ctx.mediaMetadata && Array.isArray(ctx.mediaMetadata.videos) ? ctx.mediaMetadata.videos : [];
  // shortcut: stock New API cannot probe media; reserve the provider's 15s input cap until upstream usage arrives.
  if (videos.length !== count) return 15;
  let total = 0;
  for (const video of videos) {
    const duration = Number(video && video.durationSeconds);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("invalid reference video duration");
    total += duration;
  }
  return referenceVideoBillingSeconds(total, count);
}

function referenceVideoBillingSeconds(total, count) {
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0 || total > (count === 1 ? 15.5 : 15)) {
    throw new Error("reference video duration must be a number within the 15-second limit");
  }
  return Math.min(15, Math.ceil(total));
}

function copyOptionalFields(req, body) {
  for (const key of ["callback_url", "aigc_watermark", "context_ir_enabled", "billing_policy"]) {
    if (req && req[key] !== undefined && req[key] !== null) body[key] = req[key];
  }
}

function buildH3Body(req, files) {
  const spec = outputSpec(req);
  const body = {
    model: H3_MODEL,
    content: buildH3Content(req, files),
    resolution: spec.resolution,
    duration: durationOf(req),
    ratio: spec.ratio,
  };
  copyOptionalFields(req, body);
  return body;
}

function taskFromResponse(body) {
  if (body && body.task && typeof body.task === "object") return body.task;
  return body || {};
}

function contentURL(value) {
  const task = taskFromResponse(value);
  return trimmed(task.content && task.content.url);
}

function statusResult(task) {
  const status = trimmed(task.status).toLowerCase();
  if (status === "succeeded" || status === "success" || status === "completed") {
    return { status: "SUCCESS", progress: "100%", url: contentURL(task) };
  }
  if (status === "failed" || status === "failure" || status === "cancelled") {
    const error = task.error || {};
    return { status: "FAILURE", progress: "100%", reason: trimmed(error.message) || "MiniMax-H3 task failed" };
  }
  if (status === "running" || status === "processing") return { status: "IN_PROGRESS", progress: "50%" };
  return { status: "QUEUED", progress: "0%" };
}

function responseInput(req) {
  const texts = [];
  const images = [];
  const input = req && req.input;
  if (typeof input === "string") texts.push(input);
  else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string") {
        texts.push(item);
        continue;
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const parts = item.content === undefined ? [item] : Array.isArray(item.content) ? item.content : [item.content];
      for (const part of parts) {
        if (typeof part === "string") {
          texts.push(part);
          continue;
        }
        if (!part || typeof part !== "object" || Array.isArray(part)) continue;
        if (["input_text", "text"].includes(part.type) && typeof part.text === "string") texts.push(part.text);
        if (["input_image", "image_url"].includes(part.type)) {
          let image = part.image_url;
          if (image && typeof image === "object") image = image.url;
          if (trimmed(image)) images.push(trimmed(image));
        }
      }
    }
  }
  return {
    prompt: texts
      .filter(function (text) {
        return trimmed(text);
      })
      .join("\n"),
    images: images,
  };
}

function responseVideoText(ctx) {
  const artifact = ctx && ctx.artifacts && ctx.artifacts.video;
  const url = trimmed(artifact && artifact.url);
  if (!url) throw new Error("video artifact is unavailable");
  const escaped = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return '<video controls src="' + escaped + '"></video>';
}

function metasoAPIBase(baseUrl) {
  const base = trimmed(baseUrl).replace(/\/+$/, "");
  // Existing channels may use the origin; explicit API/proxy paths stay intact.
  return /^https?:\/\/[^/]+$/i.test(base) ? base + "/api" : base;
}

export function buildSubmitRequest(ctx) {
  const req = ctx.requestBody || {};
  const content = buildH3Content(req, ctx.files || []);
  return {
    url: metasoAPIBase(ctx.baseUrl) + "/minimax/v2/video_generation",
    method: "POST",
    headers: {
      Authorization: "Bearer " + ctx.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: buildH3Body(req, ctx.files || []),
    action: actionForContent(content),
  };
}

export function parseSubmitResponse(_ctx, resp) {
  const body = resp.body || {};
  const taskId = body.task_id || (body.task && (body.task.id || body.task.task_id));
  if (!taskId) throw new Error("MiniMax-H3 response does not contain task_id");
  return { taskId: String(taskId), taskData: body };
}

export function buildQueryRequest(ctx) {
  return {
    url: metasoAPIBase(ctx.baseUrl) + "/minimax/v2/query/video_generation/" + encodeURIComponent(ctx.taskId),
    method: "GET",
    headers: { Authorization: "Bearer " + ctx.apiKey, Accept: "application/json" },
  };
}

export function parseTaskResult(_ctx, body) {
  const task = taskFromResponse(body);
  const result = statusResult(task);
  result.taskId = String(task.id || task.task_id || "");
  return result;
}

export function extractUsage(ctx) {
  const req = ctx.requestBody || {};
  const spec = outputSpec(req);
  const seconds = durationOf(req);
  return {
    seconds: seconds,
    resolution: spec.resolution,
    duration_band: seconds <= 15 ? "4-15s" : "16-30s",
    input_images: imageCountAfterFree(req, ctx.files || []),
    input_video_seconds: inputVideoSeconds(ctx),
  };
}

export function extractMediaSources(ctx) {
  const req = ctx.requestBody || {};
  const content = buildH3Content(req, ctx.files || []);
  const videos = [];
  for (const item of content) {
    if (!item || item.type !== "video_url") continue;
    const url = mediaURL(item.video_url);
    // Metaso private file ids cannot be read by the host; reserve all inputs together instead of probing a partial list.
    if (url.startsWith("mm_file://")) return { videos: [] };
    if (url) videos.push({ url: url });
  }
  for (const file of ctx.files || []) {
    const spec = FILE_FIELDS[file.field];
    if (spec && spec.type === "video_url") videos.push({ fileRef: file.ref });
  }
  return { videos: videos };
}

export function extractUsageOnComplete(_task, _taskResult, body) {
  const task = taskFromResponse(body);
  const duration = task.duration;
  const resolution = task.resolution;
  const facts = {};
  // Output facts move together so a partial response cannot form an unsupported tier.
  if (duration !== undefined && duration !== null && resolution !== undefined && resolution !== null) {
    if (typeof duration !== "number" || typeof resolution !== "string") throw new Error("invalid completed video specification");
    durationOf({ duration: duration, resolution: resolution });
    facts.seconds = duration;
    facts.resolution = outputSpec({ resolution: resolution }).resolution;
    facts.duration_band = duration <= 15 ? "4-15s" : "16-30s";
  }
  const usage = objectValue(task.usage);
  const inputSeconds = usage.input_seconds !== undefined ? usage.input_seconds : usage.inputVideoSeconds;
  if (inputSeconds !== undefined && inputSeconds !== null) {
    facts.input_video_seconds = referenceVideoBillingSeconds(inputSeconds, 1);
  }
  if (!Object.keys(facts).length) return null;
  return facts;
}

export function listArtifacts(task) {
  return task.status === "SUCCESS" && contentURL(task.data) ? [{ key: "video", type: "video", mimeType: "video/mp4" }] : [];
}

export function buildContentRequest(ctx) {
  const url = contentURL(ctx.data);
  if (!url) throw new Error("artifact_not_found");
  return {
    url: url,
    method: ctx.clientRequest.method,
    credentialless: true,
  };
}

function decodeOpenAiVideo(ctx) {
  if (!ctx.body || (ctx.body.kind !== "json" && ctx.body.kind !== "multipart")) throw new Error("JSON or multipart body required");
  if (ctx.body.kind === "json") {
    if (!ctx.body.value || typeof ctx.body.value !== "object" || Array.isArray(ctx.body.value)) throw new Error("JSON object required");
    const req = Object.assign({}, ctx.body.value, { model: ctx.model });
    buildH3Body(req, []);
    return { kind: "submit", model: ctx.model, action: "text_to_video", requestBody: req };
  }

  const first = function (name) {
    const values = (ctx.body.fields || {})[name] || [];
    if (values.length > 1) throw new Error(name + " must be provided once");
    return values[0];
  };
  const req = {};
  for (const name of Object.keys(ctx.body.fields || {})) req[name] = first(name);
  if (req.metadata !== undefined) {
    try {
      req.metadata = JSON.parse(req.metadata);
    } catch {
      throw new Error("metadata must be a JSON object string");
    }
    if (!req.metadata || typeof req.metadata !== "object" || Array.isArray(req.metadata)) throw new Error("metadata must be a JSON object string");
  }
  for (const file of ctx.body.files || []) {
    if (!FILE_FIELDS[file.field]) throw new Error("unexpected MiniMax-Meta file field: " + file.field);
  }
  if (req.seconds !== undefined) req.seconds = Number(req.seconds);
  const body = Object.assign({}, req, { model: ctx.model });
  buildH3Body(body, ctx.body.files || []);
  return { kind: "submit", model: ctx.model, action: "text_to_video", requestBody: body };
}

function legacyVideo(task) {
  const statuses = { NOT_START: "queued", SUBMITTED: "queued", QUEUED: "queued", IN_PROGRESS: "in_progress", SUCCESS: "completed", FAILURE: "failed" };
  const output = {
    id: task.task_id,
    object: "video",
    model: task.properties && task.properties.origin_model_name ? task.properties.origin_model_name : "sora-2",
    status: statuses[task.status] || "unknown",
    progress: Number(String(task.progress || "0").replace("%", "")),
    created_at: Number(task.created_at || 0),
  };
  if (task.updated_at) output.completed_at = Number(task.updated_at);
  if (task.status === "FAILURE") output.error = { code: "video_generation_failed", message: task.fail_reason || "MiniMax-H3 task failed" };
  return output;
}

export const protocols = {
  openai_video: {
    decodeRequest: decodeOpenAiVideo,
    render: function (_ctx, task) {
      return legacyVideo(task);
    },
  },
  openai_responses: {
    decodeRequest: function (ctx) {
      if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
      const req = ctx.body.value;
      if (!req || typeof req !== "object" || Array.isArray(req)) throw new Error("request body must be an object");
      const input = responseInput(req);
      const prompt = input.prompt || trimmed(req.prompt);
      if (!prompt && !input.images.length) throw new Error("input is required");
      const metadata = objectValue(req.metadata);
      const requestBody = Object.assign({}, req, {
        model: ctx.model,
        prompt: prompt,
        metadata: metadata,
      });
      if (!Array.isArray(requestBody.content) && input.images.length) {
        requestBody.content = input.images.map(function (image) {
          return mediaItem("image_url", "reference_image", image);
        });
      }
      buildH3Body(requestBody, []);
      return { kind: "submit", model: ctx.model, action: input.images.length ? "image_to_video" : "text_to_video", requestBody: requestBody };
    },
    renderEvents: function (ctx, task, previousState) {
      const status = String(task.status || "UNKNOWN").toUpperCase();
      const value = Number(String(task.progress || "").replace("%", ""));
      const progress = Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
      const state = { status: status, progress: progress };
      if (status === "SUCCESS") {
        const text = responseVideoText(ctx);
        const events = previousState && previousState.status === status ? [] : [{ type: "output", data: text }];
        return { events: events, state: state, done: true };
      }
      if (status === "FAILURE")
        return { events: [{ type: "error", code: "task_failed", message: task.fail_reason || "MiniMax-H3 task failed" }], state: state, done: true };
      if (previousState && previousState.status === status && previousState.progress === progress) return { events: [], state: state, done: false };
      const event = { type: "progress", message: status.toLowerCase() };
      if (progress !== null) event.progress = progress;
      return { events: [event], state: state, done: false };
    },
    renderFinal: function (ctx, _task) {
      return {
        output: [
          {
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: responseVideoText(ctx), annotations: [], logprobs: [] }],
          },
        ],
        metadata: { vendor: "minimax-meta" },
      };
    },
  },
};
