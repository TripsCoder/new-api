import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";

const source = readFileSync(new URL("./plugin.js", import.meta.url), "utf8");
const baseline = readFileSync(new URL("../installed/minimax-meta/plugin.js", import.meta.url), "utf8");
const load = (text) => import("data:text/javascript;base64," + Buffer.from(text).toString("base64"));
const plugin = await load(source);
const official = await load(baseline);
const model = "MiniMax-H3";
const ctx = (requestBody, extras = {}) => ({ model, baseUrl: "https://metaso.cn/api", apiKey: "fixture-only", requestBody, ...extras });
const json = (body) => ({ model, body: { kind: "json", value: { model, prompt: "A quiet landscape", ...body } } });
const request = (body) => plugin.protocols.openai_video.decodeRequest(json(body)).requestBody;
const build = (body, extras) => plugin.buildSubmitRequest(ctx(request(body), extras));
const media = (type, url, role) => ({ type, [type]: { url }, role });

test("official baseline and candidate identity stay traceable", () => {
  assert.equal(createHash("sha256").update(baseline).digest("hex"), "4bfac32814942a8a8785330efed035fa68a3ad566cfcd7907bcbf223a85d0468");
  assert.equal(plugin.meta.key, official.meta.key);
  assert.equal(plugin.meta.version, "1.2.0");
  assert.deepEqual(plugin.meta.models, [model]);
  assert.deepEqual(plugin.meta.protocols, official.meta.protocols);
  assert.deepEqual(plugin.meta.channelTypes, official.meta.channelTypes);
  assert.equal(plugin.meta.modelDiscovery, undefined);
  const profile = JSON.parse(readFileSync(new URL("./profiles.json", import.meta.url), "utf8"))["minimax-meta"].models[model];
  assert.equal(profile.maxVideos, 0);
  assert.equal(profile.maxAudios, 0);
  assert.equal(profile.metaH3, undefined);
});

test("old 4–15 seconds preserve requests and reserved usage", () => {
  for (let seconds = 4; seconds <= 15; seconds++) {
    const requestBody = request({ seconds });
    assert.deepEqual(plugin.buildSubmitRequest(ctx(requestBody)), official.buildSubmitRequest(ctx(requestBody)));
    assert.deepEqual(plugin.extractUsage(ctx(requestBody)), official.extractUsage(ctx(requestBody)));
  }
  assert.equal(build({}).body.duration, 4);
});

test("16 and 30 seconds work through both duration spellings", () => {
  for (const seconds of [16, 30]) {
    for (const field of ["seconds", "duration"]) {
      for (const value of [seconds, String(seconds)]) {
        const requestBody = request({ [field]: value });
        assert.equal(plugin.buildSubmitRequest(ctx(requestBody)).body.duration, seconds);
        assert.equal(plugin.extractUsage(ctx(requestBody)).seconds, seconds);
      }
    }
  }
  assert.equal(build({ seconds: 16, duration: 5 }).body.duration, 16);
});

test("invalid duration is rejected before usage or a submit descriptor", () => {
  for (const value of [3, 31, 4.5, -1, NaN, Infinity, "bad", "4.5", "0x10", " ", [], [5], {}, true, false]) {
    for (const field of ["seconds", "duration"]) {
      const requestBody = request({ [field]: value });
      assert.throws(() => plugin.buildSubmitRequest(ctx(requestBody)), /integer between 4 and 30/);
      assert.throws(() => plugin.extractUsage(ctx(requestBody)), /integer between 4 and 30/);
    }
  }
});

test("standard aspect ratio and resolution normalize without leaking aliases", () => {
  const body = build({ seconds: "30", aspect_ratio: "16:9", resolution: "2k" }).body;
  assert.equal(body.duration, 30);
  assert.equal(body.ratio, "16:9");
  assert.equal(body.resolution, "2K");
  assert.equal(body.aspect_ratio, undefined);
  assert.equal(body.seconds, undefined);
  assert.equal(build({ resolution: "768p" }).body.resolution, "768P");
  assert.equal(build({ metadata: { metaso: { ratio: "1:1", resolution: "2K" } } }).body.ratio, "1:1");
  assert.equal(build({ size: "1792x1024" }).body.ratio, "16:9");
  assert.throws(() => build({ resolution: "4k" }), /768P or 2K/);
  assert.throws(() => build({ aspect_ratio: "2:1" }), /ratio is not supported/);
});

