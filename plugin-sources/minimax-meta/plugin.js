// Maintained candidate based on Metaso's official 1.1.0 plugin.
// Official guide: https://metaso.cn/minimax-h3/new-api-guide
// Original download: https://metaso.cn/minimax-h3/new-api-guide/minimax-h3-metaso.plugin.js
// 30s source: https://github.com/ddcat-ai/open-ai-canvas/blob/f368e63090534bcc1af354406c3d938a819fbfca/plugin-packages/metaso-h3/docs/interface.md
// Exact upstream URLs, hashes, Yingce source and 2026-10-15 approval: sources.lock.json.
// Only MiniMax-H3 is adapted here; discovery and H3-Max are not declared.
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

const RESOLUTIONS = ["768P", "2K"];
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
    en: "Metaso MiniMax H3 video generation with image, video and audio references",
    zh: "Metaso MiniMax H3 视频生成，支持图片、视频和音频参考素材",
  },
  version: "1.2.0",
  author: { name: "Metaso" },
  channelTypes: [62],
  models: [H3_MODEL],
  fetchMode: "per_task",
  usageSchema: {
    seconds: {
      type: "number",
      unit: "second",
      description: { en: "Video generation unit price", zh: "视频生成单价" },
    },
    resolution: {
      enum: RESOLUTIONS,
      description: { en: "Output video resolution", zh: "输出视频分辨率" },
    },
    image_count_after_free: {
      type: "number",
      unit: "count",
      description: { en: "Additional reference image unit price", zh: "额外参考图片单价" },
    },
    input_video_seconds: {
      type: "number",
      unit: "second",
      description: { en: "Reference video input unit price", zh: "参考视频输入单价" },
    },
  },
  usageExamples: [
    { label: "768P 4s", facts: { seconds: 4, resolution: "768P", image_count_after_free: 0, input_video_seconds: 0 } },
    { label: "2K 8s with input video", facts: { seconds: 8, resolution: "2K", image_count_after_free: 2, input_video_seconds: 12 } },
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
  if (typeof value.dataUrl === "string") return trimmed(value.dataUrl);
  for (const key of ["image_url", "video_url", "audio_url"]) {
    if (typeof value[key] === "string") return trimmed(value[key]);
    if (value[key] && typeof value[key] === "object") return mediaURL(value[key]);
  }
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

function appendUniqueMedia(content, item, knownContent) {
  const type = item && item.type;
  if (!["image_url", "video_url", "audio_url"].includes(type)) {
    content.push(item);
    return;
  }
  const value = item[type] && item[type].url !== undefined ? item[type].url : item[type];
  const identity = typeof value === "string" ? trimmed(value) : value && value.__fileRef;
  const defaultRole = { image_url: "reference_image", video_url: "reference_video", audio_url: "reference_audio" }[type];
  const role = trimmed(item.role) || defaultRole;
  const duplicate = identity && knownContent.some(function (existing) {
    if (!existing || existing.type !== type || (trimmed(existing.role) || defaultRole) !== role) return false;
    const previous = existing[type] && existing[type].url !== undefined ? existing[type].url : existing[type];
    return (typeof previous === "string" ? trimmed(previous) : previous && previous.__fileRef) === identity;
  });
  if (!duplicate) content.push(item);
}

function buildH3Content(req, files) {
  const metadata = metadataOf(req);
  const supplied = Array.isArray(req && req.content) ? req.content : Array.isArray(metadata.metaso_content) ? metadata.metaso_content : [];
  const content = [];
  let hasText = false;

  for (const item of supplied) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (item.type === "text" && trimmed(item.text)) hasText = true;
    // Explicit legacy items may repeat a URL with different positional or vendor
    // semantics. Preserve them and their existing image-count usage unchanged.
    content.push(item);
  }

  const standardImage = mediaURL(req && (req.input_reference || req.image));
  if (standardImage) {
    content.push(mediaItem("image_url", "reference_image", standardImage));
  }

  const uploaded = (files || []).map(fileItem);
  for (const [field, type, role] of [
    ["images", "image_url", "reference_image"],
    ["videos", "video_url", "reference_video"],
    ["audios", "audio_url", "reference_audio"],
  ]) {
    const items = req && req[field];
    if (items === undefined || items === null) continue;
    if (!Array.isArray(items)) throw new Error(field + " must be an array");
    // Deduplicate only across aliases, never within an explicitly supplied list.
    const knownContent = content.concat(uploaded);
    for (const item of items) {
      const url = mediaURL(item);
      if (!url) throw new Error(field + " must contain media URLs");
      appendUniqueMedia(content, mediaItem(type, trimmed(item && item.role) || role, url), knownContent);
    }
  }
  for (const item of uploaded) content.push(item);

  // Bound the merged references, including legacy content and uploaded files.
  for (const [type, maximum] of [["image_url", 9], ["video_url", 3], ["audio_url", 3]]) {
    if (content.filter(function (item) { return item && item.type === type; }).length > maximum) {
      throw new Error(type + " references must not exceed " + maximum);
    }
  }
  const hasFrames = content.some(function (item) { return item && ["first_frame", "last_frame"].includes(item.role); });
  const hasReferences = content.some(function (item) { return item && ["reference_image", "reference_video", "reference_audio"].includes(item.role); });
  if (hasFrames && hasReferences) throw new Error("first/last frames and reference materials cannot be combined");

  const prompt = trimmed(req && req.prompt);
  if (!hasText && prompt) content.unshift({ type: "text", text: prompt });
  if (
    !content.some(function (item) {
      return item && item.type === "text" && trimmed(item.text);
    })
  ) {
    throw new Error("field prompt or metadata.metaso_content text is required");
  }
  return content;
}

