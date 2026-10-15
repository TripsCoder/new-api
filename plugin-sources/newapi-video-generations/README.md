# NewAPI Video Generations JSON

This task plugin reuses `../media-providers/runtime.js` unchanged. It translates the shared OpenAI video request into the JSON wire format of Yingce's `newapi-channel-2` manifest. Model-specific policies are data in `profiles.json`; do not create a new execution or billing runtime for another supplier or model using this same wire format.

```powershell
node plugin-sources/media-providers/build.mjs --profiles plugin-sources/newapi-video-generations/profiles.json --source-lock plugin-sources/newapi-video-generations/sources.lock.json --out plugin-sources/newapi-video-generations/dist
node --test plugin-sources/newapi-video-generations/plugin.test.mjs
```

Repeat the build command with `--check` to verify exact source inputs and output. Upload `dist/newapi_video_generations.plugin.js` through the normal task-plugin management interface; do not replace the new-api executable. Discovery uses the supplier's authenticated `/v1/models`; `meta.models` only declares reviewed models.

The reviewed YC models are `sd2.0-c1`, `sd2.0-c2`, and `sd2.5-c1`. `sources.lock.json` records evidence and unresolved protocol and usage details. Public pricing is evidence only; no prices or credentials are embedded. New channels and host drafts remain disabled pending pricing and real-generation verification.

The existing host sync and gateway profile own conversion into host capability records. Follow the authoritative juhefuwu channel gate and task section 23 in `docs/migration/new-api-channel-sync-20261011.md`; this README does not redefine that gate or the host architecture.
