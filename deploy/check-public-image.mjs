import { pathToFileURL } from 'node:url';

// new-api is intentionally public; this guard never changes package visibility.
// A new package must be made public by its owner before the release alias advances.
export async function checkPublicImage({ repository, token, allowMissing = false, fetchImpl = fetch }) {
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
  if (pkg.visibility !== 'public') throw new Error('Package is not public; publication stopped');
  if (pkg.repository?.full_name?.toLowerCase() !== repository.toLowerCase()) {
    throw new Error('Package is not linked to the expected repository; publication stopped');
  }
  return 'public';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const state = await checkPublicImage({
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
