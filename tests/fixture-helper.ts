// Synthetic protocol fixture only. Production uses the separately installed helper.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
const args=process.argv.slice(2);
const get=(key:string)=>args[args.indexOf(key)+1];
const mode=args.includes("--fixture-mode")?get("--fixture-mode"):"normal";
if(mode==="slow"){await Bun.sleep(10000);process.exit(0);}
if(mode==="spew"){process.stdout.write("X".repeat(1024*1024));process.exit(0);}
const path=get("--input"),format=get("--format"),offset=Number(get("--offset")),limit=Number(get("--limit")),max=Number(get("--max-bytes"));
const all=readFileSync(path),bytes=all.subarray(offset,offset+max);const hash=(b:Buffer|string)=>createHash("sha256").update(b).digest("hex");
const records:any[]=[];let cursor=offset;let context:Record<string,any>={};let identities:Record<string,any>={};
while(cursor-offset<bytes.length && records.length<limit){
  const end=bytes.indexOf(10,cursor-offset);if(end<0)break;
  const raw=bytes.subarray(cursor-offset,end+1),row=JSON.parse(raw.toString("utf8"));const source={uri:pathToFileURL(path).href,format,version:null,offset:cursor,length:raw.length,sha256:hash(raw),json_pointer:""};
  for(const name of ["session_id","turn_id","entry_id"]){if(typeof row[name]==="string"){context[name]=row[name];identities[name]={offset:cursor,length:raw.length,sha256:hash(raw),json_pointer:"/"+name};}}
  const native={session_id:context.session_id??null,turn_id:context.turn_id??null,entry_id:row.entry_id??null,parent_entry_id:null,trajectory_id:null,step_id:null};
  const evidence:any={};for(const[name,value]of Object.entries(native))if(value!==null)evidence[name]=identities[name];
  const record={record_id:"rec_"+hash(JSON.stringify([source,native,evidence])),client:format,kind:row.type??"message",timestamp:null,native,source,identity_evidence:evidence,labels:[],text_available:typeof row.text==="string"};
  if(mode==="forged")record.native.turn_id="forged";
  records.push(record);cursor=offset+end+1;
}
const tail=cursor-offset<bytes.length && bytes.indexOf(10,cursor-offset)<0;
process.stdout.write(JSON.stringify({schema_version:"ultrafast-atif.page.v1",records,next_offset:cursor,eof:cursor===all.length||tail,incomplete_tail:tail,omissions:offset?["Context before resume offset is unavailable."]:[]}));
