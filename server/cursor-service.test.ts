import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CursorAdapter, parseCursorUsage } from "./cursor";
import { Service } from "./service";
import { FAMILIES } from "../shared/model";
import { StateStore, StoredAccountSchema } from "./state";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cursor-service-")); vi.stubEnv("PASEO_HOME", root); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

async function setup() {
 const adapter = new CursorAdapter();
 const home = join(root, "homes", "cursor-second");
 await adapter.prepareHome(home);
 const login = await adapter.login(home,"code"); await login.submitCode("test-key-second");
 const store = new StateStore(join(root,"state.json"));
 const account = (id: string, kind: "managed"|"main") => StoredAccountSchema.parse({ id, family:"cursor", label:id, kind, home:kind === "managed" ? home : null, createdAt:new Date().toISOString() });
 await store.update(d => {d.accounts=[account("cursor-main","main"),account("cursor-second","managed")]; d.defaults.cursor="cursor-second";});
 const cursor = Object.assign(Object.create(adapter) as CursorAdapter, { usageSpacingMs: 0,
   usage: async () => parseCursorUsage({planUsage:{totalPercentUsed:100}}),
 });
 const adapters = Object.fromEntries(FAMILIES.map(f => [f, f === "cursor" ? cursor : adapter])) as unknown as ConstructorParameters<typeof Service>[0];
 const service = new Service(adapters, store);
 const created: Array<Record<string, unknown>>=[];
 const agents = [{ id:"chat",provider:"cursor",status:"idle",lastUserMessageAt:"2026-11-13",cwd:root,model:"auto",title:"Task",labels:{} }];
 const paseo = {
   config:{get:async () => ({config:{providers:{cursor:{command:["agent","acp"]}}}})},
   providers:{listModels:async () => ({models:[{id:"auto",isDefault:true}]}),listAvailable:async () => ({providers:[]})},
   agents:{list:async () => ({entries:agents.map(agent=>({agent})),pageInfo:{hasMore:false}}),
     create:async (request: Record<string, unknown>) => {created.push(request);},
     ref:() => ({refresh:async () => ({agent:agents[0]}),timeline:{refetch:async () => ({entries:[]}),append:async()=>{} }})},
 };
 return {service,store,created,paseo,home};
}

it("routes a new Cursor process to only its selected key and records the binding",async()=>{
 const {service,store,paseo}=await setup();
 vi.stubEnv("CURSOR_AUTH_TOKEN","parent-token");
 try {
  const result=await service.onSessionOpen({agentId:"new",workspaceId:null,provider:"cursor",cwd:root,purpose:"interactive",reason:"create",env:{}},{paseo} as never);
  expect(result?.env).toMatchObject({CURSOR_API_KEY:"test-key-second",CURSOR_AUTH_TOKEN:""});
  expect((await store.read()).sessions.new?.accountId).toBe("cursor-second");
 } finally {service.stop();}
});

it("does not mark the whole Cursor account limited from a display-only pool at 100%",async()=>{
 const {service,store}=await setup();
 try {await service.refreshUsage("cursor-main",true); expect((await store.read()).accounts[0]?.limitedUntil).toBeNull();}
 finally {service.stop();}
});

it("uses existing continuation for a Cursor conversation with history and labels its source correctly",async()=>{
 const {service,store,paseo,created}=await setup();
 await store.update(d=>{d.sessions.chat={family:"cursor",accountId:"cursor-main",openedAt:new Date().toISOString()};});
 try {
  const result=await service.setAgentAccount(paseo as never,"chat","cursor-second");
  expect(result.continuedIn).toBeTruthy();
  expect(created).toHaveLength(1);
  expect(created[0]?.prompt).toContain("earlier Cursor session");
  expect(created[0]?.prompt).not.toContain("ChatGPT");
 } finally {service.stop();}
});

it("persists a managed key's confirmed authentication failure until the key is saved again",async()=>{
 const {service,store,paseo,home}=await setup();
 const context={paseo} as never;
 await service.onSessionOpen({agentId:"chat",workspaceId:null,provider:"cursor",cwd:root,purpose:"interactive",reason:"create",env:{}},context);
 try {
  await service.onTurnEnded({agent:{id:"chat",provider:"cursor"},turnId:"turn",outcome:{kind:"failed",error:{code:"UNAUTHENTICATED",message:"Authentication required"}},timeline:[]} as never,context);
  expect((await store.read()).accounts.find(a=>a.id==="cursor-second")?.signedIn).toBe(false);
  expect((await new CursorAdapter().identity(home)).signedIn).toBe(false);
  const login=await new CursorAdapter().login(home,"code");await login.submitCode("replacement-key");
  expect((await new CursorAdapter().identity(home)).signedIn).toBe(true);
 } finally {service.stop();}
});

it("confirms failed managed credentials after plugin reload using the persisted launch fingerprint",async()=>{
 const {service,store,paseo}=await setup(); const context={paseo} as never;
 await service.onSessionOpen({agentId:"chat",workspaceId:null,provider:"cursor",cwd:root,purpose:"interactive",reason:"create",env:{}},context);
 service.stop();
 const adapter=new CursorAdapter();
 const adapters=Object.fromEntries(FAMILIES.map(f=>[f,adapter])) as unknown as ConstructorParameters<typeof Service>[0];
 const reloaded=new Service(adapters,new StateStore(join(root,"state.json")));
 try {
   await reloaded.onTurnEnded({agent:{id:"chat",provider:"cursor"},turnId:"turn",outcome:{kind:"failed",error:{code:"UNAUTHENTICATED",message:"Authentication required"}},timeline:[]} as never,context);
   expect((await new StateStore(join(root,"state.json")).read()).accounts.find(a=>a.id==="cursor-second")?.signedIn).toBe(false);
 }finally{reloaded.stop();}
});

it("does not reject a replacement key when an old session reports authentication failure",async()=>{
 const {service,store,paseo,home}=await setup(); const context={paseo} as never;
 await service.onSessionOpen({agentId:"chat",workspaceId:null,provider:"cursor",cwd:root,purpose:"interactive",reason:"create",env:{}},context);
 const login=await new CursorAdapter().login(home,"code");await login.submitCode("new-key");
 try {
  await service.onTurnEnded({agent:{id:"chat",provider:"cursor"},turnId:"turn",outcome:{kind:"failed",error:{code:"UNAUTHENTICATED",message:"Authentication required"}},timeline:[]} as never,context);
  expect((await store.read()).accounts.find(a=>a.id==="cursor-second")?.signedIn).toBe(true);
  expect((await new CursorAdapter().identity(home)).signedIn).toBe(true);
 }finally{service.stop();}
});

it("updates the persisted fingerprint when the same account reopens with a replacement key",async()=>{
 const {service,store,paseo,home}=await setup(); const context={paseo} as never;
 const request={agentId:"chat",workspaceId:null,provider:"cursor",cwd:root,purpose:"interactive" as const,reason:"create" as const,env:{}};
 try {
   await service.onSessionOpen(request,context);
   const before=(await store.read()).sessions.chat?.credentialIdentity;
   const login=await new CursorAdapter().login(home,"code");await login.submitCode("new-key");
   await service.onSessionOpen({...request,reason:"refresh"},context);
   expect((await store.read()).sessions.chat?.credentialIdentity).not.toBe(before);
 }finally{service.stop();}
});
