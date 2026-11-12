'use strict';

// CI runners share unauthenticated GitHub API quotas. Never send their token
// to a release CDN, raw-content host, or a lookalike API origin.
function buildDownloadHeaders(url, headers = {}, token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
  const result = { 'User-Agent': 'PawTalk build', ...headers };
  if (new URL(url).origin === 'https://api.github.com' && token) result.Authorization = `Bearer ${token}`;
  return result;
}
module.exports = { buildDownloadHeaders };
