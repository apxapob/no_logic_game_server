import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
const game=resolve(process.env.GENERAL_GAME_DIRECTORY || '../General-recovery/game');
const output=resolve('test-results/rust-general-smoke');
await mkdir(output,{recursive:true});
const baseURL='http://127.0.0.1:1427';
const dev=spawn(process.execPath,[resolve(game,'node_modules/vite-plus/bin/vp'),'dev','--host','127.0.0.1','--port','1427','--strictPort'],{cwd:game,stdio:['ignore','pipe','pipe'],windowsHide:true});
let devOutput='';for(const stream of [dev.stdout,dev.stderr])stream.on('data',b=>{devOutput=(devOutput+b).slice(-10000);});
const relay=spawn(resolve('target/release/no-logic-game-server'+(process.platform==='win32'?'.exe':'')),[],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',SESSION_DIRECTORY:resolve(output,'sessions'),ALLOWED_ORIGINS:baseURL,TELEMETRY_ENABLED:'false',FCM_ENABLED:'false',MAX_CONNECTIONS_PER_MINUTE:'1000'},stdio:['pipe','pipe','inherit'],windowsHide:true});
const exited=new Promise(resolve=>relay.once('exit',resolve));
let run;
try{
 const relayURL=await new Promise((resolve,reject)=>{relay.once('error',reject);relay.once('exit',code=>reject(new Error('Relay exited '+code)));createInterface({input:relay.stdout}).on('line',line=>{const v=JSON.parse(line);if(v.event==='server.listening')resolve(`ws://127.0.0.1:${v.address.port}/`);});});
 const {createChaosRun,until}=await import(pathToFileURL(resolve(game,'scripts/online-chaos.mjs')));
 await until(async()=>{if(dev.exitCode!==null)throw new Error(devOutput);try{return (await fetch(baseURL)).ok;}catch{return false;}},'local client dev server',30000);
 run=await createChaosRun({baseURL,relayURL,output});await run.start();
 for(let turn=0;turn<3;turn++){const before=await run.read(run.links[0]);for(const link of run.links)await run.submit(link);await until(async()=> (await run.read(run.links[0])).year>before.year,'next year');await run.equal(`turn ${turn+1}`);}
 const host=run.host();run.cut(host,'Rust host migration smoke');await run.equal('host departed',run.online());await run.resume(host);await until(()=>run.ready(host),'host rejoined',30000);await run.equal('former host rejoined');
 if(run.errors.length)throw new Error(`Client errors: ${run.errors.length}`);
 const result={clients:3,turns:3,hostMigration:true,rejoin:true,checkpoints:run.checkpoints,errors:run.errors.length};
 await writeFile(resolve(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{
 await run?.close();relay.stdin.end('stop\n');await exited;
 if(dev.exitCode===null){if(process.platform==='win32')await new Promise(resolve=>execFile('taskkill',['/PID',String(dev.pid),'/T','/F'],{windowsHide:true},resolve));else dev.kill('SIGTERM');}
}
