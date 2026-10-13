import { pathToFileURL } from 'node:url';

// An existing public package must never receive a private release's contents.
// A missing package may only pass before the first push (GHCR creates it private).
export async function checkPrivateImage({ repository, token, allowMissing = false, fetchImpl = fetch }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !token) {
    throw new Error('A repository and package-readable GitHub token are required');
  }
  const [owner, name] = repository.split('/');
  const response = await fetchImpl(
    `https://api.github.com/users/${encodeURIComponent(owner)}/packages/container/${encodeURIComponent(name.toLowerCase())}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
  );
  if (response.status === 404 && allowMissing) return 'missing';
  if (!response.ok) throw new Error(`Package visibility cannot be verified (HTTP ${response.status}); publication stopped`);
  const pkg = await response.json();
  if (pkg.visibility !== 'private') throw new Error('Package is not private; publication stopped');
  if (pkg.repository?.full_name?.toLowerCase() !== repository.toLowerCase()) {
    throw new Error('Package is not linked to the expected repository; publication stopped');
  }
  return 'private';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const state = await checkPrivateImage({
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GH_TOKEN,
      allowMissing: process.argv.includes('--allow-missing'),
    });
    console.log(`GHCR package visibility: ${state}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
