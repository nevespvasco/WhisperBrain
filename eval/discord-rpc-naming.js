'use strict';
// naming accuracy on the simulated Discord call set (same streams as test/discord-rpc-names.test.js), before (no names) and after (RPC)
const R = require('node:path').join(__dirname, '..') + '/';
const { EventEmitter } = require('node:events');
const { SignalHub } = require(R+'src/meet/hub');
const { MeetingCollector } = require(R+'src/meet/collector');
const { DiscordRpcSource } = require(R+'src/discord/rpc-source');
const { namingAccuracy } = require(R+'eval/metrics');
class FakeRpc extends EventEmitter { constructor(){super(); this.st={state:'connected',detail:'',user:{id:'100',name:'Vasco'},call:null}; this.people=[];} status(){return {...this.st,call:this.st.call&&{...this.st.call,people:this.people}}} join(p){this.people=p;this.st.call={id:'c1',name:'S'};this.emit('call',this.st.call);this.emit('roster',p)} speak(u,s=true){this.emit('speaking',{userId:u,speaking:s})} }
const P=(id,name,self=false)=>({id,name,self});
const ME=P('100','Vasco',true), ANA=P('200','Ana Silva'), BRUNO=P('300','Bruno Costa'), CARLA=P('400','Carla Dias');
const SCRIPT=[['s1',0,6000],['s2',6500,12000],['s3',12500,20000],['s1',20500,26000],['s2',26500,31000],['s3',31500,36000]];
const TRUTH={s1:ANA,s2:BRUNO,s3:CARLA};
const utt=SCRIPT.map(([id,a,b])=>({speaker:'them',speakerId:id,startMs:a,endMs:b,words:Array.from({length:Math.floor((b-a)/500)},(_,k)=>['w',k*500,k*500+400])}));
const speech=new Map(); for(const [id,a,b] of SCRIPT) speech.set(id,[...(speech.get(id)||[]),[a,b]]);
const truth=Object.fromEntries(Object.entries(TRUTH).map(([k,v])=>[k,v.name]));
function run(events){ let now=0; const hub=new SignalHub(); const col=new MeetingCollector({hub,elapsed:()=>now}); const rpc=new FakeRpc(); const src=new DiscordRpcSource({hub,rpc,every:()=>({stop(){}})}); src.start(); for(const [ms,fn] of [...events].sort((a,b)=>a[0]-b[0])){now=ms;fn(rpc)} const res=col.vote(utt,{endMs:40000}); return namingAccuracy({speech,truth,assigned:new Map(res.named.map(n=>[n.speakerId,n.name]))}); }
const stream=({lag=150,who=(id)=>TRUTH[id],noise=0}={})=>{ const ev=[]; let k=0; for(const [id,a,b] of SCRIPT){ const w=(k++%6<noise)?ANA:who(id); ev.push([a+lag,r=>r.speak(w.id)],[b+lag,r=>r.speak(w.id,false)]); } return ev; };
const roster=[[0,r=>r.join([ME,ANA,BRUNO,CARLA])]];
const rows=[
 ['no names (before)', namingAccuracy({speech,truth,assigned:new Map()})],
 ['clean stream, 150 ms lag', run([...roster,...stream()])],
 ['clean stream, 400 ms lag', run([...roster,...stream({lag:400})])],
 ['clean stream, 1000 ms lag', run([...roster,...stream({lag:1000})])],
 ['2 of 6 highlights name the wrong person', run([...roster,...stream({noise:2})])],
 ['everything names one person', run([...roster,...stream({who:()=>ANA})])],
 ['every voice overlapped by a second speaker', run([[0,r=>r.join([ME,ANA,BRUNO,CARLA,P('999','Noise')])],...SCRIPT.flatMap(([id,a,b])=>[[a+150,r=>{r.speak(TRUTH[id].id);r.speak('999')}],[b+150,r=>{r.speak(TRUTH[id].id,false);r.speak('999',false)}]])])],
];
for(const [n,r] of rows) console.log(`${n.padEnd(46)} accuracy ${(r.accuracy*100).toFixed(0)}%  right ${r.rightMs} wrong ${r.wrongMs} unnamed ${r.unnamedMs} (ms)`);
