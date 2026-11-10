# MiniMax-Meta 1.2.1 API Base compatibility

This version is based on the exact locally active `minimax-meta@1.2.1` source
(SHA256 `6d2378921eaf7bb234938b7204f707cc00f2a27dfad97c1ee58eb660d2808eb5`).
It retains that source's 480p / 768P / 1080p / 2K inputs and usage contract.
Version 1.2.2 only normalizes the API Base for submit and query URLs: a bare
origin gains `/api`; explicit API or proxy paths are preserved and trailing
slashes are removed.

The parent `plugin.js` is a separately maintained 1.3.0 reference-duration
candidate. It is intentionally not overwritten or mixed into this patch.
Existing reference billing, prices, channel settings and historical task data
are outside this change.

```sh
node plugin-sources/minimax-meta/base-url-compat/build.mjs
node plugin-sources/minimax-meta/base-url-compat/plugin.test.mjs
node plugin-sources/minimax-meta/base-url-compat/build.mjs --check
```

The generated plugin and shared engine fixture are `dist/minimax-meta.plugin.js`
and `fixture.json`. Validation invokes descriptors offline, without executing
supplier requests. Installation and activation are recorded separately in the
[original task](../../../../juhefuwu/docs/migration/new-api-channel-sync-20261011.md#metaso-480p-audit-20261109).
