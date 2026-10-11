import {readFile,writeFile,mkdir,rename,chmod} from 'node:fs/promises';
import {dirname} from 'node:path';
export class StateStore {
  constructor(file){this.file=file;this.queue=Promise.resolve();}
  async load(){
    let state;
    try{state=JSON.parse(await readFile(this.file,'utf8'));}
    catch(e){if(e.code==='ENOENT')state={version:1,ownerId:'',watching:false,trading:false,activationMode:'',chains:['base','bsc'],amount:null,lastAlerts:{},ledger:{}};else throw new Error('Cannot read bot state; repair the file before starting.');}
    if(state.version!==1||!Array.isArray(state.chains)||!state.chains.length||state.chains.some(c=>!['base','bsc'].includes(c))||typeof state.ledger!=='object'||typeof state.lastAlerts!=='object')throw new Error('Invalid bot state.');
    state.config??={};state.executors??={};state.operations??={};state.history??=[];
    this.state=state;return state;
  }
  save(){
    const snapshot=JSON.stringify(this.state,null,2)+'\n';
    const write=async()=>{await mkdir(dirname(this.file),{recursive:true,mode:0o700});const temp=this.file+'.tmp';await writeFile(temp,snapshot,{mode:0o600});await chmod(temp,0o600);await rename(temp,this.file);};
    // Persist in invocation order even when polling and trading finish concurrently.
    const job=this.queue.then(write);this.queue=job.catch(()=>{});return job;
  }
}
export function todayLedger(state,chain,now=new Date()) {
  const day=now.toISOString().slice(0,10);
  let record=state.ledger[chain];
  if(!record)record=state.ledger[chain]={day,count:0,gasReserved:'0',pending:null,lastAttemptAt:0};
  if(record.day!==day){record.day=day;record.count=0;record.gasReserved='0';}
  return record;
}