test("unified reference arrays do not duplicate legacy aliases", () => {
  const image = "https://fixtures.invalid/image.png";
  const video = "https://fixtures.invalid/video.mp4";
  const audio = "https://fixtures.invalid/audio.mp3";
  const existing = media("image_url", image, "reference_image");
  existing.vendor_extension = "preserved";
  const value = { content: [{ type: "text", text: "Existing prompt" }, existing],
    images: [image, { url: image, role: "reference_image" }, { image_url: { url: image } }],
    videos: [{ video_url: { url: video }, role: "reference_video" }],
    audios: [{ audio_url: audio }] };
  const before = structuredClone(value);
  const descriptor = build(value);
  assert.deepEqual(descriptor.body.content, [value.content[0], existing, media("video_url", video, "reference_video"), media("audio_url", audio, "reference_audio")]);
  assert.equal(descriptor.action, "multimodal_to_video");
  assert.deepEqual(value, before);
  assert.deepEqual(plugin.extractMediaSources(ctx(request(value))), { videos: [{ url: video }] });
  assert.equal(plugin.extractUsage(ctx(request(value))).image_count_after_free, 0);
});

test("explicit repeated legacy and unified references preserve ordering and usage", () => {
  const image = "https://fixtures.invalid/repeated.png";
  const supplied = Array.from({ length: 6 }, (_, index) => ({ ...media("image_url", image, "reference_image"), label: "position-" + index }));
  for (const fields of [{ content: supplied }, { metadata: { metaso_content: supplied } }]) {
    const requestBody = request({ seconds: 8, ...fields, input_reference: image });
    assert.deepEqual(plugin.buildSubmitRequest(ctx(requestBody)), official.buildSubmitRequest(ctx(requestBody)));
    assert.deepEqual(plugin.extractUsage(ctx(requestBody)), official.extractUsage(ctx(requestBody)));
    assert.equal(plugin.extractUsage(ctx(requestBody)).image_count_after_free, 2);
    const converted = request({ seconds: 8, ...fields, images: [image] });
    assert.deepEqual(plugin.buildSubmitRequest(ctx(converted)).body.content.slice(1), supplied);
    assert.equal(plugin.extractUsage(ctx(converted)).image_count_after_free, 1);
  }
  const unified = request({ seconds: 8, images: Array(6).fill(image) });
  assert.equal(plugin.buildSubmitRequest(ctx(unified)).body.content.length, 7);
  assert.equal(plugin.extractUsage(ctx(unified)).image_count_after_free, 1);
});

test("frame roles and legacy metadata content are preserved", () => {
  const image = "https://fixtures.invalid/frame.png";
  const frames = build({ images: [{ url: image, role: "first_frame" }, { url: image, role: "last_frame" }] }).body.content;
  assert.deepEqual(frames.slice(1).map((item) => item.role), ["first_frame", "last_frame"]);
  const existing = media("audio_url", "https://fixtures.invalid/a.mp3", "reference_audio");
  const value = { metadata: { metaso_content: [existing] }, images: ["https://fixtures.invalid/i.png"] };
  assert.deepEqual(build(value).body.content.slice(1), [existing, media("image_url", value.images[0], "reference_image")]);
  assert.equal(build({ input_reference: { file_id: "1234" } }).body.content[1].image_url.url, "mm_file://1234");
  assert.throws(() => build({ images: [{ url: image, role: "first_frame" }], videos: ["https://fixtures.invalid/v.mp4"] }), /cannot be combined/);
});

