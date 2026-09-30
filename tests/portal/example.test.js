import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {parseSlog,buildRun} from '../../portal/js/log-analysis.js';

test('public electric-sauna example preserves its CRC-valid raw chain and unknown gaps',()=>{
 const root=new URL('../../portal/examples/preheated-electric-sauna/',import.meta.url);
 const metadata=JSON.parse(fs.readFileSync(new URL('metadata.json',root)));
 const sessions=metadata.segments.map(entry=>{
  const bytes=fs.readFileSync(new URL(entry.file,root));
  assert.equal(bytes.length,entry.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256);
  const session=parseSlog(bytes);assert.equal(session.sessionId,entry.session_id);assert.deepEqual(session.warnings,[]);
  return session;
 });
 assert.deepEqual(sessions.map(s=>s.samples.length),[16,4,364]);
 const run=buildRun(sessions);
 assert.equal(run.breaks.length,2);
 assert.ok(run.breaks.every(gap=>gap.durationSeconds===null));
 assert.equal(metadata.heating,'electric');
 assert.equal(metadata.useful_from_approx_minutes,15);
});