function outputSpec(req) {
  const size = trimmed(req && req.size);
  const fromSize = SIZE_SPECS[size];
  const resolution = trimmed(firstValue(req, ["resolution", "metaso_resolution"])).toUpperCase() || (fromSize && fromSize.resolution) || DEFAULT_RESOLUTION;
  const ratio = trimmed(firstValue(req, ["aspect_ratio", "ratio", "metaso_ratio"])) || (fromSize && fromSize.ratio) || DEFAULT_RATIO;
  if (!RESOLUTIONS.includes(resolution)) throw new Error("resolution must be 768P or 2K");
  if (!RATIOS.includes(ratio)) throw new Error("ratio is not supported");
  return { resolution: resolution, ratio: ratio };
}

function durationOf(req) {
  const raw = req && req.seconds !== undefined ? req.seconds : req && req.duration;
  const omitted = raw === undefined || raw === null || raw === "";
  if (!omitted && typeof raw !== "number" && (typeof raw !== "string" || !/^\d+$/.test(raw.trim()))) {
    throw new Error("seconds must be an integer between 4 and 30");
  }
  const duration = omitted ? DEFAULT_SECONDS : Number(raw);
  if (!Number.isInteger(duration) || duration < 4 || duration > 30) {
    throw new Error("seconds must be an integer between 4 and 30");
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
  const videos = ctx && ctx.mediaMetadata && Array.isArray(ctx.mediaMetadata.videos) ? ctx.mediaMetadata.videos : [];
  let total = 0;
  for (const video of videos) {
    const duration = Number(video && video.durationSeconds);
    if (Number.isFinite(duration) && duration > 0) total += duration;
  }
  return total;
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
  // Yingce uses /api/minimax; existing channels may already end in /api.
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
  return {
    seconds: durationOf(req),
    resolution: spec.resolution,
    image_count_after_free: imageCountAfterFree(req, ctx.files || []),
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
    if (url) videos.push({ url: url });
  }
  for (const file of ctx.files || []) {
    const spec = FILE_FIELDS[file.field];
    if (spec && spec.type === "video_url") videos.push({ fileRef: file.ref });
  }
  return { videos: videos };
}

function inputVideoSecondsFromResponse(body) {
  const task = taskFromResponse(body);
  const usage = objectValue(task.usage);
  const duration = Number(usage.input_seconds !== undefined ? usage.input_seconds : usage.inputVideoSeconds);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

export function extractUsageOnComplete(_task, _taskResult, body) {
  const task = taskFromResponse(body);
  const duration = Number(task.duration);
  const resolution = trimmed(task.resolution);
  if (!Number.isInteger(duration) || duration <= 0 || !resolution) return null;
  const facts = { seconds: duration, resolution: resolution };
  const inputSeconds = inputVideoSecondsFromResponse(body);
  if (inputSeconds > 0) facts.input_video_seconds = inputSeconds;
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
  for (const field of ["content", "images", "videos", "audios"]) {
    if (req[field] === undefined) continue;
    try {
      req[field] = JSON.parse(req[field]);
    } catch {
      throw new Error(field + " must be a JSON array string");
    }
    if (!Array.isArray(req[field])) throw new Error(field + " must be a JSON array string");
  }
  const body = Object.assign({}, req, { model: ctx.model });
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
      if (input.images.length) {
        if (requestBody.images !== undefined && !Array.isArray(requestBody.images)) throw new Error("images must be an array");
        const explicitImages = requestBody.images || [];
        requestBody.images = explicitImages.concat(input.images.filter(function (url) {
          return !explicitImages.some(function (item) {
            return mediaURL(item) === url && (trimmed(item && item.role) || "reference_image") === "reference_image";
          });
        }));
      }
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
