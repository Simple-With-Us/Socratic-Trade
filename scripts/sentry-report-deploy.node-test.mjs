import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, readIdentity, observeProduction, reportDeploy } from './sentry-report-deploy.mjs';
const old = '1'.repeat(40), expected = '2'.repeat(40), newer = '3'.repeat(40), foreign = '4'.repeat(40);
const healthy = (revision) => ({ ok: true, status: 'live', environment: 'production', revision, build: { sha: revision }, checks: { release: { sha: revision } } });
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const isAncestor = (a, b) => b === 'refs/remotes/origin/main' ? [old, expected, newer].includes(a) : a === b || a === expected && b === newer;
const observe = (values, options = {}) => {
  let i = 0;
  return observeProduction({ expected, attempts: values.length, intervalMs: 0, sleep: async () => {}, refreshMain: () => {}, isAncestor,
    fetchImpl: async (url, init) => { assert.equal(url.origin, new URL(CONFIG.health).origin); assert.equal(init.headers.Authorization, undefined); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store'); const value = values[i++]; return value instanceof Response ? value : json(healthy(value)); }, ...options });
};
test('requires healthy, full source identity', () => {
  assert.equal(readIdentity(healthy(expected)), expected);
  for (const body of [null, {ok:false}, healthy('unknown'), healthy(expected.slice(0,12))]) assert.throws(() => readIdentity(body));
  if (CONFIG.project === 'usage-monitor') assert.throws(() => readIdentity({...healthy(expected), environment:'development'}));
});
test('requires two stable healthy uncached observations', async () => { assert.equal((await observe([old,expected,expected])).revision, expected); });
test('reports actual newer deployment instead of its CI ancestor', async () => { const result = await observe([newer,newer]); assert.equal(result.revision,newer); assert.equal(result.superseded,true); });
test('older, unknown and foreign revisions never become deployment evidence', async () => { for (const value of [old,foreign,'unknown']) await assert.rejects(observe([value,value]), /Deployment not confirmed/); });
test('mixed rollout revisions need stabilization', async () => { await assert.rejects(observe([expected,newer,expected]), /Deployment not confirmed/); });
test('unhealthy, cached or invalid JSON reset stabilization', async () => {
  for (const invalid of [json({ok:false},503),json(healthy(expected),200,{age:'20'}),json(healthy(expected),200,{'cf-cache-status':'HIT'}),new Response('not json')]) {
    await assert.rejects(observe([expected,invalid,expected]), /Deployment not confirmed/);
  }
});
test('network errors are bounded and never leaked', async () => { await assert.rejects(observe(['unused'],{ fetchImpl:async()=>{throw Error('secret details')} }), (e)=> !e.message.includes('secret details')); });
test('force-pushed expected revision fails closed', async () => { await assert.rejects(observe([expected], {isAncestor:()=>false}), /no longer on main/); });
const receipt = {revision:newer,confirmedAt:'2026-10-06T08:00:00.000Z'};
function service({ existing = true, deploys = [], repoId = CONFIG.repositoryId, failure, conflict = false } = {}) {
  const calls=[];
  const fetchImpl = async (url, init) => {
    calls.push({url,method:init.method,body:init.body && JSON.parse(init.body)});
    assert.ok(url.startsWith('https://sentry.io/api/0/organizations/simple-with-us/'));
    assert.equal(init.redirect,'error');
    if (failure === `${init.method} deploy` && url.endsWith('/deploys/')) return json({},503);
    if (url.includes('/repos/?')) return json([{externalId:repoId,name:'old-owner/repo',status:'active'}]);
    if (url.endsWith('/deploys/')) return json(init.method==='GET'?deploys:{id:'42'});
    if (init.method==='GET') return existing ? json({version:newer,ref:conflict?old:newer,projects:[{slug:CONFIG.project}]}) : json({},404);
    return json({version:newer});
  };
  return {calls,fetchImpl};
}
const report = (fetchImpl,extra={})=>reportDeploy(receipt,{token:'test-only',repositoryId:CONFIG.repositoryId,runId:'123',fetchImpl,sleep:async()=>{},...extra});
test('missing token or wrong stable GitHub ID refuses all API writes', async () => {
  const s=service(); await assert.rejects(report(s.fetchImpl,{token:''}), /required/); await assert.rejects(report(s.fetchImpl,{repositoryId:'999'}), /repository ID/); assert.equal(s.calls.length,0);
});
test('matches Sentry stable ID before refs using its current configured name', async()=>{
 const s=service(); const result=await report(s.fetchImpl); assert.equal(result.version,newer);
 const put=s.calls.find(c=>c.method==='PUT'); assert.equal(put.body.refs[0].repository,'old-owner/repo'); assert.equal(put.body.refs[0].commit,newer); assert.equal(put.body.dateReleased,undefined);
 assert.equal(s.calls.filter(c=>c.method==='POST').length,1);
});
test('rejects a mismatched Sentry repository or release ref', async()=>{for(const opts of [{repoId:'999'},{conflict:true}]) {const s=service(opts); await assert.rejects(report(s.fetchImpl)); assert.ok(s.calls.every(c=>c.method==='GET'));}});
test('only explicitly SHA-wired Deno runtime may create a missing release', async()=>{const s=service({existing:false}); if(CONFIG.project !== 'congress-trade') { await assert.rejects(report(s.fetchImpl), /refusing to invent/); assert.ok(s.calls.every(c=>c.method==='GET')); return; } await report(s.fetchImpl); const creates=s.calls.filter(c=>c.method==='POST'); assert.equal(creates.length,2); assert.deepEqual(creates[0].body.projects,[CONFIG.project]); assert.equal(creates[0].body.version,newer);});
test('deduplicates by actual release/environment including legacy names',async()=>{const s=service({deploys:[{id:'old-id',environment:'production',name:'seat:codex pr:#1'}]}); const r=await report(s.fetchImpl); assert.equal(r.alreadyRecorded,true); assert.ok(!s.calls.some(c=>c.method==='POST'));});
test('reporting errors fail visibly without duplicate write retry',async()=>{const s=service({failure:'POST deploy'}); await assert.rejects(report(s.fetchImpl), /HTTP 503/); assert.equal(s.calls.filter(c=>c.method==='POST').length,1);});
test('ambiguous writes never retry or leak response errors',async()=>{const s=service();const fetchImpl=async(url,init)=>{if(init.method==='POST') throw Error('secret details');return s.fetchImpl(url,init)};await assert.rejects(report(fetchImpl), /inspect outcome/);});
test('pagination finds an older production deployment without posting again',async()=>{
 const s=service(); let pages=0;
 const fetchImpl=async(url,init)=>{
  if(url.includes('/deploys/')) {pages++;return pages===1?json([{environment:'staging'}],200,{link:`<https://sentry.io/api/0/organizations/simple-with-us/releases/${newer}/deploys/?cursor=next>; rel="next"; results="true"`}):json([{id:'old-prod',environment:'production'}]);}
  return s.fetchImpl(url,init);
 };const result=await report(fetchImpl);assert.equal(result.deployId,'old-prod');assert.equal(pages,2);assert.ok(!s.calls.some(c=>c.method==='POST'));
});
test('untrusted Sentry pagination cannot forward the token',async()=>{
 let calls=0;await assert.rejects(report(async()=>{calls++;return json([],200,{link:'<https://evil.invalid/steal>; rel="next"; results="true"'});}),/not trusted/);assert.equal(calls,1);
});

test('build release matches a full source SHA, independent of git metadata',async()=>{
 const {sentryBuildRelease}=await import('./sentry-build-release.cjs');
 assert.equal(sentryBuildRelease({SOURCE_COMMIT:newer,GIT_COMMIT_SHA:expected,SENTRY_RELEASE:'unrelated'}),newer);
 assert.equal(sentryBuildRelease({}),undefined);
 assert.equal(sentryBuildRelease({SOURCE_COMMIT:'unknown'}),undefined);
 assert.equal(sentryBuildRelease({SOURCE_COMMIT:newer.slice(0,12)}),undefined);
});
test('Next build config wires explicit Sentry release identity',async()=>{
 const {readFileSync}=await import('node:fs');
 const config=readFileSync(new URL('../next.config.mjs',import.meta.url),'utf8');
 assert.match(config,/release:\s*\{ name: sentryBuildRelease\(\) \}/);
 const docker=readFileSync(new URL('../Dockerfile',import.meta.url),'utf8');
 const builder=docker.split(/FROM .* AS runtime/)[0];
 assert.match(builder,/ARG SOURCE_COMMIT=/);
 assert.match(builder,/SOURCE_COMMIT=\$\{SOURCE_COMMIT\}/);
 assert.ok(builder.indexOf('SOURCE_COMMIT=${SOURCE_COMMIT}')<builder.lastIndexOf('npm run build'));
});

test('git ancestry distinguishes divergence from execution failures',async()=>{
 const {gitAncestry}=await import('./sentry-report-deploy.mjs');
 assert.equal(gitAncestry(expected,newer,()=>({status:0})),true);
 assert.equal(gitAncestry(expected,newer,()=>({status:1})),false);
 for(const result of [{status:null},{status:128},{status:1,error:new Error('spawn failed')}]) assert.throws(()=>gitAncestry(expected,newer,()=>result),/execution failed/);
});
test('transient refresh failures retry without using stale ancestry',async()=>{
 let calls=0;const r=await observe([expected,expected],{attempts:3,refreshMain:()=>{if(++calls===1)throw Error('temporary network failure');}});
 assert.equal(r.revision,expected);assert.equal(calls,3);
});
test('persistent ancestry errors fail within bounded observation window',async()=>{
 await assert.rejects(observe([expected,expected],{isAncestor:()=>{throw Error('execution failure')}}),/Unable to refresh or evaluate main ancestry/);
});

test('ST build identity skips placeholders but preserves health precedence',async()=>{
 const {sentryBuildRelease}=await import('./sentry-build-release.cjs');
 assert.equal(sentryBuildRelease({APP_RELEASE_SHA:'unknown',SOURCE_COMMIT:newer}),newer);
 assert.equal(sentryBuildRelease({APP_RELEASE_SHA:expected,SOURCE_COMMIT:newer}),expected);
 assert.equal(sentryBuildRelease({APP_RELEASE_SHA:expected.slice(0,12),SOURCE_COMMIT:newer}),undefined);
});

test('release lookup retries a confirmed 404 visibility race, then writes once',async()=>{
 const s=service();let reads=0;const pauses=[];
 const fetchImpl=async(url,init)=>{
  if(init.method==='GET' && url.endsWith(`/releases/${newer}/`) && ++reads===1)return json({},404);
  return s.fetchImpl(url,init);
 };
 await report(fetchImpl,{sleep:async(ms)=>pauses.push(ms)});
 assert.equal(reads,2);assert.deepEqual(pauses,[10000]);
 assert.equal(s.calls.filter(c=>c.method==='PUT').length,1);
 assert.equal(s.calls.filter(c=>c.method==='POST').length,1);
});
test('persistent missing release lookup is bounded and makes no writes',async()=>{
 const s=service({existing:false});const pauses=[];
 await assert.rejects(report(s.fetchImpl,{sleep:async(ms)=>pauses.push(ms)}),/after bounded lookup/);
 assert.equal(s.calls.filter(c=>c.url.endsWith(`/releases/${newer}/`)).length,6);
 assert.deepEqual(pauses,[10000,10000,10000,10000,10000]);
 assert.ok(s.calls.every(c=>c.method==='GET'));
});
test('release authentication errors are not retried',async()=>{
 const s=service();let reads=0;let pauses=0;
 const fetchImpl=async(url,init)=>{
  if(init.method==='GET' && url.endsWith(`/releases/${newer}/`)){reads++;return json({},401);}
  return s.fetchImpl(url,init);
 };
 await assert.rejects(report(fetchImpl,{sleep:async()=>pauses++}),/HTTP 401/);
 assert.equal(reads,1);assert.equal(pauses,0);assert.ok(s.calls.every(c=>c.method==='GET'));
});
test('a null JSON release is invalid data, not a retryable 404',async()=>{
 const s=service();let reads=0;let pauses=0;
 const fetchImpl=async(url,init)=>{
  if(init.method==='GET' && url.endsWith(`/releases/${newer}/`)){reads++;return json(null);}
  return s.fetchImpl(url,init);
 };
 await assert.rejects(report(fetchImpl,{sleep:async()=>pauses++}),/identity\/project conflicts/);
 assert.equal(reads,1);assert.equal(pauses,0);assert.ok(s.calls.every(c=>c.method==='GET'));
});