test("merged reference counts and malformed arrays fail closed", () => {
  for (const [field, maximum] of [["images", 9], ["videos", 3], ["audios", 3]]) {
    const urls = Array.from({ length: maximum }, (_, index) => `https://fixtures.invalid/${field}/${index}`);
    assert.equal(build({ [field]: urls }).body.content.length, maximum + 1);
    assert.throws(() => build({ [field]: [...urls, "https://fixtures.invalid/extra"] }), /must not exceed/);
    assert.throws(() => build({ [field]: "https://fixtures.invalid/not-an-array" }), /must be an array/);
    assert.throws(() => build({ [field]: [{}] }), /must contain media URLs/);
  }
  assert.throws(() => build({ images: Array.from({ length: 9 }, (_, index) => `https://fixtures.invalid/${index}`), content: [media("image_url", "https://fixtures.invalid/extra", "reference_image")] }), /must not exceed/);
});

test("root and existing api base URLs use the same submit and query paths", () => {
  for (const baseUrl of ["https://metaso.cn", "https://metaso.cn/", "https://metaso.cn/api", "https://metaso.cn/api/"]) {
    assert.equal(build({}, { baseUrl }).url, "https://metaso.cn/api/minimax/v2/video_generation");
    const query = plugin.buildQueryRequest(ctx(undefined, { baseUrl, taskId: "task/id" }));
    assert.equal(query.url, "https://metaso.cn/api/minimax/v2/query/video_generation/task%2Fid");
    assert.deepEqual(query.headers, { Authorization: "Bearer fixture-only", Accept: "application/json" });
  }
});

test("multipart preserves uploaded file refs and validates duration strings", () => {
  const files = [{ ref: "request_file:reference_video", field: "reference_video", filename: "fixture.mp4", mimeType: "video/mp4", size: 5 }];
  const context = { model, body: { kind: "multipart", fields: { prompt: ["A scene"], seconds: ["30"], resolution: ["768p"], images: ['["https://fixtures.invalid/i.png"]'] }, files } };
  const decoded = plugin.protocols.openai_video.decodeRequest(context);
  const descriptor = plugin.buildSubmitRequest(ctx(decoded.requestBody, { files }));
  assert.equal(descriptor.body.duration, 30);
  assert.deepEqual(descriptor.body.content.at(-1).video_url.url, { __fileRef: files[0].ref, encoding: "dataUrl", mimeType: "video/mp4", maxBytes: 50 * 1024 * 1024 });
  assert.deepEqual(plugin.extractMediaSources(ctx(decoded.requestBody, { files })), { videos: [{ fileRef: files[0].ref }] });
  assert.throws(() => plugin.protocols.openai_video.decodeRequest({ model, body: { kind: "multipart", fields: { seconds: ["4", "5"] } } }), /provided once/);
  assert.throws(() => plugin.protocols.openai_video.decodeRequest({ model, body: { kind: "multipart", fields: { images: ["bad"] } } }), /JSON array/);
  for (const seconds of ["3", "31", "4.5", "true", ""]) {
    const decodedInvalid = plugin.protocols.openai_video.decodeRequest({ model, body: { kind: "multipart", fields: { prompt: ["A scene"], seconds: [seconds] } } });
    if (seconds === "") assert.equal(plugin.extractUsage(ctx(decodedInvalid.requestBody)).seconds, 4);
    else assert.throws(() => plugin.extractUsage(ctx(decodedInvalid.requestBody)), /integer between 4 and 30/);
  }
});

