const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { attachRuntimeEvidence } = require('../runtime-evidence');
const request = (url,params={}) => ({url:()=>url,method:()=> 'POST',postDataJSON:()=>({jsonrpc:'2.0',params}),failure:()=>({errorText:'connection lost'})});
const response = (req,body,headers={}) => ({request:()=>req,status:()=>200,ok:()=>true,headers:()=>headers,body:async()=>Buffer.from(JSON.stringify(body))});
(async()=>{
  let ctx=new EventEmitter(), report={run_id:'fixture'};
  let capture=attachRuntimeEvidence(ctx,report,()=>({step_id:'step-1',line:2}),'http://example.test');
  ctx.emit('request',request('https://foreign.test/rpc'));
  const auth=request('http://example.test/web/session/authenticate',{login:'alice',password:'secret'});
  ctx.emit('request',auth);
  ctx.emit('response',response(auth,{error:{data:{message:'secret',debug:'secret traceback'}}}));
  await capture.finish();
  assert.equal(report.runtime.requests.length,1);
  assert(!JSON.stringify(report).includes('secret'));
  assert.equal(report.runtime.requests[0].status,'rpc_error');
  assert.equal(ctx.listenerCount('request'),0);

  ctx=new EventEmitter();report={run_id:'limits'};
  capture=attachRuntimeEvidence(ctx,report,()=>null,'http://example.test');
  const large=request('http://example.test/rpc');
  ctx.emit('request',large);ctx.emit('response',response(large,{}, {'content-length':'1048577'}));
  for(let i=0;i<500;i++) {
    const req=request('http://example.test/rpc');ctx.emit('request',req);ctx.emit('requestfailed',req);
  }
  await capture.finish();
  assert.equal(report.runtime.requests.length,500);
  assert.equal(report.runtime.dropped_requests,1);
  assert.match(report.runtime.requests[0].capture_note,/exceeds/);
  assert.equal(report.runtime.requests[0].status,'response_unavailable');

  ctx=new EventEmitter();report={run_id:'incomplete'};
  capture=attachRuntimeEvidence(ctx,report,()=>null,'http://example.test');
  ctx.emit('request',request('http://example.test/rpc'));
  await capture.finish();
  assert.equal(report.runtime.requests[0].status,'incomplete');
  assert.equal(report.runtime.requests[0].step_id,null);
  console.log('PASS runtime capture: authentication redaction, origin scope, limits, shutdown and incomplete responses');
})().catch(e=>{console.error(e);process.exitCode=1;});
