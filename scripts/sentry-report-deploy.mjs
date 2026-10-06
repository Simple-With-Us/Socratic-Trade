// Production evidence reporter.  No deployment triggers and no third-party dependencies.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFIG = Object.freeze({"project": "socratic-trade", "health": "https://socratictrade.com/api/health", "repositoryId": "1270451796", "repository": "Simple-With-Us/Socratic-Trade"});
const API = 'https://sentry.io/api/0/organizations/simple-with-us/';
const SHA = /^[0-9a-f]{40}$/;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

export function readIdentity(body) {
  if (body?.ok !== true) throw new Error('Production health is not ready');

  const revision = body.checks?.release?.sha;
  if (typeof revision !== 'string' || !SHA.test(revision)) throw new Error('Production did not expose a full source SHA');
  return revision;
}

export function gitAncestry(ancestor, descendant, spawn = spawnSync) {
  if (!SHA.test(ancestor) || !(SHA.test(descendant) || descendant === 'refs/remotes/origin/main')) return false;
  const result = spawn('git', ['merge-base', '--is-ancestor', ancestor, descendant], { stdio: 'ignore', timeout: 30000 });
  if (result.error || ![0, 1].includes(result.status)) throw new Error('Git ancestry execution failed');
  return result.status === 0;
}

export async function observeProduction({ expected, fetchImpl = fetch, sleep = pause,
  isAncestor = gitAncestry, refreshMain = () => execFileSync('git', ['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main'], { stdio: 'ignore', timeout: 30000 }),
  attempts = 75, intervalMs = 20000, now = Date.now } = {}) {
  if (!SHA.test(expected || '')) throw new Error('Expected CI revision must be a full SHA');
  const deadline = now() + 25 * 60 * 1000;
  let prior = null;
  let reason = 'No healthy live revision observed';
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (now() >= deadline) break;
    // Refresh every observation: a newer deployed main revision can supersede this CI run.
    let expectedOnMain;
    try {
      refreshMain();
      expectedOnMain = isAncestor(expected, 'refs/remotes/origin/main');
    } catch {
      prior = null;
      reason = 'Unable to refresh or evaluate main ancestry';
      if (attempt + 1 < attempts && now() < deadline) await sleep(Math.min(intervalMs, deadline - now()));
      continue;
    }
    if (!expectedOnMain) throw new Error('Expected revision is no longer on main');
    try {
      const url = new URL(CONFIG.health);
      url.searchParams.set('sentry-deploy-probe', `${now()}-${attempt}`);
      const response = await fetchImpl(url, { redirect: 'error', cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache', Accept: 'application/json' },
        signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Production health returned HTTP ${response.status}`);
      if (Number(response.headers.get('age') || 0) > 0 || /^(HIT|STALE|UPDATING)$/i.test(response.headers.get('cf-cache-status') || '')) {
        throw new Error('Production health response was cached');
      }
      const observed = readIdentity(await response.json());
      if (!isAncestor(observed, 'refs/remotes/origin/main')) throw new Error('Observed revision is not on main');
      if (!isAncestor(expected, observed)) throw new Error('Production has not deployed this CI revision or a successor');
      // Two independent uncached observations reduce rollout/routing race false positives.
      if (prior === observed) return { revision: observed, confirmedAt: new Date(now()).toISOString(), superseded: observed !== expected };
      prior = observed;
      reason = 'Waiting for a second healthy observation of the same revision';
    } catch (error) {
      prior = null;
      // Network/parser errors may contain endpoint internals; only our own static reasons are logged.
      reason = error.message?.startsWith('Production ') || error.message?.startsWith('Observed ') || error.message === 'Git ancestry execution failed' ? error.message : 'Production health request or JSON parsing failed';
    }
    if (attempt + 1 < attempts && now() < deadline) await sleep(Math.min(intervalMs, deadline - now()));
  }
  throw new Error(`Deployment not confirmed within the bounded observation window: ${reason}`);
}

export async function reportDeploy(receipt, { token, repositoryId, runId, attribution, fetchImpl = fetch } = {}) {
  if (!token?.trim()) throw new Error('SENTRY_AUTH_TOKEN is required');
  if (String(repositoryId) !== CONFIG.repositoryId) throw new Error('GitHub stable repository ID does not match the configured app');
  if (!SHA.test(receipt?.revision || '') || !Number.isFinite(Date.parse(receipt?.confirmedAt)) || !/^\d+$/.test(runId || '')) throw new Error('Invalid verified deployment receipt');
  async function request(method, path, body, allowMissing = false, page = false) {
    let response;
    try {
      response = await fetchImpl(`${API}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new Error(`Sentry ${method} request failed; inspect outcome before rerunning`); }
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`Sentry ${method} failed (HTTP ${response.status})`);
    try {
      const data = await response.json();
      return page ? { data, link: response.headers.get('link') || '' } : data;
    } catch { throw new Error('Sentry returned invalid JSON'); }
  }
  async function list(path) {
    const items = [];
    for (let page = 0; page < 20; page++) {
      const result = await request('GET', path, undefined, false, true);
      if (!Array.isArray(result.data)) throw new Error('Sentry returned an invalid paginated list');
      items.push(...result.data);
      const next = result.link.split(',').find((part) => /rel="next"/.test(part) && /results="true"/.test(part));
      if (!next) return items;
      const nextUrl = new URL(next.match(/<([^>]+)>/)?.[1] || 'invalid', API);
      // Never forward the token outside this exact organization's API surface.
      if (!nextUrl.href.startsWith(API) || nextUrl.pathname !== new URL(path, API).pathname) throw new Error('Sentry pagination target is not trusted');
      path = nextUrl.href.slice(API.length);
    }
    throw new Error('Sentry pagination limit reached; refusing an incomplete idempotence check');
  }
  // Repository names survive transfers in Sentry.  Bind to stable GitHub ID first.
  const repositories = await list(`repos/?query=${encodeURIComponent(CONFIG.repository.split('/')[1])}&status=active&per_page=100`);
  const matches = Array.isArray(repositories) ? repositories.filter((repo) => String(repo.externalId) === CONFIG.repositoryId && repo.status === 'active') : [];
  if (matches.length !== 1 || !matches[0].name) throw new Error('Sentry repository must uniquely match the stable GitHub repository ID');
  const version = receipt.revision;
  const releasePath = `releases/${version}/`;
  const existing = await request('GET', releasePath, undefined, true);
  if (!existing) throw new Error('The verified SHA has no existing Sentry bundler release; refusing to invent a parallel release');
  if (existing && (existing.version !== version || (existing.ref && existing.ref !== version) || !Array.isArray(existing.projects) || existing.projects.length !== 1 || existing.projects[0].slug !== CONFIG.project)) throw new Error('Existing Sentry release identity/project conflicts with the verified runtime');
  const metadata = { ref: version, refs: [{ repository: matches[0].name, commit: version }], url: `https://github.com/${CONFIG.repository}/commit/${version}` };
  // Existing bundler releases (including their sourcemaps) are updated, never replaced.
  await request(existing ? 'PUT' : 'POST', existing ? releasePath : 'releases/', existing ? metadata : { ...metadata, version, projects: [CONFIG.project], dateReleased: receipt.confirmedAt });
  const deploys = await list(`${releasePath}deploys/`);
  if (!Array.isArray(deploys)) throw new Error('Sentry returned an invalid deployment list');
  // DeploySerializer caps names at 64 characters; the release already carries the full SHA.
  const name = attribution ? `production seat:${attribution.seat.slice(0, 24)} pr:#${attribution.number}` : `production:${version}`;
  if (name.length > 64) throw new Error('Deployment attribution exceeds the Sentry name limit');
  // Deduplicate older reporter names too: the key is actual release + environment.
  const previous = deploys.find((deploy) => deploy.environment === 'production');
  if (previous && !previous.id) throw new Error('Existing deployment has no valid receipt ID');
  if (previous) return { version, deployId: previous.id, alreadyRecorded: true };
  // No retries for ambiguous writes.  A manual rerun checks the existing receipt first.
  const deploy = await request('POST', `${releasePath}deploys/`, { name, environment: 'production', projects: [CONFIG.project], dateFinished: receipt.confirmedAt,
    url: `https://github.com/${CONFIG.repository}/actions/runs/${runId}` });
  if (!deploy?.id) throw new Error('Sentry did not return a deployment receipt');
  return { version, deployId: deploy.id, alreadyRecorded: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.env.SENTRY_AUTH_TOKEN?.trim()) throw new Error('SENTRY_AUTH_TOKEN is required');
    const receipt = await observeProduction({ expected: process.env.EXPECTED_SHA });
    const result = await reportDeploy(receipt, { token: process.env.SENTRY_AUTH_TOKEN, repositoryId: process.env.GITHUB_REPOSITORY_ID, runId: process.env.GITHUB_RUN_ID });
    const summary = `Production health and Sentry deployment reporting confirmed.${result.alreadyRecorded ? '  A matching deployment receipt already exists.' : '  A new deployment receipt was recorded.'}${receipt.superseded ? '  The triggering CI revision was superseded; only the observed live revision was reported.' : ''}\n`;
    console.log(`Verified production source SHA: ${receipt.revision}`);
    console.log(summary.trim());
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