test("Responses input retains original metadata and deduplicates images", () => {
  const image = "https://fixtures.invalid/image.png";
  const value = { model, input: [{ role: "user", content: [{ type: "input_text", text: "A scene" }, { type: "input_image", image_url: image }] }],
    seconds: 30, images: [image], metadata: { metaso_content: [media("audio_url", "https://fixtures.invalid/a.mp3", "reference_audio")] } };
  const intent = plugin.protocols.openai_responses.decodeRequest({ model, body: { kind: "json", value } });
  const body = plugin.buildSubmitRequest(ctx(intent.requestBody)).body;
  assert.equal(body.duration, 30);
  assert.equal(body.content.filter((item) => item.type === "image_url").length, 1);
  assert.equal(body.content.filter((item) => item.type === "audio_url").length, 1);
  assert.equal(body.content[0].text, "A scene");
  const repeated = { ...value, images: Array(6).fill(image) };
  const decoded = plugin.protocols.openai_responses.decodeRequest({ model, body: { kind: "json", value: repeated } });
  assert.equal(plugin.buildSubmitRequest(ctx(decoded.requestBody)).body.content.filter((item) => item.type === "image_url").length, 6);
  assert.equal(plugin.extractUsage(ctx(decoded.requestBody)).image_count_after_free, 1);
});

test("query results, artifacts and completion usage retain official semantics", () => {
  assert.deepEqual(plugin.parseSubmitResponse({}, { body: { task_id: "id" } }), official.parseSubmitResponse({}, { body: { task_id: "id" } }));
  const bodies = [
    { task: { id: "id", status: "running" } },
    { task: { id: "id", status: "failed", error: { message: "fixture rejection" } } },
    { task: { id: "id", status: "succeeded", content: { url: "https://fixtures.invalid/output.mp4" }, duration: 12, resolution: "2K", usage: { input_seconds: 6 } } },
  ];
  for (const body of bodies) {
    assert.deepEqual(plugin.parseTaskResult({}, body), official.parseTaskResult({}, body));
    assert.deepEqual(plugin.extractUsageOnComplete({}, {}, body), official.extractUsageOnComplete({}, {}, body));
  }
  const task = { task_id: "public-id", status: "SUCCESS", data: bodies[2], properties: { origin_model_name: model }, progress: "100%", created_at: 1, updated_at: 2 };
  assert.deepEqual(plugin.listArtifacts(task), official.listArtifacts(task));
  const contentContext = { data: task.data, clientRequest: { method: "HEAD" } };
  assert.deepEqual(plugin.buildContentRequest(contentContext), official.buildContentRequest(contentContext));
  assert.equal(plugin.buildContentRequest(contentContext).credentialless, true);
  assert.deepEqual(plugin.protocols.openai_video.render({}, task), official.protocols.openai_video.render({}, task));
  const responseContext = { artifacts: { video: { url: "https://fixtures.invalid/host-artifact?a=1&b=2" } } };
  assert.deepEqual(plugin.protocols.openai_responses.renderFinal(responseContext, task), official.protocols.openai_responses.renderFinal(responseContext, task));
  assert.deepEqual(plugin.protocols.openai_responses.renderEvents(responseContext, task, null), official.protocols.openai_responses.renderEvents(responseContext, task, null));
  assert.deepEqual(plugin.extractUsageOnComplete({}, {}, { task: { duration: 30, resolution: "768P" } }), { seconds: 30, resolution: "768P" });
});

test("reference usage facts keep existing free-image and measured-video rules", () => {
  const requestBody = request({ seconds: 8, content: Array.from({ length: 7 }, (_, index) => media("image_url", `https://fixtures.invalid/${index}.png`, "reference_image")) });
  const context = ctx(requestBody, { mediaMetadata: { videos: [{ durationSeconds: 6 }, { durationSeconds: 3 }] } });
  assert.deepEqual(plugin.extractUsage(context), official.extractUsage(context));
  assert.deepEqual(plugin.extractUsage(context), { seconds: 8, resolution: "768P", image_count_after_free: 2, input_video_seconds: 9 });
  for (const [key, value] of Object.entries(plugin.meta.usageSchema)) {
    assert.equal(value.type, official.meta.usageSchema[key].type);
    assert.equal(value.unit, official.meta.usageSchema[key].unit);
    assert.deepEqual(value.enum, official.meta.usageSchema[key].enum);
    assert.ok(!/[.。]$/.test(value.description.en));
    assert.ok(!/[.。]$/.test(value.description.zh));
  }
});
