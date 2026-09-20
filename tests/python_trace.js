const fs=require('fs'),path=require('path'),os=require('os'),assert=require('node:assert/strict');
const {spawn}=require('child_process');
(async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'python-trace-')),state=path.join(tmp,'state'),ready=path.join(tmp,'port');
  const server=spawn('python3',[path.join(__dirname,'python_trace_fixture.py'),state,ready],{stdio:['ignore','ignore','pipe']});
  let log='';server.stderr.on('data',d=>log+=d);
  try {
    for(let i=0;i<100&&!fs.existsSync(ready);i++)await new Promise(r=>setTimeout(r,50));
    assert(fs.existsSync(ready),log);
    const base='http://127.0.0.1:'+fs.readFileSync(ready,'utf8');
    const child=spawn(process.execPath,[path.join(__dirname,'../pw_trace.js'),'python-confirm',base,'--python-trace'],
      {env:{...process.env,TRACEKIT_STATE_DIR:state,TRACE_OUT_DIR:tmp,ODOO_TASK:'',ODOO_SESSION_ID:'',ODOO_DB:''},stdio:['pipe','pipe','pipe']});
    child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
    child.stdin.end(`eval fetch('/web/dataset/call_kw',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'call',params:{model:'fixture.model',method:'action_test',args:[],kwargs:{}}})}).then(r=>r.json()).then(r=>{if(r.result!==7)throw new Error('Wrong result')})\ndone\n`);
    const code=await new Promise(r=>child.on('close',r));assert.equal(code,0,log);
    const report=JSON.parse(fs.readFileSync(path.join(tmp,fs.readdirSync(tmp).find(f=>f.endsWith('.result.json')))));
    const req=report.runtime.requests[0];assert.equal(req.python_trace.status,'captured',JSON.stringify(report));
    assert.equal(req.python_trace.request_id,req.request_id);assert.equal(req.python_trace.step_id,report.steps[0].step_id);
    assert.equal(req.python_trace.calls.length,2);assert.equal(req.python_trace.calls[1].parent_id,1);
    assert.equal(report.runtime.python_trace.matched_requests,1);
    assert(req.python_trace.calls.every(c=>c.duration_ms>=0));
    console.log('PASS browser → signed RPC → real Python override/super calls → persisted run report');
  }finally{server.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
