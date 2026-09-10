import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
let count=0;
function check(name,fn){fn();count++;console.log('PASS '+name);}
const backend=['Code','Auth','Api'].map(n=>read('apps-script/'+n+'.gs')).join('\n');
check('Apps Script syntax',()=>new vm.Script(backend));
for(const name of ['index','staff','client']) {
  const html=read('docs/'+name+'.html');
  check(name+' has static HTML and valid inline JavaScript',()=>{
    assert(!html.includes('<?')); assert(!html.includes('google.script.run'));
    for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if(!/\bsrc=/.test(match[1]))new vm.Script(match[2],{filename:name+'.html'});
    }
    for(const match of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
      if(!match[1].startsWith('https://'))assert(fs.existsSync(path.join(root,'docs',match[1])));
    }
  });
}
const cache=new Map();
const context=vm.createContext({console,Date,JSON,
  CacheService:{getScriptCache:()=>({get:k=>cache.get(k)||null,put:(k,v)=>cache.set(k,v),remove:k=>cache.delete(k),removeAll:keys=>keys.forEach(k=>cache.delete(k))})},
  ContentService:{MimeType:{JSON:'json'},createTextOutput:text=>({text,setMimeType(){return this;}})},
  LockService:{getScriptLock:()=>({tryLock:()=>true,hasLock:()=>true,releaseLock(){}})}
});
vm.runInContext(backend,context);
const post=req=>JSON.parse(context.doPost({postData:{contents:JSON.stringify(req)}}).text);
check('health endpoint and malformed request envelope',()=>{
  assert(post({version:1,method:'health',args:[]}).ok);
  assert.equal(post({version:2,method:'health',args:[]}).ok,false);
  assert.equal(JSON.parse(context.doPost({postData:{contents:'{invalid'}}).text).ok,false);
});
check('unknown methods and setup functions are unreachable',()=>{
  for(const method of ['setupDemoData','setupProduction','constructor','toString','setSetting_'])assert.equal(post({version:1,method,args:[]}).ok,false);
});
check('missing session rejects private calls',()=>{
  assert.equal(post({version:1,method:'getDashboard',args:[]}).error.code,'SESSION_EXPIRED');
});
const token='a'.repeat(64);
let user={Email:'client@example.test',Name:'Client',Role:'Client',Portal:'Client',Client:'Org A',Active:'Yes','Password Hash':'hash1'};
context.findUser_=()=>user;
cache.set('sess_'+token,JSON.stringify({email:user.Email,authVersion:'hash1'}));
check('live account, password and role changes affect sessions',()=>{
  assert.equal(context.session_(token).portal,'Client');
  user.Active='No';assert.equal(context.session_(token),null);
  user.Active='Yes';cache.set('sess_'+token,JSON.stringify({email:user.Email,authVersion:'old'}));assert.equal(context.session_(token),null);
  cache.set('sess_'+token,JSON.stringify({email:user.Email,authVersion:'hash1'}));
  user.Role='Reviewer';user.Portal='Staff';assert.equal(context.session_(token).role,'Reviewer');
  user.Role='Client';user.Portal='Client';
});
check('client cannot call staff APIs or internal functions',()=>{
  for(const method of ['getSheet','getDashboard','resetPassword','addRow']) assert.equal(post({version:1,method,args:['Users'],token}).ok,false);
});
check('client context contains no staff directory or internal configuration',()=>{
  context.CURRENT=context.session_(token);context.setting_=()=> 'Example Lab';
  const data=context.getContext();
  assert.equal(data.client,'Org A');assert.equal(data.users,undefined);assert.equal(data.schema,undefined);
  assert.deepEqual(Object.keys(data.settings),['Lab Name']);
});
check('client sample ownership enforced before results load',()=>{
  context.CURRENT=context.session_(token);context.getRow_=()=>({Client:'Org B'});
  assert.throws(()=>context.clientSample('S-26-0001'),/Sample not found/);
});
check('generic writes cannot bypass result approval or edit audit history',()=>{
  context.CURRENT={portal:'Staff',role:'Analyst',email:'analyst@example.test'};
  assert.throws(()=>context.authorizeApi_('updateRow',['Results','R-1',[]]),/dedicated workflow/);
  assert.throws(()=>context.authorizeApi_('addRow',['AuditTrail',[]]),/dedicated workflow/);
  assert.throws(()=>context.authorizeApi_('setField',['Users','admin','Role','Admin']),/cannot do this/);
});
check('GET ignores method parameters and cannot mutate data',()=>{
  assert.equal(JSON.parse(context.doGet({parameter:{method:'setupDemoData'}}).text).data.status,'online');
  assert.equal(context.CURRENT,null);assert.equal(context.PUBLIC_OK,false);
});
check('every literal frontend workflow call has a backend handler',()=>{
  for(const name of ['staff','client']) {
    for(const match of read('docs/'+name+'.html').matchAll(/run\('([^']+)'/g)) assert.equal(typeof context.FN[match[1]],'function',match[1]);
  }
});
check('third certificate revision advances and preserves superseded history',()=>{
  const c=vm.createContext({console,Date,JSON});vm.runInContext(backend,c);
  c.CURRENT={role:'Technical Manager',portal:'Staff',email:'manager@example.test'};
  c.setting_=()=>'';c.email_=()=>c.CURRENT.email;c.today_=()=> '2026-09-09';c.now_=c.today_;
  c.getRow_=(name)=>name==='Samples'?{Client:'Org A','Sample Type':'Water',Description:'Example',Received:'2026-09-01'}:null;
  const reports=[['COA-26-1','S-26-1','Org A',1,'2026-09-01','Manager','Superseded'],['COA-26-1','S-26-1','Org A',2,'2026-09-02','Manager','Issued']];
  c.read_=name=>({rows:name==='Reports'?reports:name==='Results'?[['R-1','S-26-1','PH','7','pH','','','','','QC Pass','analyst','','Approved']]:[]});
  const effects=[];
  c.sh_=()=>({getRange:(row,col)=>({setValue:v=>{effects.push('supersede');reports[row-2][col-1]=v;}}),appendRow:row=>{effects.push('append');reports.push(row);}});
  c.setField_=()=>{};c.audit_=()=>{};
  c.Utilities={getUuid:()=> 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',newBlob:()=>({getAs:()=>({setName:()=>({})})})};
  c.coaFolder_=()=>({createFile:()=>{effects.push('create');return {setSharing(){},getUrl:()=> 'https://drive.google.com/file/d/example/view'};}});
  c.DriveApp={Access:{ANYONE_WITH_LINK:1},Permission:{VIEW:1}};
  const result=c.generateCOA('S-26-1','Corrected description');
  assert.equal(result.revision,3);assert.equal(reports[0][6],'Superseded');assert.equal(reports[1][6],'Superseded');assert.equal(reports[2][6],'Issued');
  assert.deepEqual(effects,['create','supersede','append']);
});

// Frontend transport tests: no browser or Google account needed.
const saved=new Map(), requests=[], redirects=[];
let response={ok:true,data:{token,portal:'Staff'}};
const browser=vm.createContext({URL,JSON,Set,AbortController,TypeError,Error,
  window:{LIMS_CONFIG:{apiUrl:'https://script.google.com/macros/s/test/exec',timeoutMs:1000}},
  location:{href:'https://example.github.io/lims/staff.html',pathname:'/lims/staff.html',assign:u=>redirects.push(u),replace:u=>redirects.push(u)},
  sessionStorage:{getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)},
  document:{addEventListener(){}},setTimeout:()=>1,clearTimeout(){},
  fetch:async (url,options)=>{requests.push({url,options});return {ok:true,json:async()=>response};}
});
vm.runInContext(read('docs/assets/api.js'),browser);
const api=browser.window.LimsAPI;
api.saveSession({token,portal:'Staff'});
await api.call('getContext');
check('HTTPS POST transport keeps credentials in body and follows redirects',()=>{
  const req=requests.at(-1),body=JSON.parse(req.options.body);
  assert.equal(req.options.method,'POST');assert.equal(req.options.mode,'cors');assert.equal(req.options.credentials,'omit');assert.equal(req.options.redirect,'follow');
  assert.equal(req.options.headers['Content-Type'],'text/plain;charset=UTF-8');assert.equal(body.token,token);assert(!req.url.includes(token));
  assert(saved.has('lims.session:/lims/'));
});
await api.publicCall('login','person@example.test','example-password','Staff');
check('public login body has no old session token',()=>assert.equal(JSON.parse(requests.at(-1).options.body).token,''));
response={ok:false,error:{code:'SESSION_EXPIRED',message:'SESSION_EXPIRED'}};
await assert.rejects(api.call('getContext'),/SESSION_EXPIRED/);
check('expired sessions are cleared and redirected within the repository',()=>{
  assert.equal(saved.size,0);assert.equal(redirects.at(-1),'https://example.github.io/lims/index.html');
});
api.saveSession({token,portal:'Staff'});response={ok:true,data:true};
await api.call('logout');
check('logout clears local session',()=>assert.equal(saved.size,0));
console.log('\n'+count+' checks passed. Google deployment and browser CORS remain live smoke-test gates.');
