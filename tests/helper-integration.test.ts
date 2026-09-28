import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { drain } from "../src/worker.ts";
import { sha } from "../src/security.ts";
import type { Binding, Client, Format } from "../src/types.ts";

// Explicit opt-in keeps default source tests independent of another checkout.
const helper=process.env.TCR_HELPER_ENTRYPOINT;
const executable=process.env.TCR_HELPER_RUNTIME??"node";
const roots:string[]=[],stores:Store[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
function setup(format:Format,content:unknown[]|Record<string,unknown>){
  const root=realpathSync(mkdtempSync(join(tmpdir(),"tcr-helper-test-")));roots.push(root);const sources=join(root,"sources");mkdirSync(sources,{mode:0o700});const path=join(sources,format==="atif"?"source.json":"source.jsonl");
  writeFileSync(path,Array.isArray(content)?content.map(r=>JSON.stringify(r)).join("\n")+"\n":JSON.stringify(content),{mode:0o600});
  const store=new Store(join(root,"state"),{initialize:true});stores.push(store);
  const b:Binding={schema_version:"task-checkpoint-record.binding.v1",binding_id:"b",task_id:"task-integration",project_id:null,client:(format==="atif"?"codex":format)as Client,profile:"synthetic",runtime_home:null,native_session_id:"native-session",role:"master",source_root:sources,sources:[{source_id:"source",path,format,start_at:"beginning"}]};store.bind(b);
  function enqueue(seed:string){return store.enqueue(b,{hook_event_name:"PreCompact",native_session_id:b.native_session_id,native_turn_id:"hook-turn",transcript_path:null,input_sha256:sha(seed),delivery_id:null});}
  return{store,b,path,enqueue,options:{helper:[executable,helper!],timeoutMs:5000,leaseMs:10000,pageLimit:100,pageBytes:1024*1024}};
}
for(const format of ["codex","claude","pi"] as const)test.skipIf(!helper)(`real helper ${format} JSONL identities and source selectors round-trip`,async()=>{
  const rows:Record<typeof format,unknown[]>={
    codex:[{type:"session_meta",payload:{id:"native-session"}},{type:"turn_context",payload:{turn_id:"source-turn"}},{type:"response_item",payload:{id:"entry",type:"message",role:"user",content:[{type:"input_text",text:"SYNTHETIC_PRIVATE_BODY"}]}}],
    claude:[{type:"user",sessionId:"native-session",uuid:"entry",parentUuid:null,message:{role:"user",content:"SYNTHETIC_PRIVATE_BODY"}}],
    pi:[{type:"session",id:"native-session",version:3},{type:"message",id:"entry",parentId:null,message:{role:"user",content:[{type:"text",text:"SYNTHETIC_PRIVATE_BODY"}]}}]
  } as any;
  const s=setup(format,rows[format]);const window=s.enqueue("first");const result=await drain(s.store,s.options);
  expect(result.outcomes).toEqual({succeeded:1});
  const records=s.store.query({kind:"records",filters:{window_id:window.window_id},fields:["record_id","native.session_id","native.turn_id","native.entry_id","source.version","deeplink"]}).items as any[];
  expect(records.length).toBe(rows[format].length);expect(records.every(r=>r["native.session_id"]==="native-session")).toBe(true);
  expect(records.some(r=>r["native.entry_id"]==="entry")).toBe(true);expect(JSON.stringify(records)).not.toContain("SYNTHETIC_PRIVATE_BODY");
  if(format==="pi")expect(records.every(r=>r["source.version"]===3)).toBe(true);
  expect(s.store.resolve(records[0].deeplink)).toBeDefined();
});
for(const version of ["ATIF-v1.7","ATIF-v1.8"] as const)test.skipIf(!helper)(`real helper ${version} preserves version, checkpoint and Relay namespaces`,async()=>{
  const checkpoint={schema_version:"task-turns-checkpoint.v1",event_type:"task_turns_checkpoint",event_id:"cp:synthetic",task:{task_id:"task-integration"},logical_run:{run_id:"logical-run"},project:{project_id:"project"},provenance_ref:{record_id:"synthetic-lineage",uri:"file:///not-followed/lineage.json",json_pointer:"",sha256:"a".repeat(64)},facets:{native_sessions:[{client:"codex",session_ref:"primary",roles:["primary_actor"],native_session_id:{status:"observed",value:"native-session"}}],native_turns:[{session_ref:"primary",native_turn_id:{status:"observed",value:"checkpoint-turn"}}]}};
  const s=setup("atif",{schema_version:version,session_id:"native-session",trajectory_id:"atif-document",agent:{name:"synthetic",version:"1"},steps:[{step_id:1,source:"user",message:"SYNTHETIC_ATIF_BODY"}],extra:{self_harness:{task_turns_checkpoint:[checkpoint]},observed_events:[{kind:"mark",atof_version:"0.1",uuid:"native-session",parent_uuid:"relay-parent",propagation_root_uuid:"relay-root",name:"checkpoint_hint",data:{}}]}});
  s.enqueue("first");expect((await drain(s.store,s.options)).outcomes).toEqual({succeeded:1});
  const records=s.store.query({kind:"records",filters:{source_version:version},fields:["kind","source.version","native_client","native.session_id","native.turn_id","logical.task_id","relay.event_uuid","atif.session_id","native_actor.provenance_ref"]}).items as any[];
  expect(records.length).toBe(4);expect(records.find(r=>r.kind==="trajectory")["native.session_id"]).toBeNull();expect(records.find(r=>r.kind==="trajectory")["atif.session_id"]).toBe("native-session");
  expect(records.find(r=>r.kind==="task_turns_checkpoint")["native.turn_id"]).toBe("checkpoint-turn");
  expect(records.find(r=>r.kind==="relay_mark")["relay.event_uuid"]).toBe("native-session");
  expect((s.store.query({kind:"records",filters:{source_task_id:"task-integration"}}).items as any[]).length).toBe(1);
  expect((s.store.query({kind:"records",filters:{native_session_id:"native-session",native_client:"codex"}}).items as any[]).length).toBe(1);
  // Checkpoint/Relay records retain explicit, separately evidenced container
  // membership; that relationship does not make the container ID client-native.
  expect((s.store.query({kind:"records",filters:{atif_session_id:"native-session"}}).items as any[]).length).toBe(4);
  expect((s.store.query({kind:"records",filters:{relay_event_uuid:"native-session"}}).items as any[]).length).toBe(1);
  expect((s.store.query({kind:"records",filters:{native_session_id:"native-session",atif_session_id:"native-session"}}).items as any[]).length).toBe(1);
  expect((s.store.query({kind:"records",filters:{native_session_id:"native-session",kind:"trajectory"}}).items as any[]).length).toBe(0);
  expect((s.store.query({kind:"records",filters:{native_session_id:"native-session",kind:"relay_mark"}}).items as any[]).length).toBe(0);
});
test.skipIf(!helper)("real helper cutoffs preserve hook-time byte ceilings after source append",async()=>{
  const s=setup("codex",[{type:"session_meta",payload:{id:"native-session"}}]);
  appendFileSync(s.path,'{"type":"response_item","payload":{"id":"late","type":"message","content":');
  const old=s.enqueue("old");appendFileSync(s.path,'[]}}\n');const next=s.enqueue("new");
  expect((await drain(s.store,s.options)).outcomes).toEqual({succeeded:2});
  expect((s.store.query({kind:"records",filters:{window_id:old.window_id}}).items as any[]).length).toBe(1);
  expect(s.store.query({kind:"records",filters:{window_id:next.window_id},fields:["native.entry_id","native.turn_id"]}).items).toEqual([{"native.entry_id":"late","native.turn_id":null}]);
});
