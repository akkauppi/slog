import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('new offline shell bypasses the previous release HTTP cache and preserves firmware recovery',async()=>{
 const source=fs.readFileSync(new URL('../../portal/service-worker.js',import.meta.url),'utf8');
 const revision=source.match(/APP_SHELL_REVISION = "([a-f0-9]+)"/)[1];
 const handlers=new Map(),opened=[],deleted=[];let requests;
 const oldCache=`sauna-commissioning-${revision}`;
 const newCache=`sauna-commissioning-v2-${revision}`;
 const recovery='sauna-firmware-recovery-v1-existing';
 vm.runInNewContext(source,{
  URL,Request,
  self:{registration:{scope:'https://example.test/slog/'},location:{origin:'https://example.test'},
   clients:{claim:async()=>{}},addEventListener:(name,fn)=>handlers.set(name,fn)},
  caches:{open:async name=>{opened.push(name);return {addAll:async values=>{requests=values;}};},
   keys:async()=>[oldCache,newCache,recovery],delete:async name=>{deleted.push(name);return true;}},
 });
 let work;
 handlers.get('install')({waitUntil:promise=>{work=promise;}});await work;
 assert.deepEqual(opened,[newCache]);
 assert.ok(requests.length>20);
 assert.ok(requests.every(request=>request.cache==='reload'),'fresh HTTP-cache entries from the old release must be bypassed');
 assert.ok(requests.some(request=>request.url==='https://example.test/slog/js/radio-ui.js'));
 assert.ok(requests.some(request=>request.url.endsWith('/session-7.slog')));
 handlers.get('activate')({waitUntil:promise=>{work=promise;}});await work;
 assert.deepEqual(deleted,[oldCache]);
});
