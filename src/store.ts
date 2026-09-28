import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, openSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Binding, HookMetadata, Job, NormalizedRecord, Page, QueryOptions, SourceState } from "./types.ts";
import { absolute, canonical, digest, fail, fingerprint, integer, keys, limitedJSON, noSymlinks, nullable, object, oneOf, openRegular, privateState, range, readFileBounded, sha, str, telemetryCorrelation, underRoot } from "./security.ts";

const VERSION = 1;
const SCHEMA = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE bindings(binding_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, project_id TEXT, client TEXT NOT NULL, profile TEXT NOT NULL, native_session_id TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, body TEXT NOT NULL);
CREATE UNIQUE INDEX binding_active ON bindings(client,profile,native_session_id) WHERE active=1;
CREATE TABLE sources(binding_id TEXT NOT NULL REFERENCES bindings,source_id TEXT NOT NULL,path TEXT NOT NULL,format TEXT NOT NULL,PRIMARY KEY(binding_id,source_id));
CREATE TABLE source_states(binding_id TEXT NOT NULL,source_id TEXT NOT NULL,cursor INTEGER NOT NULL DEFAULT 0,fingerprint TEXT,atif_complete INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(binding_id,source_id),FOREIGN KEY(binding_id,source_id) REFERENCES sources);
CREATE TABLE events(event_id TEXT PRIMARY KEY,binding_id TEXT NOT NULL REFERENCES bindings,task_id TEXT NOT NULL,client TEXT NOT NULL,native_session_id TEXT NOT NULL,native_turn_id TEXT,hook_event_name TEXT NOT NULL,created_at INTEGER NOT NULL,trace_id TEXT,span_id TEXT,body TEXT NOT NULL);
CREATE TABLE windows(window_id TEXT PRIMARY KEY,event_id TEXT NOT NULL UNIQUE REFERENCES events,binding_id TEXT NOT NULL REFERENCES bindings,task_id TEXT NOT NULL,native_session_id TEXT NOT NULL,hook_turn_id TEXT,created_at INTEGER NOT NULL,trace_id TEXT,span_id TEXT,body TEXT NOT NULL);
CREATE TABLE jobs(job_id TEXT PRIMARY KEY,window_id TEXT NOT NULL REFERENCES windows,binding_id TEXT NOT NULL,source_id TEXT NOT NULL,target_size INTEGER NOT NULL,target_dev INTEGER NOT NULL,target_ino INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'queued',lease_token TEXT,lease_until INTEGER,generation INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,error_code TEXT,created_at INTEGER NOT NULL,finished_at INTEGER,FOREIGN KEY(binding_id,source_id) REFERENCES sources);
CREATE INDEX jobs_claim ON jobs(state,created_at);
CREATE INDEX jobs_source ON jobs(binding_id,source_id,state,lease_until);
CREATE TABLE records(record_id TEXT PRIMARY KEY,client TEXT NOT NULL,kind TEXT NOT NULL,timestamp TEXT,native_session_id TEXT,native_turn_id TEXT,entry_id TEXT,trajectory_id TEXT,source_format TEXT NOT NULL,source_version TEXT,source_task_id TEXT,source_event_id TEXT,relay_event_uuid TEXT,native_client TEXT,atif_session_id TEXT,atif_trajectory_id TEXT,atif_step_id TEXT,body TEXT NOT NULL);
CREATE INDEX records_native ON records(native_session_id,native_turn_id);
CREATE TABLE record_windows(record_id TEXT NOT NULL REFERENCES records,window_id TEXT NOT NULL REFERENCES windows,PRIMARY KEY(record_id,window_id));
CREATE TABLE pages(page_id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES jobs,window_id TEXT NOT NULL REFERENCES windows,start_offset INTEGER NOT NULL,next_offset INTEGER NOT NULL,body TEXT NOT NULL);
CREATE TABLE checkpoints(checkpoint_id TEXT PRIMARY KEY,binding_id TEXT NOT NULL REFERENCES bindings,task_id TEXT NOT NULL,native_session_id TEXT NOT NULL,created_at INTEGER NOT NULL,body TEXT NOT NULL);
CREATE TABLE services(service_id TEXT PRIMARY KEY,token TEXT NOT NULL,pid INTEGER NOT NULL,heartbeat INTEGER NOT NULL,stop_requested INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL);
CREATE TABLE counters(name TEXT PRIMARY KEY,value INTEGER NOT NULL);
CREATE TRIGGER records_immutable BEFORE UPDATE ON records BEGIN SELECT RAISE(ABORT,'immutable record'); END;
CREATE TRIGGER events_immutable BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'immutable event'); END;
CREATE TRIGGER windows_immutable BEFORE UPDATE ON windows BEGIN SELECT RAISE(ABORT,'immutable window'); END;
CREATE TRIGGER checkpoints_immutable BEFORE UPDATE ON checkpoints BEGIN SELECT RAISE(ABORT,'immutable checkpoint'); END;
PRAGMA user_version=1;`;

export function validateBinding(input: unknown): Binding {
  const b = object(input);
  keys(b, ["schema_version", "binding_id", "task_id", "project_id", "client", "profile", "runtime_home", "native_session_id", "role", "source_root", "sources"]);
  if (b.schema_version !== "task-checkpoint-record.binding.v1") fail("binding_version_unsupported");
  const root = absolute(b.source_root); noSymlinks(root);
  if (!Array.isArray(b.sources) || b.sources.length < 1 || b.sources.length > 32) fail("invalid_sources");
  const seen = new Set<string>(); const paths = new Set<string>();
  const sources = b.sources.map((item: unknown) => {
    const s = object(item); keys(s, ["source_id", "path", "format", "start_at"]);
    const source_id = str(s.source_id); const path = absolute(s.path);
    if (seen.has(source_id) || paths.has(path)) fail("duplicate_source"); seen.add(source_id); paths.add(path);
    underRoot(path, root); const fd = openRegular(path); closeSync(fd);
    const start_at=s.start_at===undefined?"new":typeof s.start_at==="number"?integer(s.start_at,0,Number.MAX_SAFE_INTEGER):oneOf(s.start_at,["new","beginning"] as const);
    return { source_id, path, format: oneOf(s.format, ["codex", "claude", "pi", "atif"] as const), start_at };
  });
  return {
    schema_version: b.schema_version, binding_id: str(b.binding_id), task_id: str(b.task_id),
    project_id: nullable(b.project_id), client: oneOf(b.client, ["codex", "claude", "pi"] as const),
    profile: str(b.profile), runtime_home: b.runtime_home === null ? null : absolute(b.runtime_home),
    native_session_id: str(b.native_session_id), role: oneOf(b.role, ["master", "observer", "worker"] as const),
    source_root: root, sources
  };
}

export class Store {
  readonly db: Database;
  readonly state: string;
  readonly storeId: string;
  constructor(state: string, options: { initialize?: boolean; busyMs?: number } = {}) {
    this.state = privateState(state, options.initialize);
    const file = resolve(this.state, "store.sqlite");
    if (!existsSync(file)) {
      if (!options.initialize) fail("store_not_initialized");
      try { const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); closeSync(fd); } catch { fail("store_create_race"); }
    }
    privateState(this.state);
    this.db = new Database(file, { create: false, strict: true });
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${integer(options.busyMs ?? 100, 0, 1000)};`);
    const version = (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version === 0 && options.initialize) {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      this.db.transaction(() => { this.db.exec(SCHEMA); this.db.query("INSERT INTO meta VALUES('store_id',?)").run(randomUUID()); }).immediate();
    } else if (version !== VERSION) { this.db.close(); fail("store_version_unsupported"); }
    this.storeId = (this.db.query("SELECT value FROM meta WHERE key='store_id'").get() as { value: string }).value;
  }
  close(): void { this.db.close(); }
  link(kind: string, id: string): string { return `tcr://${this.storeId}/${kind}/${encodeURIComponent(id)}`; }
  count(name: string): void { this.db.query("INSERT INTO counters(name,value) VALUES(?,1) ON CONFLICT(name) DO UPDATE SET value=value+1").run(str(name, 128)); }
  bind(input: unknown): Binding {
    const b = validateBinding(input); const body = canonical(b);
    this.db.transaction(() => {
      const existing = this.db.query("SELECT body FROM bindings WHERE binding_id=?").get(b.binding_id) as { body: string } | null;
      if (existing) { if (existing.body !== body) fail("binding_conflict"); return; }
      if (this.activeBinding(b.client, b.profile, b.native_session_id)) fail("session_already_bound");
      this.db.query("INSERT INTO bindings(binding_id,task_id,project_id,client,profile,native_session_id,role,body) VALUES(?,?,?,?,?,?,?,?)")
        .run(b.binding_id, b.task_id, b.project_id, b.client, b.profile, b.native_session_id, b.role, body);
      for (const s of b.sources) {
        const fd=openRegular(s.path);let cursor=0,anchor="";
        try{
          const size=fstatSync(fd).size;
          if(s.start_at==="new"){
            cursor=size;
            if(s.format!=="atif" && size>0){
              const tail=range(fd,Math.max(0,size-65536),Math.min(size,65536));const last=tail.lastIndexOf(10);
              if(last<0&&size>65536)fail("source_tail_exceeds_bind_budget");
              cursor=last<0?0:size-tail.length+last+1;
            }
          }else if(typeof s.start_at==="number"){
            cursor=integer(s.start_at,0,size);
            if(s.format==="atif"&&cursor!==0&&cursor!==size)fail("atif_requires_document_boundary");
            if(s.format!=="atif"&&cursor>0&&range(fd,cursor-1,1)[0]!==10)fail("offset_not_record_boundary");
          }
          anchor=canonical(fingerprint(fd,cursor));
        }finally{closeSync(fd);}
        this.db.query("INSERT INTO sources VALUES(?,?,?,?)").run(b.binding_id, s.source_id, s.path, s.format);
        this.db.query("INSERT INTO source_states(binding_id,source_id,cursor,fingerprint,atif_complete) VALUES(?,?,?,?,?)").run(b.binding_id,s.source_id,cursor,anchor,s.format==="atif"&&s.start_at==="new"?1:0);
      }
    }).immediate();
    return b;
  }
  unbind(bindingId: string): boolean { return this.db.query("UPDATE bindings SET active=0 WHERE binding_id=? AND active=1").run(str(bindingId)).changes === 1; }
  binding(bindingId: string): Binding {
    const r = this.db.query("SELECT body FROM bindings WHERE binding_id=?").get(str(bindingId)) as { body: string } | null;
    if (!r) fail("binding_not_found"); return JSON.parse(r.body);
  }
  activeBinding(client: string, profile: string, sessionId: string): Binding | null {
    const r = this.db.query("SELECT body FROM bindings WHERE client=? AND profile=? AND native_session_id=? AND active=1")
      .get(client, profile, sessionId) as { body: string } | null;
    return r ? JSON.parse(r.body) : null;
  }
  enqueue(b: Binding, metadata: HookMetadata, now = Date.now()): { event_id: string; window_id: string; duplicate: boolean } {
    return this.db.transaction(() => {
      // Recheck activation inside the same write transaction as enqueue.
      const active = this.activeBinding(b.client, b.profile, b.native_session_id);
      if (!active || active.binding_id !== b.binding_id || active.role !== "master") fail("binding_inactive");
      if (metadata.native_session_id !== b.native_session_id) fail("session_binding_mismatch");
      const sourceBounds=b.sources.map(s=>{
        underRoot(s.path,b.source_root);const fd=openRegular(s.path);
        try{const info=fstatSync(fd);return{source_id:s.source_id,observed_end_offset:info.size,dev:info.dev,ino:info.ino};}finally{closeSync(fd);}
      });
      // Native callbacks do not consistently supply a delivery ID. The observed
      // source ceiling is part of our logical observation identity so a second
      // compaction in the same native turn cannot discard newly appended rows.
      const eventId="evt_"+sha(canonical([b.binding_id,metadata.hook_event_name,metadata.input_sha256,sourceBounds]));
      const windowId="win_"+sha(eventId);
      if(this.db.query("SELECT event_id FROM events WHERE event_id=?").get(eventId)){this.count("duplicate_hook");return{event_id:eventId,window_id:windowId,duplicate:true};}
      const telemetry=telemetryCorrelation(metadata.telemetry);
      const event = {
        event_id: eventId, binding_id: b.binding_id, task_id: b.task_id, client: b.client,
        profile: b.profile, native_session_id: metadata.native_session_id, native_turn_id: metadata.native_turn_id,
        hook_event_name: metadata.hook_event_name, input_sha256: metadata.input_sha256,
        observed_at: new Date(now).toISOString(), validation_level: "native_hook_metadata_only",
        telemetry,
        deeplink: this.link("events", eventId)
      };
      this.db.query("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?)")
        .run(eventId,b.binding_id,b.task_id,b.client,metadata.native_session_id,metadata.native_turn_id,metadata.hook_event_name,now,telemetry.trace_id,telemetry.span_id,canonical(event));
      const window = {
        window_id: windowId, event_id: eventId, binding_id: b.binding_id, task_id: b.task_id,
        native_session_id: metadata.native_session_id, hook_turn_id: metadata.native_turn_id,
        native_window_id: null, observed_at: event.observed_at, coverage: "incremental_source_pages",
        source_start_policies: b.sources.map(s=>({source_id:s.source_id,start_at:s.start_at??"new",historical_replay:s.start_at==="beginning"})),
        source_bounds: sourceBounds,
        telemetry,
        validation_level: "binding_association_not_native_row_identity", deeplink: this.link("windows", windowId)
      };
      this.db.query("INSERT INTO windows VALUES(?,?,?,?,?,?,?,?,?,?)").run(windowId,eventId,b.binding_id,b.task_id,metadata.native_session_id,metadata.native_turn_id,now,telemetry.trace_id,telemetry.span_id,canonical(window));
      for (const s of sourceBounds) this.db.query("INSERT INTO jobs(job_id,window_id,binding_id,source_id,target_size,target_dev,target_ino,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run("job_" + sha(canonical([eventId,s.source_id])),windowId,b.binding_id,s.source_id,s.observed_end_offset,s.dev,s.ino,now);
      this.count("enqueued_hook");
      return { event_id: eventId, window_id: windowId, duplicate: false };
    }).immediate();
  }
  claim(owner: string, leaseMs = 30000, now = Date.now(), cap = 32): Job | null {
    str(owner); integer(leaseMs, 100, 120000); integer(cap, 1, 32);
    return this.db.transaction(() => {
      const running = this.db.query("SELECT COUNT(*) AS n FROM jobs WHERE state='running' AND lease_until>?").get(now) as { n: number };
      if (running.n >= cap) return null;
      const candidate = this.db.query(`SELECT j.* FROM jobs j JOIN bindings b ON b.binding_id=j.binding_id
        WHERE b.active=1 AND b.role='master' AND (j.state='queued' OR (j.state='running' AND j.lease_until<=?))
        AND NOT EXISTS(SELECT 1 FROM jobs other WHERE other.binding_id=j.binding_id AND other.source_id=j.source_id AND other.state='running' AND other.lease_until>? AND other.job_id!=j.job_id)
        ORDER BY j.rowid LIMIT 1`).get(now,now) as Job | null;
      if (!candidate) return null;
      const token = owner + ":" + randomUUID();
      this.db.query("UPDATE jobs SET state='running',lease_token=?,lease_until=?,generation=generation+1,attempts=attempts+1,error_code=NULL WHERE job_id=?")
        .run(token,now+leaseMs,candidate.job_id);
      return this.db.query("SELECT * FROM jobs WHERE job_id=?").get(candidate.job_id) as Job;
    }).immediate();
  }
  renew(job: Job, leaseMs: number, now = Date.now()): boolean {
    integer(leaseMs,100,120000);
    return this.db.query("UPDATE jobs SET lease_until=? WHERE job_id=? AND state='running' AND lease_token=? AND generation=? AND lease_until>?")
      .run(now+leaseMs,job.job_id,job.lease_token,job.generation,now).changes === 1;
  }
  private fence(job: Job, now: number): void {
    if (!this.db.query("SELECT job_id FROM jobs WHERE job_id=? AND state='running' AND lease_token=? AND generation=? AND lease_until>?")
      .get(job.job_id,job.lease_token,job.generation,now)) fail("stale_worker_fenced");
  }
  sourceState(job: Job): SourceState {
    return this.db.query("SELECT * FROM source_states WHERE binding_id=? AND source_id=?").get(job.binding_id,job.source_id) as SourceState;
  }
  finishPage(job: Job, page: Page, start: number, next: number, fp: string, terminal: boolean, now = Date.now()): void {
    this.db.transaction(() => {
      this.fence(job,now);
      const state = this.sourceState(job);
      if (state.cursor !== start) fail("cursor_conflict");
      for (const record of page.records) {
        const content = canonical(record);
        const prior = this.db.query("SELECT body FROM records WHERE record_id=?").get(record.record_id) as { body: string } | null;
        if (prior && prior.body !== content) fail("record_identity_conflict");
        if (!prior) this.db.query("INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(record.record_id,record.client,record.kind,record.timestamp,record.native.session_id,record.native.turn_id,record.native.entry_id,record.native.trajectory_id,record.source.format,record.source.version===null?null:String(record.source.version),record.logical?.task_id??null,record.logical?.event_id??null,record.relay?.event_uuid??null,record.native_actor?.client??(record.client!=="atif"?record.client:null),record.atif?.session_id??null,record.atif?.trajectory_id??null,record.atif?.step_id==null?null:String(record.atif.step_id),content);
        this.db.query("INSERT OR IGNORE INTO record_windows VALUES(?,?)").run(record.record_id,job.window_id);
      }
      const pageId = "page_" + sha(canonical([job.job_id,start,next,page.records.map(r=>r.record_id)]));
      const body = { page_id: pageId, job_id: job.job_id, window_id: job.window_id, start_offset: start, next_offset: next,
        record_count: page.records.length, eof: page.eof, incomplete_tail: page.incomplete_tail,
        omissions: page.omissions, continuity: "inode_plus_head_and_cursor_anchor_and_record_slice_digests" };
      this.db.query("INSERT OR IGNORE INTO pages VALUES(?,?,?,?,?,?)").run(pageId,job.job_id,job.window_id,start,next,canonical(body));
      const source = this.binding(job.binding_id).sources.find(s=>s.source_id===job.source_id)!;
      this.db.query("UPDATE source_states SET cursor=?,fingerprint=?,atif_complete=? WHERE binding_id=? AND source_id=?")
        .run(next,fp,source.format==="atif" && terminal ? 1:0,job.binding_id,job.source_id);
      this.db.query("UPDATE jobs SET state=?,lease_token=NULL,lease_until=NULL,finished_at=? WHERE job_id=?")
        .run(terminal ? "succeeded":"queued",terminal ? now:null,job.job_id);
    }).immediate();
  }
  finishUnchanged(job: Job, now = Date.now()): void {
    this.db.transaction(()=>{this.fence(job,now);this.db.query("UPDATE jobs SET state='succeeded',lease_token=NULL,lease_until=NULL,finished_at=? WHERE job_id=?").run(now,job.job_id);}).immediate();
  }
  failJob(job: Job, code: string, now = Date.now()): void {
    this.db.transaction(()=>{
      this.fence(job,now);
      this.db.query("UPDATE jobs SET state='failed',error_code=?,lease_token=NULL,lease_until=NULL,finished_at=? WHERE job_id=?").run(str(code,128),now,job.job_id);
      this.count("failed_job");
    }).immediate();
  }
  retry(jobId: string): boolean {
    return this.db.query("UPDATE jobs SET state='queued',error_code=NULL,finished_at=NULL WHERE job_id=? AND state='failed'").run(str(jobId)).changes===1;
  }
  status(): Record<string, unknown> {
    return {
      schema_version: "task-checkpoint-record.status.v1", store_id: this.storeId,
      bindings: this.db.query("SELECT COUNT(*) AS n FROM bindings WHERE active=1").get(),
      jobs: this.db.query("SELECT state,COUNT(*) AS count FROM jobs GROUP BY state ORDER BY state").all(),
      records: this.db.query("SELECT COUNT(*) AS n FROM records").get(),
      counters: this.db.query("SELECT name,value FROM counters ORDER BY name").all(),
      services: (this.db.query("SELECT service_id,pid,heartbeat,stop_requested,state FROM services ORDER BY heartbeat DESC LIMIT 10").all() as {state:string;heartbeat:number}[])
        .map(s=>({...s,liveness:s.state==="running"&&s.heartbeat<Date.now()-5000?"heartbeat_stale":s.state}))
    };
  }
  cachedRecall(bindingId: string): Record<string, unknown> {
    const b = this.binding(bindingId);
    const rows = this.db.query("SELECT w.window_id,w.hook_turn_id,w.created_at,COUNT(DISTINCT rw.record_id) AS record_count FROM windows w LEFT JOIN record_windows rw ON rw.window_id=w.window_id WHERE w.binding_id=? GROUP BY w.window_id ORDER BY w.created_at DESC,w.window_id LIMIT 3")
      .all(bindingId) as {window_id:string;hook_turn_id:string|null;created_at:number;record_count:number}[];
    return { task_id:b.task_id,native_session_id:b.native_session_id,generated_at:new Date().toISOString(),
      windows: rows.map(r=>({...r,deeplink:this.link("windows",r.window_id)})),
      jobs: this.db.query("SELECT state,COUNT(*) AS count FROM jobs WHERE binding_id=? GROUP BY state ORDER BY state").all(bindingId),
      meaning:"Cached extraction metadata; no task acceptance or review verdict." };
  }
  query(options: QueryOptions): Record<string, unknown> {
    const kind=oneOf(options.kind,["records","events","windows","checkpoints"] as const);
    const filters=options.filters ?? {}; const fields=options.fields ?? DEFAULT_FIELDS[kind];
    const limit=integer(options.limit ?? 20,1,100); const offset=integer(options.offset ?? 0,0,10000);
    if(!Array.isArray(fields)||fields.length<1||fields.length>24||new Set(fields).size!==fields.length)fail("invalid_fields");
    for(const field of fields)if(!QUERY_FIELDS[kind].includes(field))fail("unknown_query_field");
    const clauses:string[]=[];const params:string[]=[];const related:string[]=[];const relatedParams:string[]=[];
    for(const [key,value] of Object.entries(filters)){
      str(value);
      if(kind==="records" && ["task_id","binding_id","window_id","hook_turn_id"].includes(key)){
        related.push(`w.${key}=?`);relatedParams.push(value);
      } else {
        if(!Object.hasOwn(FILTER_COLUMNS[kind],key))fail("unknown_query_filter");
        const column=FILTER_COLUMNS[kind][key];clauses.push(`r.${column}=?`);params.push(value);
      }
    }
    if(related.length){clauses.push(`EXISTS(SELECT 1 FROM record_windows rw JOIN windows w ON rw.window_id=w.window_id WHERE rw.record_id=r.record_id AND ${related.join(" AND ")})`);params.push(...relatedParams);}
    const id=ID_COLUMNS[kind];
    const rows=this.db.query(`SELECT r.body FROM ${kind} r ${clauses.length?"WHERE "+clauses.join(" AND "):""} ORDER BY r.${id} LIMIT ? OFFSET ?`).all(...params,limit+1,offset) as {body:string}[];
    const items=rows.slice(0,limit).map(row=>{
      const original=JSON.parse(row.body); if(kind==="records"){original.deeplink=this.link(kind,original.record_id);original.native_client=original.native_actor?.client??(original.client!=="atif"?original.client:null);}
      const projected:Record<string,unknown>={};for(const field of fields){let v:any=original;for(const part of field.split("."))v=v?.[part];projected[field]=v??null;}return projected;
    });
    const result={schema_version:"task-checkpoint-record.query.v1",store_id:this.storeId,kind,items,next_offset:rows.length>limit?offset+limit:null};
    limitedJSON(result);return result;
  }
  resolve(link: string, fields?: string[]): Record<string, unknown> {
    let url: URL;try{url=new URL(str(link,2048));}catch{return fail("invalid_deeplink");}
    if(url.protocol!=="tcr:"||url.hostname!==this.storeId||url.port||url.username||url.password||url.search||url.hash)fail("foreign_deeplink");
    const parts=url.pathname.split("/");if(parts.length!==3)fail("invalid_deeplink");
    const kind=oneOf(parts[1],["records","windows","events","checkpoints"] as const);
    let id:string;try{id=decodeURIComponent(parts[2]);}catch{return fail("invalid_deeplink");}str(id);
    const found=this.query({kind,filters:{[ID_COLUMNS[kind]]:id},fields,limit:1});
    if((found.items as unknown[]).length!==1)fail("deeplink_not_found");return found;
  }
  importCheckpoint(bindingId: string, file: string, now=Date.now()): Record<string, unknown> {
    const binding=this.binding(bindingId);const bytes=readFileBounded(absolute(file),256*1024);
    let parsed:unknown;try{parsed=JSON.parse(bytes.toString("utf8"));}catch{return fail("invalid_json");}
    const event=object(parsed);
    if(event.schema_version!=="task-turns-checkpoint.v1"||event.event_type!=="task_turns_checkpoint")fail("checkpoint_version_unsupported");
    if(object(event.task).task_id!==binding.task_id)fail("checkpoint_task_mismatch");
    const facets=object(event.facets);if(!Array.isArray(facets.native_sessions))fail("checkpoint_binding_missing");
    const primary=facets.native_sessions.filter((s:any)=>Array.isArray(s.roles)&&s.roles.includes("primary_actor"));
    if(primary.length!==1||primary[0]?.native_session_id?.status!=="observed"||primary[0]?.native_session_id?.value!==binding.native_session_id||primary[0]?.client!==binding.client)fail("checkpoint_binding_mismatch");
    const privacy=object(event.privacy);if(privacy.visibility!=="private"||privacy.access_scope!=="local_user"||privacy.content!=="metadata_only")fail("checkpoint_privacy_mismatch");
    const ref=(value:unknown)=>{const r=object(value);return {record_id:str(r.record_id),uri:str(r.uri,2048),json_pointer:typeof r.json_pointer==="string"&&r.json_pointer.length<=2048&&/^(?:\/(?:[^~]|~[01])*)?$/.test(r.json_pointer)?r.json_pointer:fail("invalid_pointer"),sha256:digest(r.sha256)};};
    const checkpointId="cp_"+sha(canonical([bindingId,str(event.event_id)]));
    const body={checkpoint_id:checkpointId,binding_id:bindingId,task_id:binding.task_id,native_session_id:binding.native_session_id,
      event_id:str(event.event_id),event_type:event.event_type,source_event_sha256:sha(bytes),source_event_uri:pathToFileURL(file).href,
      checkpoint_ref:ref(event.checkpoint_ref),provenance_ref:ref(event.provenance_ref),
      validation_level:"envelope_and_primary_binding_only_not_full_schema_or_artifact_verification",validation_caveat:"Artifact pointers were not opened. This import supplies no task acceptance or source access.",
      deeplink:this.link("checkpoints",checkpointId)};
    limitedJSON(body,16*1024);const text=canonical(body);
    this.db.transaction(()=>{
      const old=this.db.query("SELECT body FROM checkpoints WHERE checkpoint_id=?").get(checkpointId) as {body:string}|null;
      if(old&&old.body!==text)fail("checkpoint_identity_conflict");
      if(!old)this.db.query("INSERT INTO checkpoints VALUES(?,?,?,?,?,?)").run(checkpointId,bindingId,binding.task_id,binding.native_session_id,now,text);
    }).immediate();return body;
  }
  registerService(token: string, now=Date.now()): void {
    this.db.transaction(()=>{
      const existing=this.db.query("SELECT heartbeat,state FROM services WHERE service_id='daemon'").get() as {heartbeat:number;state:string}|null;
      if(existing?.state==="running"&&existing.heartbeat>now-5000)fail("service_already_running");
      this.db.query("INSERT INTO services VALUES('daemon',?,?,?,0,'running') ON CONFLICT(service_id) DO UPDATE SET token=excluded.token,pid=excluded.pid,heartbeat=excluded.heartbeat,stop_requested=0,state='running'")
        .run(str(token),process.pid,now);
    }).immediate();
  }
  heartbeat(token: string, now=Date.now()): boolean {
    const r=this.db.query("UPDATE services SET heartbeat=? WHERE service_id='daemon' AND token=? AND state='running' AND stop_requested=0").run(now,token);return r.changes===1;
  }
  stopService(): boolean {return this.db.query("UPDATE services SET stop_requested=1 WHERE service_id='daemon' AND state='running'").run().changes===1;}
  serviceStopped(token:string):void{this.db.query("UPDATE services SET state='stopped',heartbeat=? WHERE service_id='daemon' AND token=?").run(Date.now(),token);}
}

const ID_COLUMNS={records:"record_id",windows:"window_id",events:"event_id",checkpoints:"checkpoint_id"};
export const FILTER_COLUMNS:Record<QueryOptions["kind"],Record<string,string>>={
  records:{record_id:"record_id",client:"client",kind:"kind",native_client:"native_client",native_session_id:"native_session_id",native_turn_id:"native_turn_id",entry_id:"entry_id",trajectory_id:"trajectory_id",source_format:"source_format",source_version:"source_version",source_task_id:"source_task_id",source_event_id:"source_event_id",relay_event_uuid:"relay_event_uuid",atif_session_id:"atif_session_id",atif_trajectory_id:"atif_trajectory_id",atif_step_id:"atif_step_id"},
  windows:{window_id:"window_id",event_id:"event_id",binding_id:"binding_id",task_id:"task_id",native_session_id:"native_session_id",hook_turn_id:"hook_turn_id",trace_id:"trace_id",span_id:"span_id"},
  events:{event_id:"event_id",binding_id:"binding_id",task_id:"task_id",client:"client",native_session_id:"native_session_id",native_turn_id:"native_turn_id",hook_event_name:"hook_event_name",trace_id:"trace_id",span_id:"span_id"},
  checkpoints:{checkpoint_id:"checkpoint_id",binding_id:"binding_id",task_id:"task_id",native_session_id:"native_session_id"}
};
const DEFAULT_FIELDS:Record<QueryOptions["kind"],string[]>={
  records:["record_id","client","kind","native_client","native.session_id","native.turn_id","deeplink"],
  windows:["window_id","task_id","hook_turn_id","coverage","deeplink"],
  events:["event_id","task_id","hook_event_name","native_turn_id","deeplink"],
  checkpoints:["checkpoint_id","task_id","validation_level","deeplink"]
};
export const QUERY_FIELDS:Record<QueryOptions["kind"],string[]>={
  records:[...DEFAULT_FIELDS.records,"timestamp","native.entry_id","native.parent_entry_id","native.trajectory_id","native.step_id","source.uri","source.format","source.version","source.offset","source.length","source.sha256","source.json_pointer","labels","text_available","logical.event_id","logical.task_id","logical.run_id","logical.project_id","relay.event_uuid","relay.parent_scope_uuid","relay.propagation_root_uuid","relay.atof_version","relay.name","atif.session_id","atif.trajectory_id","atif.step_id","native_actor.client","native_actor.session_ref","native_actor.roles","native_actor.provenance_ref"],
  windows:[...DEFAULT_FIELDS.windows,"event_id","binding_id","native_session_id","native_window_id","observed_at","validation_level","source_start_policies","source_bounds","telemetry.namespace","telemetry.source","telemetry.trace_id","telemetry.span_id"],
  events:[...DEFAULT_FIELDS.events,"binding_id","client","profile","native_session_id","observed_at","input_sha256","validation_level","telemetry.namespace","telemetry.source","telemetry.trace_id","telemetry.span_id"],
  checkpoints:[...DEFAULT_FIELDS.checkpoints,"binding_id","native_session_id","event_id","event_type","source_event_sha256","source_event_uri","checkpoint_ref","provenance_ref","validation_caveat"]
};
