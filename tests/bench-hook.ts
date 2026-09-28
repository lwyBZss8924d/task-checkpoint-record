import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.ts";

const root=realpathSync(mkdtempSync(join(tmpdir(),"tcr-hook-bench-")));
const state=join(root,"state"),sourceRoot=join(root,"sources"),source=join(sourceRoot,"raw.jsonl");
mkdirSync(sourceRoot,{mode:0o700});writeFileSync(source,"",{mode:0o600});
const store=new Store(state,{initialize:true});
store.bind({schema_version:"task-checkpoint-record.binding.v1",binding_id:"benchmark",task_id:"synthetic-benchmark",project_id:null,client:"codex",profile:"synthetic",runtime_home:null,native_session_id:"synthetic-session",role:"master",source_root:sourceRoot,sources:[{source_id:"raw",path:source,format:"codex"}]});
try{
  const times:number[]=[];const cli=fileURLToPath(new URL("../src/cli.ts",import.meta.url));
  for(let i=0;i<20;i++){
    const start=performance.now();const child=Bun.spawn([process.execPath,cli,"--state",state,"hook","--client","codex","--profile","synthetic"],{stdin:new Blob([JSON.stringify({hook_event_name:i%2?"SessionEnd":"Interrupt",session_id:"synthetic-session",turn_id:"synthetic-turn-"+i})]),stdout:"pipe",stderr:"pipe"});
    const[out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    if(code!==0||out.trim()!=="{}"||err)throw new Error("benchmark hook failed");times.push(performance.now()-start);
  }
  times.sort((a,b)=>a-b);process.stdout.write(JSON.stringify({schema_version:"task-checkpoint-record.hook-benchmark.v1",samples:times.length,scope:"synthetic independent CLI process + local SQLite FULL/WAL enqueue; no workers/models",milliseconds:{min:times[0],median:times[10],p95:times[18],max:times[19]},native_output:"{}",status:store.status()})+"\n");
}finally{store.close();rmSync(root,{recursive:true,force:true});}
