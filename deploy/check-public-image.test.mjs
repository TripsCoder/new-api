import assert from 'node:assert/strict';
import test from 'node:test';
import { checkPublicImage } from './check-public-image.mjs';

const repository = 'TripsCoder/new-api';
const token = 'fixture-not-a-real-token';

test('a linked public package can receive the release', async () => {
  assert.equal(await checkPublicImage({ repository, token, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.github.com/users/TripsCoder/packages/container/new-api');
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    return { ok: true, status: 200, json: async () => ({ visibility: 'public', repository: { full_name: repository } }) };
  } }), 'public');
});

test('missing is accepted only before first publication', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404 });
  assert.equal(await checkPublicImage({ repository, token, fetchImpl, allowMissing: true }), 'missing');
  await assert.rejects(checkPublicImage({ repository, token, fetchImpl }), /HTTP 404/);
});

for (const visibility of ['private', 'internal', undefined]) {
  test(`refuses ${visibility ?? 'unknown'} visibility`, async () => {
    await assert.rejects(checkPublicImage({ repository, token, fetchImpl: async () => ({
      ok: true, status: 200, json: async () => ({ visibility, repository: { full_name: repository } }),
    }) }), /not public/);
  });
}

for (const status of [401, 403, 429, 500]) {
  test(`HTTP ${status} never counts as a missing/public package`, async () => {
    await assert.rejects(checkPublicImage({ repository, token, allowMissing: true,
      fetchImpl: async () => ({ ok: false, status }),
    }), new RegExp(`HTTP ${status}`));
  });
}

test('refuses a package associated with another repository', async () => {
  await assert.rejects(checkPublicImage({ repository, token, fetchImpl: async () => ({
    ok: true, status: 200, json: async () => ({ visibility: 'public', repository: { full_name: 'TripsCoder/unrelated' } }),
  }) }), /expected repository/);
});
