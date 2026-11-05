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
const renamedOfficialFacts = (facts) => {
  if (!facts) return facts;
  const { input_video_seconds, ...rest } = facts;
  return input_video_seconds === undefined ? rest : { ...rest, reference_video_duration_seconds: input_video_seconds };
};
const ctx = (requestBody, extras = {}) => ({ model, baseUrl: "https://metaso.cn/api", apiKey: "fixture-only", requestBody, ...extras });
const json = (body) => ({ model, body: { kind: "json", value: { model, prompt: "A quiet landscape", ...body } } });
const request = (body) => plugin.protocols.openai_video.decodeRequest(json(body)).requestBody;
const build = (body, extras) => plugin.buildSubmitRequest(ctx(request(body), extras));
const media = (type, url, role) => ({ type, [type]: { url }, role });

test("official baseline and candidate identity stay traceable", () => {
  assert.equal(createHash("sha256").update(baseline).digest("hex"), "4bfac32814942a8a8785330efed035fa68a3ad566cfcd7907bcbf223a85d0468");
  const lock = JSON.parse(readFileSync(new URL("./sources.lock.json", import.meta.url), "utf8"));
  assert.equal(createHash("sha256").update(source).digest("hex"), lock.candidate.sha256);
  assert.equal(lock.candidate.version, plugin.meta.version);
  assert.equal(plugin.meta.key, official.meta.key);
  assert.equal(plugin.meta.version, "1.3.0");
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
    assert.deepEqual(plugin.extractUsage(ctx(requestBody)), renamedOfficialFacts(official.extractUsage(ctx(requestBody))));
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
    videos: [{ video_url: { url: video }, role: "reference_video" }], video_durations: [1.25],
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
    assert.deepEqual(plugin.extractUsage(ctx(requestBody)), renamedOfficialFacts(official.extractUsage(ctx(requestBody))));
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
    assert.equal(build({ [field]: urls, ...(field === "videos" ? { video_durations: urls.map(() => 1) } : {}) }).body.content.length, maximum + 1);
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
  const context = { model, body: { kind: "multipart", fields: { prompt: ["A scene"], video_durations: ["[1.25]"], seconds: ["30"], resolution: ["768p"], images: ['["https://fixtures.invalid/i.png"]'] }, files } };
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
    assert.deepEqual(plugin.extractUsageOnComplete({}, {}, body), renamedOfficialFacts(official.extractUsageOnComplete({}, {}, body)));
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

test("usage metadata declares the exact model and complete renamed examples", () => {
  assert.deepEqual(plugin.meta.models, ["MiniMax-H3"]);
  assert.equal(plugin.meta.usageSchema.input_video_seconds, undefined);
  assert.deepEqual(plugin.meta.usageSchema.reference_video_duration_seconds, {
    type: "number", unit: "second",
    description: { en: "Reference video input unit price", zh: "\u53c2\u8003\u89c6\u9891\u8f93\u5165\u5355\u4ef7" },
  });
  for (const example of plugin.meta.usageExamples) {
    assert.deepEqual(Object.keys(example.facts).sort(), Object.keys(plugin.meta.usageSchema).sort());
    for (const [key, field] of Object.entries(plugin.meta.usageSchema)) {
      const value = example.facts[key];
      if (field.enum) assert.ok(field.enum.includes(value));
      else assert.ok(typeof value === "number" && Number.isFinite(value) && value >= 0);
      assert.ok(!/[.\u3002]$/.test(field.description.en));
      assert.ok(!/[.\u3002]$/.test(field.description.zh));
    }
  }
});

const videoURL = "https://fixtures.invalid/reference.mp4";
const videoItem = (url = videoURL) => media("video_url", url, "reference_video");
const videoFile = (field = "reference_video", index = 0) => ({ field, ref: "request_file:" + field + (index ? "#" + index : ""), mimeType: "video/mp4", filename: "fixture.mp4", size: 5 });

function assertNoBillingFields(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    assert.ok(!["video_durations", "reference_video_duration_seconds", "input_video_seconds"].includes(key), key);
    assertNoBillingFields(item);
  }
}

test("reference duration rejects invalid vectors before facts, ratios or submission", () => {
  const invalid = [undefined, null, [], [1, 2], 1, "[1]", "1", {}, true,
    [0], [-1], ["1"], [NaN], [Infinity], [-Infinity], [3600.01], [null], [true], [[]], [{}]];
  for (const video_durations of invalid) {
    const context = ctx(request({ videos: [videoURL], video_durations }));
    for (const usagePurpose of ["facts", "billing_ratios"]) {
      assert.throws(() => plugin.extractUsage({ ...context, usagePurpose }), /video_durations/);
    }
    assert.throws(() => plugin.buildSubmitRequest(context), /video_durations/);
  }
  assert.throws(() => build({ videos: [videoURL, videoURL], video_durations: [1800, 1800.01] }), /total must not exceed/);
  assert.equal(plugin.extractUsage(ctx(request({ videos: [videoURL], video_durations: [3600] }))).reference_video_duration_seconds, 3600);
  assert.equal(plugin.extractUsage(ctx(request({ videos: [videoURL, videoURL], video_durations: [1800.25, 1799.75] }))).reference_video_duration_seconds, 3600);
});

test("facts sum positional fractions and ratios preserve old positive multipliers", () => {
  const context = ctx(request({ seconds: 8, videos: [videoURL, videoURL], video_durations: [1.25, 2.5],
    content: Array.from({ length: 7 }, () => media("image_url", "https://fixtures.invalid/image.png", "reference_image")) }));
  Object.defineProperty(context, "mediaMetadata", { get() { throw new Error("unsupported host dependency"); } });
  const facts = plugin.extractUsage({ ...context, usagePurpose: "facts" });
  assert.deepEqual(plugin.extractUsage(context), facts);
  assert.deepEqual(facts, { seconds: 8, resolution: "768P", image_count_after_free: 2, reference_video_duration_seconds: 3.75 });
  const ratios = plugin.extractUsage({ ...context, usagePurpose: "billing_ratios" });
  assert.deepEqual(ratios, { seconds: 8, resolution: "768P", image_count_after_free: 2 });
  const positiveProduct = (usage) => Object.values(usage).filter((x) => typeof x === "number" && x > 0).reduce((a, b) => a * b, 1);
  // The official host never injected mediaMetadata: compare the real legacy context.
  assert.equal(positiveProduct(ratios), positiveProduct(official.extractUsage({ ...context })));
});

test("no reference video produces zero and rejects stray duration entries", () => {
  for (const fields of [{}, { video_durations: [] }]) {
    assert.equal(plugin.extractUsage(ctx(request(fields))).reference_video_duration_seconds, 0);
    assertNoBillingFields(build(fields).body);
  }
  for (const video_durations of [[1], "[]", null]) assert.throws(() => build({ video_durations }), /video_durations/);
});

test("explicit repeated videos and disjoint aliases preserve final positional order", () => {
  for (const fields of [{ content: [videoItem(), videoItem()] }, { metadata: { metaso_content: [videoItem(), videoItem()] } }, { videos: [videoURL, videoURL] }]) {
    const context = ctx(request({ ...fields, video_durations: [1.125, 2.25] }));
    assert.equal(plugin.buildSubmitRequest(context).body.content.filter((item) => item.type === "video_url").length, 2);
    assert.equal(plugin.extractUsage(context).reference_video_duration_seconds, 3.375);
  }
  const file = videoFile();
  const context = ctx(request({ content: [videoItem()], videos: [videoURL + "?second"], video_durations: [1.125, 2.25, 3.5] }), { files: [file] });
  assert.deepEqual(plugin.buildSubmitRequest(context).body.content.filter((item) => item.type === "video_url").map((item) => item.video_url.url),
    [videoURL, videoURL + "?second", { __fileRef: file.ref, encoding: "dataUrl", mimeType: "video/mp4", maxBytes: 50 * 1024 * 1024 }]);
  assert.equal(plugin.extractUsage(context).reference_video_duration_seconds, 6.875);
});

test("ambiguous aliases, shadowed videos and cross-field uploads fail closed", () => {
  for (const fields of [
    { content: [videoItem()], videos: [videoURL] },
    { metadata: { metaso_content: [videoItem()] }, videos: [videoURL] },
    { content: [], metadata: { metaso_content: [videoItem()] } },
    { content: [videoItem()], metadata: { metaso_content: [videoItem(videoURL + "?second")] } },
  ]) {
    const context = ctx(request({ ...fields, video_durations: [1] }));
    assert.throws(() => plugin.buildSubmitRequest(context), /aliases|both supply/);
    assert.throws(() => plugin.extractUsage(context), /aliases|both supply/);
  }
  for (const files of [[videoFile(), videoFile("video_reference")], [videoFile(), videoFile()]]) {
    const context = ctx(request({ video_durations: [1, 2] }), { files });
    assert.throws(() => plugin.buildSubmitRequest(context), /ambiguous order|refs must be unique/);
    assert.throws(() => plugin.extractUsage(context), /ambiguous order|refs must be unique/);
  }
  assert.throws(() => build({ content: [{ type: "video_url" }], video_durations: [1] }), /must have a URL/);
});

test("multipart explicitly parses duration arrays and preserves repeated file order", () => {
  const files = [videoFile(), videoFile("reference_video", 1)];
  const fields = { prompt: ["A scene"], video_durations: ["[1.25,2.5]"], reference_video_duration_seconds: ["999"], input_video_seconds: ["999"] };
  const decoded = plugin.protocols.openai_video.decodeRequest({ model, body: { kind: "multipart", fields, files } });
  assert.deepEqual(decoded.requestBody.video_durations, [1.25, 2.5]);
  const context = ctx(decoded.requestBody, { files });
  assert.equal(plugin.extractUsage(context).reference_video_duration_seconds, 3.75);
  const descriptor = plugin.buildSubmitRequest(context);
  assertNoBillingFields(descriptor.body);
  assert.deepEqual(descriptor.body.content.slice(1).map((item) => item.video_url.url.__fileRef), files.map((file) => file.ref));
  for (const value of ["bad", "null", "{}", "1", "[NaN]", "[Infinity]"]) {
    assert.throws(() => plugin.protocols.openai_video.decodeRequest({ model, body: { kind: "multipart", fields: { ...fields, video_durations: [value] }, files } }), /JSON array string/);
  }
  for (const value of ["[]", "[0,2]", '["1",2]', "[1]", "[1e999,2]"]) {
    const intent = plugin.protocols.openai_video.decodeRequest({ model, body: { kind: "multipart", fields: { ...fields, video_durations: [value] }, files } });
    assert.throws(() => plugin.buildSubmitRequest(ctx(intent.requestBody, { files })), /video_durations/);
  }
  assert.throws(() => plugin.protocols.openai_video.decodeRequest({ model, body: { kind: "multipart", fields: { ...fields, video_durations: ["[1]", "[2]"] }, files } }), /provided once/);
});

test("billing fields never reach supplier content and hooks do not mutate input", () => {
  const value = { model, prompt: "A scene", seconds: 8, content: [{ ...videoItem(), vendor_extension: { keep: true, video_durations: [999], reference_video_duration_seconds: 999, input_video_seconds: 999 } }],
    video_durations: [1.25], reference_video_duration_seconds: 999, input_video_seconds: 999 };
  const before = structuredClone(value);
  for (const protocol of ["openai_video", "openai_responses"]) {
    const intent = plugin.protocols[protocol].decodeRequest({ model, body: { kind: "json", value } });
    const context = ctx(intent.requestBody);
    for (let repeat = 0; repeat < 2; repeat++) {
      assert.equal(plugin.extractUsage(context).reference_video_duration_seconds, 1.25);
      const body = plugin.buildSubmitRequest(context).body;
      assertNoBillingFields(body);
      assert.deepEqual(body.content[1].vendor_extension, { keep: true });
    }
    assert.deepEqual(value, before);
  }
});

test("completion reports actual zero independently and omits missing or invalid reference facts", () => {
  for (const input_seconds of [0, 0.125, 12, 3600]) {
    for (const output of [{}, { duration: 8, resolution: "2K" }]) {
      const body = { task: { ...output, usage: { input_seconds } } };
      assert.deepEqual(plugin.extractUsageOnComplete({}, {}, body), { ...(output.duration ? { seconds: 8, resolution: "2K" } : {}), reference_video_duration_seconds: input_seconds });
    }
  }
  for (const input_seconds of [undefined, null, -1, NaN, Infinity, -Infinity, "0", "2.5", "", false, [], {}]) {
    assert.equal(plugin.extractUsageOnComplete({}, {}, { usage: { input_seconds } }), null);
    assert.deepEqual(plugin.extractUsageOnComplete({}, {}, { duration: 8, resolution: "2K", usage: { input_seconds } }), { seconds: 8, resolution: "2K" });
  }
  assert.equal(plugin.extractUsageOnComplete({}, {}, { usage: { inputVideoSeconds: 8 } }), null);
});

test("shared Go-engine fixtures also pass in Node", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixture.json", import.meta.url), "utf8"));
  for (const entry of fixture.cases) {
    let hook = plugin;
    for (const key of [entry.hook, ...(entry.path || (entry.member ? [entry.member] : []))]) hook = hook[key];
    if (entry.expectedError) assert.throws(() => hook(...entry.args), { message: entry.expectedError }, entry.name);
    else {
      const result = hook(...entry.args);
      assert.deepEqual(result, entry.expected, entry.name);
      if (entry.hook === "buildSubmitRequest") assertNoBillingFields(result.body);
    }
  }
});
