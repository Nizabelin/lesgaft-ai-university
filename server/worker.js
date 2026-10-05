import {PROVIDERS,AppError,complete} from './providers.js';
import {SYSTEM_PROMPT,SCOPE_PROMPT} from './prompts.js';
const defaults=()=>({profiles:[],activeId:null,enabled:false,dailyLimit:500,perMinute:60,maxConcurrent:8});
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const bytesTo64=bytes=>btoa(String.fromCharCode(...bytes));
const from64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function hash(s){return bytesTo64(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))));}
async function cryptoKey(env){try{const bytes=from64(env.ENCRYPTION_KEY||'');if(bytes.length!==32)throw Error();return await crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['encrypt','decrypt']);}catch{throw new AppError('Администратору нужно настроить ENCRYPTION_KEY на сервере.',503);}}
async function encrypt(key,env){const iv=crypto.getRandomValues(new Uint8Array(12));const data=await crypto.subtle.encrypt({name:'AES-GCM',iv},await cryptoKey(env),new TextEncoder().encode(key));return {iv:bytesTo64(iv),data:bytesTo64(new Uint8Array(data))};}
async function decrypt(secret,env){try{return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:from64(secret.iv)},await cryptoKey(env),from64(secret.data)));}catch{throw new AppError('Не удалось прочитать ключ. Проверьте ENCRYPTION_KEY или заново сохраните API-ключ.',503);}}
async function readJSON(request,max=64000){
  if(!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))throw new AppError('Ожидается JSON.',415);
  if(Number(request.headers.get('Content-Length'))>max)throw new AppError('Слишком большой запрос.',413);
  if(!request.body)throw new AppError('Пустой запрос.');
  const reader=request.body.getReader(),decoder=new TextDecoder();let raw='',size=0;
  try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>max){await reader.cancel();throw new AppError('Слишком большой запрос.',413);}raw+=decoder.decode(value,{stream:true});}raw+=decoder.decode();}finally{reader.releaseLock();}
  try{return JSON.parse(raw);}catch{throw new AppError('Некорректный JSON.');}
}
function number(value,min,max,name){if(!Number.isInteger(value)||value<min||value>max)throw new AppError(`${name}: допустимо от ${min} до ${max}.`);return value;}
export function validateMessages(messages){
  if(!Array.isArray(messages)||!messages.length||messages.length>24)throw new AppError('Отправьте от 1 до 24 сообщений.');
  let size=0;
  const clean=messages.map(m=>{if(!m||!['user','assistant'].includes(m.role)||typeof m.content!=='string'||!m.content.trim()||m.content.length>12000)throw new AppError('Недопустимое сообщение.');size+=m.content.length;return {role:m.role,content:m.content};});
  if(size>30000||clean[0].role!=='user'||clean.at(-1).role!=='user')throw new AppError('Слишком длинная или некорректная история. Начните новый диалог.');
  return clean;
}
function publicProfile(p){return {id:p.id,label:p.label,provider:p.provider,model:p.model,maxTokens:p.maxTokens,hasKey:!!p.secret};}
function redirectText(question){let tail='Можем обсудить движение, питание, сон или восстановление. С какой привычки хотите начать?';if(/код|программ|python|игр|компьют/i.test(question))tail='В этой теме я могу помочь с режимом сна, перерывами и самочувствием за компьютером. Хотите обсудить здоровый режим учёбы или игр?';else if(/эконом|деньг|бюджет/i.test(question))tail='Можем обсудить питание и физическую активность с небольшим бюджетом. Что для вас важнее?';return 'Моя специализация — **здоровый образ жизни**.\n\n'+tail;}
// Один Durable Object хранит настройки и атомарно считает общий лимит расходов.
// Никакие методы чтения API-ключей не опубликованы.
export class AppState {
  constructor(ctx,env){this.ctx=ctx;this.env=env;}
  async config(){return await this.ctx.storage.get('config')||defaults();}
  async auth(request){
    const expected=this.env.ADMIN_TOKEN||'';
    if(expected.length<32)throw new AppError('На сервере не настроен ADMIN_TOKEN (минимум 32 символа).',503);
    const actual=request.headers.get('Authorization')||'';
    const a=await hash(actual),b=await hash('Bearer '+expected);let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);
    if(diff)throw new AppError('Неверный пароль администратора.',401);
  }
  async ipKey(request){return hash((this.env.ADMIN_TOKEN||'')+'|'+(request.headers.get('CF-Connecting-IP')||'unknown'));}
  async adminRate(request){const ip=await this.ipKey(request),minute=Math.floor(Date.now()/60000);await this.ctx.storage.transaction(async tx=>{let rate=await tx.get('adminRate');if(!rate||rate.minute!==minute)rate={minute,ips:{}};if((rate.ips[ip]||0)>=30)throw new AppError('Слишком много обращений к панели. Подождите минуту.',429);rate.ips[ip]=(rate.ips[ip]||0)+1;await tx.put('adminRate',rate);});}
  async reserve(request,admin=false){const ip=await this.ipKey(request),now=Date.now(),day=new Date().toISOString().slice(0,10),minute=Math.floor(now/60000),id=crypto.randomUUID();
    return this.ctx.storage.transaction(async tx=>{const cfg=await tx.get('config')||defaults();if(!admin&&!cfg.enabled)throw new AppError('Чат временно выключен администратором.',503);
      let quota=await tx.get('quota');if(!quota||quota.day!==day)quota={day,count:0,minute,ips:{},leases:{}};
      quota.leases=Object.fromEntries(Object.entries(quota.leases).filter(([,expires])=>expires>now));if(quota.minute!==minute){quota.minute=minute;quota.ips={};}
      if(quota.count>=cfg.dailyLimit)throw new AppError('Достигнут общий лимит запросов на сегодня. Попробуйте завтра.',429);
      if(Object.keys(quota.leases).length>=cfg.maxConcurrent)throw new AppError('Сейчас все места заняты. Повторите запрос чуть позже.',429);
      if((quota.ips[ip]||0)>=cfg.perMinute)throw new AppError('Слишком много запросов из вашей сети. Подождите минуту.',429);
      quota.count++;quota.ips[ip]=(quota.ips[ip]||0)+1;quota.leases[id]=now+150000;await tx.put('quota',quota);return id;
    });
  }
  async release(id){await this.ctx.storage.transaction(async tx=>{const q=await tx.get('quota');if(q){delete q.leases[id];await tx.put('quota',q);}});}
  async runChat(request,cfg,profile,messages){
    const key=await decrypt(profile.secret,this.env);const timeout=AbortSignal.timeout(45000);const signal=AbortSignal.any([request.signal,timeout]);
    const verdict=await complete(profile,key,[{role:'system',content:SCOPE_PROMPT},...messages.slice(-12)],Math.min(profile.maxTokens,1024),signal);
    if(verdict.trim()!=='ALLOW')return {answer:redirectText(messages.at(-1).content),redirected:true};
    const answer=await complete(profile,key,[{role:'system',content:SYSTEM_PROMPT},...messages],profile.maxTokens,signal);
    return {answer,redirected:false};
  }
  async fetch(request){try{return await this.route(request);}catch(e){if(e?.name==='TimeoutError'||e?.name==='AbortError')return json({error:'Ответ не получен вовремя или запрос отменён. Попробуйте позже.'},504);return json({error:e instanceof AppError?e.message:'Внутренняя ошибка сервера. Сообщите администратору.'},e instanceof AppError?e.status:500);}}
  async route(request){
    const path=new URL(request.url).pathname,cfg=await this.config();
    if(path==='/api/status'&&request.method==='GET'){const p=cfg.profiles.find(p=>p.id===cfg.activeId);return json({ready:!!(cfg.enabled&&p?.secret),provider:p?PROVIDERS[p.provider].name:null});}
    const admin=path.startsWith('/api/admin');if(admin){await this.adminRate(request);await this.auth(request);}
    if(path==='/api/admin/config'&&request.method==='GET'){const q=await this.ctx.storage.get('quota');return json({...cfg,profiles:cfg.profiles.map(publicProfile),providers:PROVIDERS,requestsToday:q?.day===new Date().toISOString().slice(0,10)?q.count:0});}
    if(path==='/api/admin/profile'&&request.method==='POST'){
      const body=await readJSON(request,16000);if(!body||!Object.hasOwn(PROVIDERS,body.provider))throw new AppError('Выберите провайдера.');
      const id=body.id||crypto.randomUUID();if(typeof id!=='string'||id.length>80)throw new AppError('Некорректный ID.');
      const label=typeof body.label==='string'?body.label.trim():'';const model=typeof body.model==='string'?body.model.trim():'';
      if(!label||label.length>60||!model||model.length>150||/\s/.test(model))throw new AppError('Укажите название подключения и точный ID модели.');
      const tokens=number(body.maxTokens,512,8192,'Лимит токенов');const old=cfg.profiles.find(p=>p.id===id);
      if(!old&&cfg.profiles.length>=8)throw new AppError('Можно сохранить до 8 подключений.');
      const key=typeof body.apiKey==='string'?body.apiKey.trim():'';if((!key&&(!old||old.provider!==body.provider))||key.length>1024||/\s/.test(key))throw new AppError('Для нового провайдера нужен API-ключ без пробелов.');
      const profile={id,label,provider:body.provider,model,maxTokens:tokens,secret:key?await encrypt(key,this.env):old.secret};
      // Write after encryption using latest state to avoid lost concurrent updates.
      await this.ctx.storage.transaction(async tx=>{const latest=await tx.get('config')||defaults();const i=latest.profiles.findIndex(p=>p.id===id);if(i>=0)latest.profiles[i]=profile;else{if(latest.profiles.length>=8)throw new AppError('Можно сохранить до 8 подключений.');latest.profiles.push(profile);}await tx.put('config',latest);});return json({profile:publicProfile(profile)});
    }
    if(path==='/api/admin/activate'&&request.method==='POST'){const body=await readJSON(request,2000);await this.ctx.storage.transaction(async tx=>{const latest=await tx.get('config')||defaults();if(!latest.profiles.some(p=>p.id===body.id))throw new AppError('Подключение не найдено.',404);latest.activeId=body.id;await tx.put('config',latest);});return json({ok:true});}
    if(path==='/api/admin/profile'&&request.method==='DELETE'){const body=await readJSON(request,2000);await this.ctx.storage.transaction(async tx=>{const latest=await tx.get('config')||defaults();latest.profiles=latest.profiles.filter(p=>p.id!==body.id);if(latest.activeId===body.id){latest.activeId=null;latest.enabled=false;}await tx.put('config',latest);});return json({ok:true});}
    if(path==='/api/admin/settings'&&request.method==='POST'){
      const body=await readJSON(request,2000);if(typeof body.enabled!=='boolean')throw new AppError('Некорректный переключатель.');
      const limits={enabled:body.enabled,dailyLimit:number(body.dailyLimit,1,10000,'Запросов в день'),perMinute:number(body.perMinute,1,500,'Запросов из сети в минуту'),maxConcurrent:number(body.maxConcurrent,1,30,'Одновременных запросов')};
      await this.ctx.storage.transaction(async tx=>{const latest=await tx.get('config')||defaults();if(limits.enabled&&!latest.profiles.some(p=>p.id===latest.activeId))throw new AppError('Сначала выберите активное подключение.');await tx.put('config',{...latest,...limits});});return json({ok:true});
    }
    if((path==='/api/chat'||path==='/api/admin/test')&&request.method==='POST'){
      const body=await readJSON(request),isTest=path==='/api/admin/test';const messages=validateMessages(body.messages);
      // Students cannot supply provider, model, API keys or system messages.
      const profile=cfg.profiles.find(p=>p.id===(isTest?body.profileId:cfg.activeId));if(!profile)throw new AppError('Администратор ещё не подключил ИИ.',503);
      const reservation=await this.reserve(request,isTest);try{return json(await this.runChat(request,cfg,profile,messages));}finally{await this.release(reservation);}
    }
    throw new AppError('Маршрут не найден.',404);
  }
}
export default {async fetch(request,env){
  let allowed;try{allowed=new URL(env.ALLOWED_ORIGIN).origin;if(allowed!==env.ALLOWED_ORIGIN||!allowed.startsWith('https://'))throw Error();}catch{return json({error:'Администратор должен указать ALLOWED_ORIGIN: HTTPS-адрес GitHub Pages без пути.'},503);}
  const origin=request.headers.get('Origin');if(origin!==allowed)return json({error:'Этот источник запроса не разрешён.'},403);
  const headers={'Access-Control-Allow-Origin':allowed,'Vary':'Origin','Access-Control-Allow-Methods':'GET, POST, DELETE, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Max-Age':'600'};
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
  const stub=env.APP_STATE.get(env.APP_STATE.idFromName('university-app-v1'));
  const response=await stub.fetch(request);const result=new Response(response.body,response);for(const [k,v]of Object.entries(headers))result.headers.set(k,v);return result;
}};
