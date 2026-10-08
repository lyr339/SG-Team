import test from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { once } from 'node:events';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { createWireTypes } from './wire-types.mjs';
import { encodeEnvelope,FrameDecoder } from './wire-framing.mjs';
import { WireStore } from './wire-store.mjs';
import { runWire } from './wire-client.mjs';

test('incremental Connect parser accepts byte-fragmented gzip and rejects truncation/invalid terminal',()=>{
  const original=Buffer.from('OK'),packet=Buffer.concat([encodeEnvelope(original,{compress:true}),encodeEnvelope(Buffer.from('{}'),{end:true})]),parser=new FrameDecoder({compression:'gzip'}),frames=[];
  for(const byte of packet)frames.push(...parser.push(Buffer.from([byte])));
  parser.finish();assert.equal(frames.length,2);assert.deepEqual(frames[0].payload,original);
  assert.throws(()=>parser.push(Buffer.from([0])),/after EndStream/);
  const missing=new FrameDecoder();missing.push(Buffer.from([0,0,0]));assert.throws(()=>missing.finish(),/Truncated/);
  assert.throws(()=>new FrameDecoder().push(encodeEnvelope(original,{compress:true})),/Unsupported/);
});

test('owned wire runtime keeps request writable, serves KV, persists checkpoint and resumes without Cursor',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'cursor-wire-test-')),types=createWireTypes(),blob=Buffer.from('mock conversation state'),id=createHash('sha256').update(blob).digest();
  const store=new WireStore(directory,{accountScope:'test-account',conversationId:randomUUID()});store.setBlob(id,blob);
  const server=http2.createServer();let rounds=0;const failures=[];
  server.on('stream',stream=>{
    stream.respond({':status':200,'content-type':'application/connect+proto','connect-content-encoding':'gzip'});
    const parser=new FrameDecoder();let initial,gotRead=false,gotWrite=false;
    const send=object=>{const packet=encodeEnvelope(new types.Server(object).toBinary(),{compress:true});for(let n=0;n<packet.length;n+=3)stream.write(packet.subarray(n,n+3));};
    stream.on('data',chunk=>{
      try{for(const frame of parser.push(chunk)){
        const message=types.Client.fromBinary(frame.payload);
        if(message.message.case==='runRequest'){
          initial=message.message.value;rounds++;
          assert.equal(initial.action.action.value.userMessage.mode,2);
          assert.equal(initial.conversationState.turns.length,rounds-1);
          send({message:{case:'kvServerMessage',value:{id:1,message:{case:'getBlobArgs',value:{blobId:id}}}}});
        }else if(message.message.case==='kvClientMessage'){
          const data=message.message.value;
          if(data.id===1){assert.equal(data.message.case,'getBlobResult');assert.deepEqual(Buffer.from(data.message.value.blobData),blob);gotRead=true;send({message:{case:'kvServerMessage',value:{id:2,message:{case:'setBlobArgs',value:{blobId:id,blobData:blob}}}}});}
          if(data.id===2){assert.equal(data.message.case,'setBlobResult');gotWrite=true;
            send({message:{case:'interactionUpdate',value:{message:{case:'textDelta',value:{text:'OK'}}}}});
            send({message:{case:'interactionUpdate',value:{message:{case:'turnEnded',value:{inputTokens:1000n,outputTokens:3n,cacheReadTokens:500n,cacheWriteTokens:0n,reasoningTokens:1n,endedAtMs:BigInt(Date.now())}}}}});
            send({message:{case:'conversationCheckpointUpdate',value:{turns:Array(rounds).fill(id),mode:2,recentUserMessageIds:[initial.action.action.value.userMessage.messageId]}}});
            stream.end(encodeEnvelope(Buffer.from('{}'),{end:true}));
          }
        }
      }}catch(error){failures.push(error);stream.close();}
    });
    stream.on('end',()=>{try{parser.finish({requireEnd:false});assert.ok(gotRead&&gotWrite)}catch(error){failures.push(error)}});
    stream.on('error',()=>{});
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const baseUrl=`http://127.0.0.1:${server.address().port}`;
    const first=await runWire({baseUrl,types,store,text:'Reply only OK.',timeoutMs:5000,heartbeatMs:20});
    assert.equal(first.text,'OK');assert.equal(first.kvGets,1);assert.equal(first.kvSets,1);assert.equal(first.usage.input_tokens,1000);
    const reopened=new WireStore(directory,{accountScope:'test-account'});
    const second=await runWire({baseUrl,types,store:reopened,text:'Again, reply only OK.',timeoutMs:5000});
    assert.equal(second.priorTurns,1);assert.equal(second.text,'OK');assert.equal(reopened.metadata.runs.length,2);assert.equal(failures.length,0);
    assert.throws(()=>new WireStore(directory,{accountScope:'other'}),/mismatch/);
    assert.throws(()=>store.setBlob(id,Buffer.from('wrong')),/SHA-256/);
  }finally{server.close();rmSync(directory,{recursive:true,force:true});}
});

