import test from "node:test";
import assert from "node:assert/strict";
import { runChatCoordinator } from "../dist/chatCoordinator.js";

test("quota HTTP 429 activates temporary circuit breaker instead of flooding Gemini", async()=>{
  const prev = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async()=>{
    requests++;
    return new Response(JSON.stringify({error:{message:"quota exceeded"}}),{
      status:429,headers:{"retry-after":"60","content-type":"application/json"},
    });
  };
  const p={
    text:"Oi, gostaria de ver o cardápio",history:[],snapshot:{},apiKey:"gemini-test",
    model:"gemini-test-model",sessionId:"tenant-quota",
    log:{warn(){}},execute:async()=>{throw Error("No tools should execute")},
  };
  try {
    assert.equal(await runChatCoordinator(p),null);
    assert.equal(await runChatCoordinator({...p,text:"Quero pedir agora"}),null);
    assert.equal(requests,1,"429 must not trigger additional provider calls within retry window");
  }finally{globalThis.fetch=prev}
});
