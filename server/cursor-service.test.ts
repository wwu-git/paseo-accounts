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
 const cursor = { ...adapter, family: "cursor", portable: false, usageSpacingMs:0,
   env: adapter.env.bind(adapter), prepareHome: adapter.prepareHome.bind(adapter), usage:async () => parseCursorUsage({planUsage:{totalPercentUsed:100}}),
 } as unknown as CursorAdapter;
 // Use real cursor methods with only usage's transport replaced.
 const adapters = Object.fromEntries(FAMILIES.map(f => [f, f === "cursor" ? cursor : adapter])) as ConstructorParameters<typeof Service>[0];
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