test('a HTTP200 quota EndStream is an error and is never automatically retried',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'cursor-wire-error-')),store=new WireStore(directory,{accountScope:'mock',conversationId:randomUUID()}),server=http2.createServer();let starts=0;
  server.on('stream',stream=>{starts++;stream.respond({':status':200,'content-type':'application/connect+proto'});stream.on('data',()=>{});stream.end(encodeEnvelope(Buffer.from('{"error":{"code":"resource_exhausted","message":"quota"}}'),{end:true}));stream.on('error',()=>{});});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{await assert.rejects(runWire({baseUrl:`http://127.0.0.1:${server.address().port}`,store,text:'OK',timeoutMs:5000}),error=>error.code==='resource_exhausted');assert.equal(starts,1);assert.equal(store.metadata.runs.length,0);}
  finally{server.close();rmSync(directory,{recursive:true,force:true});}
});

async function mockRun(handler,execute){
  const directory=mkdtempSync(join(tmpdir(),'sg-wire-boundary-')),types=createWireTypes(),store=new WireStore(directory,{accountScope:'mock',conversationId:randomUUID()}),server=http2.createServer();
  server.on('stream',stream=>{stream.on('error',()=>{});stream.respond({':status':200,'content-type':'application/connect+proto'});stream.on('data',()=>{});handler(stream,types)});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{await execute({directory,store,types,baseUrl:`http://127.0.0.1:${server.address().port}`});}finally{server.close();rmSync(directory,{recursive:true,force:true});}
}
test('checkpoint staged before a rejected/partial stream never advances the committed conversation',async()=>{
  await mockRun((stream,types)=>{
    stream.write(encodeEnvelope(new types.Server({message:{case:'conversationCheckpointUpdate',value:{mode:2}}}).toBinary()));
    stream.end(encodeEnvelope(Buffer.from('{"error":{"code":"permission_denied","message":"denied"}}'),{end:true}));
  },async options=>{await assert.rejects(runWire({...options,text:'OK'}),error=>error.code==='permission_denied');assert.equal(options.store.checkpoint(),null);assert.equal(options.store.metadata.runs.length,0)});
});
test('remote EOF without protocol EndStream/turn confirmation is not a successful answer',async()=>{
  await mockRun((stream,types)=>{stream.end(encodeEnvelope(new types.Server({message:{case:'interactionUpdate',value:{message:{case:'textDelta',value:{text:'partial'}}}}}).toBinary()))},async options=>{
    await assert.rejects(runWire({...options,text:'OK'}),/Missing/);assert.equal(options.store.metadata.runs.length,0);
  });
});
test('cancellation and timeouts each stop once and do not commit or retry',async()=>{
  let starts=0;
  await mockRun(()=>{starts++},async options=>{
    const controller=new AbortController();const pending=runWire({...options,text:'OK',signal:controller.signal,timeoutMs:1000});setTimeout(()=>controller.abort(),30);
    await assert.rejects(pending,error=>error.code==='cancelled');assert.equal(starts,1);assert.equal(options.store.metadata.runs.length,0);
    await assert.rejects(runWire({...options,text:'OK',timeoutMs:30}),error=>error.code==='deadline_exceeded');assert.equal(starts,2);
  });
});
test('Ask executor safely refuses real VM commands, never executes them, and never saves a success',async()=>{
  await mockRun((stream,types)=>{stream.write(encodeEnvelope(new types.Server({message:{case:'interactionQuery',value:{id:1,query:{case:'setupVmEnvironmentArgs',value:{installCommand:'echo forbidden'}}}}}).toBinary()))},async options=>{
    await assert.rejects(runWire({...options,text:'OK'}),error=>error.code==='unsupported');assert.equal(options.store.metadata.runs.length,0);
  });
});
test('pre-aborted runs never transmit and changed on-disk blobs are refused',async()=>{
  let starts=0;
  await mockRun(()=>starts++,async options=>{
    const controller=new AbortController();controller.abort();await assert.rejects(runWire({...options,text:'OK',signal:controller.signal}),error=>error.code==='cancelled');assert.equal(starts,0);
    const blob=Buffer.from('owned'),id=createHash('sha256').update(blob).digest();options.store.setBlob(id,blob);
    const {writeFileSync}=await import('node:fs');writeFileSync(options.store.blobPath(id),'tampered');assert.throws(()=>options.store.getBlob(id),/SHA-256/);
  });
});
