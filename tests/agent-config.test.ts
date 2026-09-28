import { describe, expect, test } from "bun:test";
import { configTemplate, parseConfig } from "../src/config.ts";
import { materializeAgentActivation, selectAgentScoringCredential } from "../src/agent-config.ts";
import { canonical, sha } from "../src/security.ts";

const base="/private/synthetic";
function config(){const c=configTemplate();c.codex.executable="/private/synthetic/codex";c.codex.home="/private/synthetic/dedicated";return parseConfig(c,base);}
function admission(){return{schema_version:"task-checkpoint-record.agent-activation.v1",activation_id:"a",binding_id:"b",daemon_id:"d"};}
function preparedPacket(){
  const request={model:"typesafe/jev-1.13-20260917",state:"Synthetic retention input",questions:{call:{type:"noul",instructions:"Keep this synthetic call?"},result:{type:"noul",instructions:"Keep this synthetic result?"}},provider:{allow_fallbacks:false}};
  const pair_map={pair:{keepCall:"call",keepResult:"result"}},provider="openrouter",data_class="synthetic";
  const packet_sha256=sha(canonical({provider,data_class,request,pair_map}));
  const prepared={schema_version:"ultrafast-atif.prepared-decision.v1",provider,data_class,request,pair_map,request_sha256:sha(canonical(request)),request_bytes:Buffer.byteLength(canonical(request)),pair_map_sha256:sha(canonical(pair_map)),packet_sha256};
  return{packet_handle:"p",packet_sha256,prepared,admission_ref:"owner-fixture",attempt_budget:1};
}
describe("explicit immutable native-agent admission",()=>{
  test("canonical config binding, bounded durable quotas and explicit eval models",()=>{
    const c=config(),built=materializeAgentActivation(c,admission(),base+"/state");
    expect(built.policy.config_sha256).toBe(sha(canonical(built.runtime_config)));
    expect(built.policy.supervisor).toEqual({model:"gpt-6-sol",effort:"medium"});
    expect(built.policy.worker).toEqual({model:"gpt-6-luna",effort:"medium"});
    expect(built.policy.total_native_calls).toBe(6);expect(built.policy.total_tool_calls).toBe(128);
    expect(built.policy.total_tool_output_bytes).toBe(2*1024*1024);expect(built.policy.max_attempts).toBe(3);
    expect(built.policy.external_score_max_calls).toBe(0);expect(built.include_existing_windows).toBe(false);
    expect(built.policy.objective).toBe("Observe the activated task window and produce evidence-linked continuity guidance.");
    const evaluated=materializeAgentActivation(c,{...admission(),model_profile:"eval",include_existing_windows:true},base+"/state");
    expect(evaluated.policy.supervisor).toEqual({model:"gpt-6-luna",effort:"high"});expect(evaluated.policy.worker).toEqual(evaluated.policy.supervisor);
    c.codex.supervisor.effort="high";expect(built.policy.supervisor.effort).toBe("medium");
    const directed=materializeAgentActivation(c,{...admission(),objective:"Recall the selected change.\nCompare the two evidence windows."},base);
    expect(directed.policy.objective).toBe("Recall the selected change.\nCompare the two evidence windows.");
    expect(()=>materializeAgentActivation(c,{...admission(),objective:"x".repeat(4097)},base)).toThrow("agent_objective_invalid");
    expect(()=>materializeAgentActivation(c,{...admission(),objective:"  "},base)).toThrow("agent_objective_invalid");
    expect(()=>materializeAgentActivation(c,{...admission(),objective:null},base)).toThrow("agent_objective_invalid");
  });
  test("host fragments need explicit policy/digest/admission and cannot enable RAW transport",()=>{
    const c=config(),fragment={fragment_handle:"f",record_handle:"r",data_class:"synthetic" as const,text:"Prepared synthetic fixture",sha256:sha("Prepared synthetic fixture"),admission_ref:"owner-fixture-v1"};
    expect(()=>materializeAgentActivation(c,{...admission(),prepared_fragments:[fragment]},base)).toThrow("agent_prepared_fragments_not_enabled");
    c.agent_service.data_policy="prepared_fragments";expect(materializeAgentActivation(c,{...admission(),prepared_fragments:[fragment]},base).policy.content.prepared_fragments).toEqual([fragment]);
    expect(()=>materializeAgentActivation(c,{...admission(),prepared_fragments:[{...fragment,sha256:"0".repeat(64)}]},base)).toThrow("agent_fragment_digest_mismatch");
    expect(()=>materializeAgentActivation(c,{...admission(),selected_record_handles:["r"]},base)).toThrow("agent_selected_source_policy_unsupported");
    expect(()=>materializeAgentActivation(c,{...admission(),policy:{external_score_max_calls:1}},base)).toThrow("unknown_field");
    expect(()=>materializeAgentActivation(c,{...admission(),prepared_fragments:[{...fragment,data_class:"raw"}]},base)).toThrow("invalid_enum");
  });
  test("default scoring never looks up keys; explicit remote admission reads only the selected key",()=>{
    const c=config(),built=materializeAgentActivation(c,admission(),base);
    const denied=new Proxy({},{get(){throw Error("environment must not be inspected");}});
    expect(selectAgentScoringCredential(c,built.policy,denied)).toBeUndefined();
    c.agent_service.external_score_max_calls=1;
    expect(()=>materializeAgentActivation(c,admission(),base)).toThrow("agent_prepared_packet_required");
    const packet=preparedPacket();
    const allowed=materializeAgentActivation(c,{...admission(),prepared_packets:[packet]},base);
    expect(allowed.policy.total_external_score_calls).toBe(1);
    expect(()=>selectAgentScoringCredential(c,allowed.policy,{})).toThrow("agent_provider_key_missing");
    const names:string[]=[];const environment=new Proxy({},{get(_target,key){names.push(String(key));return"synthetic-key";}});
    expect(selectAgentScoringCredential(c,allowed.policy,environment)).toEqual({envName:"OPENROUTER_API_KEY",value:"synthetic-key"});expect(names).toEqual(["OPENROUTER_API_KEY"]);
    expect(canonical(allowed)).not.toContain("synthetic-key");
    expect(()=>selectAgentScoringCredential(c,allowed.policy,{OPENROUTER_API_KEY:"synthetic\nkey"})).toThrow("agent_provider_key_invalid");
    expect(()=>materializeAgentActivation(c,{...admission(),prepared_packets:[{...packet,packet_sha256:"0".repeat(64)}]},base)).toThrow("ptc_packet_binding_mismatch");
  });
});
