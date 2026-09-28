import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_VERSION, ConfigurationError, configSchema, configTemplate, loadConfig, parseConfig, writeConfig } from "../src/config.ts";
import { authPlan, configuredAppServerOptions, setupAuth } from "../src/config-runtime.ts";
import { Store } from "../src/store.ts";

const roots:string[]=[];
function temporary(){const p=mkdtempSync(join(realpathSync(tmpdir()),"tcr-config-"));roots.push(p);return p;}
afterEach(()=>{for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
const cli=join(import.meta.dir,"../src/cli.ts");
function run(args:string[],cwd:string,extra:NodeJS.ProcessEnv={}){
  return spawnSync(process.execPath,["--no-env-file",cli,...args],{cwd,encoding:"utf8",env:{HOME:homedir(),PATH:process.env.PATH,...extra}});
}
function fake(dir:string){const executable=join(dir,"fake-codex");writeFileSync(executable,`#!${process.execPath}\nawait Bun.write(${JSON.stringify(join(dir,"native-observation.json"))},JSON.stringify({argv:process.argv.slice(2),home:process.env.CODEX_HOME,orKeyPresent:!!process.env.OPENROUTER_API_KEY,openaiKeyPresent:!!process.env.OPENAI_API_KEY,parentIdentityPresent:!!process.env.CODEX_THREAD_ID}));\n`);chmodSync(executable,0o700);return executable;}
describe("one explicit portable config",()=>{
  test("provider defaults, path base and role models are deterministic",()=>{
    const root=temporary(),executable=fake(root);const parsed=parseConfig({schema_version:CONFIG_VERSION,scoring:{provider:"typesafe"},codex:{home:"./profile",executable:"./fake-codex",eval:{model:"gpt-6-sol",effort:"high"}}},root);
    expect(parsed.scoring.model).toBe("jev-1.13.0");expect(parsed.scoring.api_key_env).toBe("TYPESAFE_API_KEY");
    expect(parsed.recorder.state_dir).toBe(join(root,".local/task-checkpoint-record"));
    expect(configuredAppServerOptions(parsed,"eval",root)).toEqual({codexExecutable:executable,codexHome:join(root,"profile"),cwd:root,role:"eval",selection:{model:"gpt-6-sol",effort:"high"}});
    expect(configTemplate().codex.supervisor).toEqual({model:"gpt-6-sol",effort:"medium"});
    expect(configTemplate().codex.eval).toEqual({model:"gpt-6-luna",effort:"high"});
    expect((configSchema() as any).additionalProperties).toBe(false);
  });
  test("unknown fields, inline keys, endpoint/fallback and invalid types fail without echo",()=>{
    const root=temporary();const cases=[
      {schema_version:CONFIG_VERSION,api_key:"synthetic-secret"},
      {schema_version:CONFIG_VERSION,scoring:{api_key:"synthetic-secret"}},
      {schema_version:CONFIG_VERSION,scoring:{endpoint:"https://example.invalid"}},
      {schema_version:CONFIG_VERSION,scoring:{fallback:"typesafe"}},
      {schema_version:CONFIG_VERSION,scoring:{api_key_env:"bad=key"}},
      {schema_version:CONFIG_VERSION,scoring:{api_key_env:"BUN_OPTIONS"}},
      {schema_version:CONFIG_VERSION,scoring:{api_key_env:"NODE_OPTIONS"}},
      {schema_version:CONFIG_VERSION,scoring:{api_key_env:"LD_PRELOAD"}},
      {schema_version:CONFIG_VERSION,scoring:{api_key_env:"HOME"}},
      {schema_version:CONFIG_VERSION,scoring:{api_key_env:"USER"}},
      {schema_version:CONFIG_VERSION,scoring:{api_key_env:"LOGNAME"}},
      {schema_version:CONFIG_VERSION,scoring:{api_key_env:"TMPDIR"}},
      {schema_version:CONFIG_VERSION,scoring:{api_key_env:"LANG"}},
      {schema_version:CONFIG_VERSION,scoring:{api_key_env:"PYTHONPATH"}},
      {schema_version:CONFIG_VERSION,scoring:{api_key_env:"PYTHONHOME"}},
      {schema_version:CONFIG_VERSION,scoring:{api_key_env:"PYTHONSTARTUP"}},
      {schema_version:CONFIG_VERSION,scoring:{api_key_env:"HTTPS_PROXY"}},
      {schema_version:CONFIG_VERSION,recorder:{concurrency:"2"}},
      {schema_version:CONFIG_VERSION,recorder:{concurrency:33}},
      {schema_version:CONFIG_VERSION,codex:{home:123}},
      {schema_version:CONFIG_VERSION,codex:{eval:{model:"anything"}}},
      {schema_version:CONFIG_VERSION,scoring:{provider:"typesafe",model:"typesafe/jev-1.13-20260917"}},
      {schema_version:CONFIG_VERSION,scoring:{limits:{deadline_ms:20001}}},
      {schema_version:CONFIG_VERSION,scoring:{limits:{max_request_bytes:65537}}},
      {schema_version:CONFIG_VERSION,scoring:{limits:{max_response_bytes:1048577}}},
      {schema_version:CONFIG_VERSION,recorder:{timeout_ms:30000,lease_ms:30000}},
      {schema_version:CONFIG_VERSION,recorder:{state_dir:"../outside"}},
      {schema_version:CONFIG_VERSION,codex:{home:"$HOME/.codex-special"}},
      {schema_version:CONFIG_VERSION,codex:{home:"~/.codex-special"}},
      {schema_version:CONFIG_VERSION,codex:{home:null,extra:true}},
      {schema_version:"future-version"},
    ];
    for(const candidate of cases){try{parseConfig(candidate,root);throw Error("expected rejection");}catch(e){expect(e).toBeInstanceOf(ConfigurationError);expect(String(e)).not.toContain("synthetic-secret");}}
  });
  test("new-only private init and explicit file loading reject alias/credential/duplicate/budget",()=>{
    const root=temporary(),file=join(root,"suite.json");writeConfig(file);
    expect(lstatSync(file).mode&0o777).toBe(0o600);expect(()=>writeConfig(file)).toThrow("config_create_new_failed");
    expect(loadConfig(file).scoring.api_key_env).toBe("OPENROUTER_API_KEY");
    const alias=join(root,"alias.json");symlinkSync(file,alias);expect(()=>loadConfig(alias)).toThrow("config_symlink_denied");
    const hard=join(root,"hard.json");linkSync(file,hard);expect(()=>loadConfig(hard)).toThrow("config_regular_unaliased_file_required");
    expect(()=>loadConfig(join(root,".env"))).toThrow("config_credential_path_denied");
    const duplicate=join(root,"duplicate.json");writeFileSync(duplicate,'{"schema_version":"task-checkpoint.config.v1","scoring":{"provider":"openrouter","provider":"typesafe"}}');
    expect(()=>loadConfig(duplicate)).toThrow("config_duplicate_key");
    const huge=join(root,"huge.json");writeFileSync(huge," ".repeat(65537));expect(()=>loadConfig(huge)).toThrow("config_byte_budget");
    const utf=join(root,"utf.json");writeFileSync(utf,Buffer.from([255]));expect(()=>loadConfig(utf)).toThrow("config_invalid_utf8");
  });
  test("optional agent policy is inert, finite and coherent before activation",()=>{
    const root=temporary(),config=parseConfig({schema_version:CONFIG_VERSION},root);
    expect(config.agent_service).toEqual({concurrency:2,max_workers:2,max_native_turns:3,max_tool_calls:64,deadline_ms:180000,max_rounds:2,data_policy:"metadata_only",external_score_max_calls:0});
    expect(existsSync(config.recorder.state_dir)).toBe(false);
    expect(parseConfig({schema_version:CONFIG_VERSION,agent_service:{max_workers:32,concurrency:32,max_native_turns:33,max_tool_calls:256,deadline_ms:300000,max_rounds:32,data_policy:"prepared_fragments",external_score_max_calls:1}},root).agent_service.max_workers).toBe(32);
    for(const agent_service of [{concurrency:33},{max_workers:33},{max_native_turns:34},{max_tool_calls:257},{deadline_ms:300001},{max_rounds:33},{external_score_max_calls:2},{max_workers:3},{concurrency:3},{data_policy:"owner_selected_source"},{prepared_packets:[]},{enabled:true},{max_model_calls:3}])
      expect(()=>parseConfig({schema_version:CONFIG_VERSION,agent_service},root)).toThrow(ConfigurationError);
  });
  test("expected config digest binds the same bounded bytes before parsing or state mutation",()=>{
    const root=temporary(),file=join(root,"suite.json");writeConfig(file);const digest=createHash("sha256").update(readFileSync(file)).digest("hex");
    expect(loadConfig(file,digest).schema_version).toBe(CONFIG_VERSION);
    expect(()=>loadConfig(file,"not-a-digest")).toThrow("config_expected_digest_invalid");
    expect(()=>loadConfig(file,"0".repeat(64))).toThrow("config_digest_mismatch");
    const checked=run(["config","check","--config",file,"--config-sha256",digest],root);expect(checked.status).toBe(0);
    expect(run(["init","--config",file,"--config-sha256","0".repeat(64)],root).status).toBe(1);
    expect(existsSync(join(root,".local/task-checkpoint-record"))).toBe(false);
    expect(run(["init","--config-sha256",digest,"--state",join(root,"state")],root).stderr).toContain("config_required_for_digest");
    writeFileSync(file,readFileSync(file,"utf8")+"\n");expect(()=>loadConfig(file,digest)).toThrow("config_digest_mismatch");
  });
  test("explicit config beats state env; CLI state overrides it and checks have no state effects",()=>{
    const root=temporary(),file=join(root,"suite.json"),configured=join(root,"from-config"),environment=join(root,"from-env"),override=join(root,"from-cli");
    writeFileSync(file,JSON.stringify({...configTemplate(),recorder:{state_dir:"./from-config"}}));
    const checked=run(["config","check","--config",file],root,{TASK_CHECKPOINT_RECORD_STATE:environment});
    expect(checked.status).toBe(0);expect(JSON.parse(checked.stdout).config.recorder.state_dir).toBe(configured);expect(existsSync(configured)).toBe(false);
    expect(run(["init","--config",file],root,{TASK_CHECKPOINT_RECORD_STATE:environment}).status).toBe(0);
    expect(existsSync(join(configured,"store.sqlite"))).toBe(true);expect(existsSync(environment)).toBe(false);
    expect(run(["init","--config",file,"--state",override],root).status).toBe(0);expect(existsSync(join(override,"store.sqlite"))).toBe(true);
    const stopped=run(["service","once","--config",file],root);expect(stopped.status).toBe(0);
    expect(run(["service","once","--config",file,"--concurrency","33"],root).status).toBe(1);
  });
  test("configured helper argv/page and max-jobs limits affect real deterministic extraction",()=>{
    const root=temporary(),source=join(root,"synthetic.jsonl"),state=join(root,"state"),file=join(root,"suite.json");
    writeFileSync(source,'{"type":"message","entry_id":"one"}\n{"type":"message","entry_id":"two"}\n');
    const store=new Store(state,{initialize:true});
    const binding=store.bind({schema_version:"task-checkpoint-record.binding.v1",binding_id:"configured",task_id:"synthetic",project_id:"synthetic",client:"codex",profile:"test",runtime_home:null,native_session_id:"synthetic-session",role:"master",source_root:root,sources:[{source_id:"raw",path:source,format:"codex",start_at:"beginning"}]});
    store.enqueue(binding as any,{hook_event_name:"PreCompact",native_session_id:"synthetic-session",native_turn_id:"synthetic-turn",transcript_path:null,input_sha256:"a".repeat(64),delivery_id:null});store.close();
    writeFileSync(file,JSON.stringify({...configTemplate(),recorder:{state_dir:state,helper_command:[process.execPath,join(import.meta.dir,"fixture-helper.ts")],page_limit:1,max_jobs:1,timeout_ms:2000,lease_ms:4000}}));
    const drained=run(["service","once","--config",file],root);expect(drained.status).toBe(0);
    const result=JSON.parse(drained.stdout);expect(result.claimed).toBe(1);expect(result.outcomes).toEqual({continued:1});
    const queried=run(["query","--config",file,"--kind","records","--fields","native.entry_id"],root);
    expect(JSON.parse(queried.stdout).items).toEqual([{"native.entry_id":"one"}]);
    expect(run(["service","once","--config",file,"--page-limit","2"],root).status).toBe(0);
  });
});
describe("dedicated native authentication front door",()=>{
  test("configured native model options reject protected dot-dot-prefixed descendants before launch",()=>{
    const root=temporary(),userHome=join(root,"user"),executable=fake(root),probe=join(root,"options-probe.ts");
    mkdirSync(userHome,{mode:0o700});mkdirSync(join(userHome,".codex"),{mode:0o700});
    mkdirSync(join(userHome,".codex","..service"),{mode:0o700});
    writeFileSync(probe,`import {parseConfig} from ${JSON.stringify(new URL("../src/config.ts",import.meta.url).href)};\nimport {configuredAppServerOptions} from ${JSON.stringify(new URL("../src/config-runtime.ts",import.meta.url).href)};\ntry{configuredAppServerOptions(parseConfig(JSON.parse(process.argv[2]),process.cwd()),"eval",process.cwd());process.stdout.write("accepted");}catch(error){process.stdout.write(error.code);process.exitCode=1;}\n`);
    for(const leaf of ["..service","..pending"]){
      const config={schema_version:CONFIG_VERSION,codex:{executable,home:join(userHome,".codex",leaf)}};
      const observed=spawnSync(process.execPath,["--no-env-file",probe,JSON.stringify(config)],{cwd:root,encoding:"utf8",env:{HOME:userHome,PATH:process.env.PATH}});
      expect(observed.status).toBe(1);expect(observed.stdout).toBe("config_dedicated_home_required");
      expect(existsSync(join(root,"native-observation.json"))).toBe(false);
    }
    const sibling=spawnSync(process.execPath,["--no-env-file",probe,JSON.stringify({schema_version:CONFIG_VERSION,codex:{executable,home:join(userHome,".codex-service")}})],{cwd:root,encoding:"utf8",env:{HOME:userHome,PATH:process.env.PATH}});
    expect(sibling.status).toBe(0);expect(sibling.stdout).toBe("accepted");expect(existsSync(join(root,"native-observation.json"))).toBe(false);
  });
  test("plan-bound new-only setup preserves ordinary/existing profiles",()=>{
    const root=temporary(),executable=fake(root),home=join(root,"dedicated");
    const config=parseConfig({...configTemplate(),codex:{executable,home,supervisor:{model:"gpt-6-luna",effort:"high"}}},root);
    const plan=authPlan(config);expect(existsSync(home)).toBe(false);expect(plan.config_text).toContain('model = "gpt-6-luna"');
    expect(()=>setupAuth(config,"0".repeat(64))).toThrow("config_auth_plan_changed");
    setupAuth(config,plan.plan_sha256);expect(lstatSync(home).mode&0o777).toBe(0o700);expect(lstatSync(join(home,"config.toml")).mode&0o777).toBe(0o600);
    const before=readFileSync(join(home,"config.toml"));expect(()=>setupAuth(config,plan.plan_sha256)).toThrow("config_auth_setup_requires_empty_home");expect(readFileSync(join(home,"config.toml"))).toEqual(before);
    for(const name of [".codex",".codex-test",".claude",".pi"]){expect(()=>authPlan({...config,codex:{...config.codex,home:join(realpathSync(homedir()),name)}})).toThrow("config_dedicated_home_required");}
    const alias=join(root,"profile-alias");symlinkSync(home,alias);expect(()=>authPlan({...config,codex:{...config.codex,home:alias}})).toThrow("config_codex_path_unavailable");
  });
  test("fake native login/status receive exact dedicated home and no API credentials/parent identity",()=>{
    const root=temporary(),executable=fake(root),home=join(root,"dedicated"),file=join(root,"suite.json");
    writeFileSync(file,JSON.stringify({...configTemplate(),codex:{executable,home}}));
    const plan=JSON.parse(run(["auth","plan","--config",file],root).stdout);
    expect(run(["auth","setup","--config",file,"--plan-sha256",plan.plan_sha256],root).status).toBe(0);
    for(const action of ["login","status"]){
      const child=run(["auth",action,"--config",file],root,{CODEX_HOME:"do-not-use",CODEX_THREAD_ID:"synthetic-parent",OPENROUTER_API_KEY:"synthetic-key",OPENAI_API_KEY:"synthetic-key"});
      expect(child.status).toBe(0);expect(child.stdout).toBe("");
      const observation=JSON.parse(readFileSync(join(root,"native-observation.json"),"utf8"));
      expect(observation).toEqual({argv:["-c",'forced_login_method="chatgpt"',"-c",'cli_auth_credentials_store="file"',"login",action==="login"?"--device-auth":"status"],home,orKeyPresent:false,openaiKeyPresent:false,parentIdentityPresent:false});
    }
  });
});
