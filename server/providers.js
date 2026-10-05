export const PROVIDERS = {
  deepseek: {name:'DeepSeek',url:'https://api.deepseek.com/chat/completions',model:'deepseek-flash'},
  dahl: {name:'Dahl Inference',url:'https://inference.dahl.global/v1/chat/completions',model:'MiniMaxAI/MiniMax-M2.7'},
  openai: {name:'OpenAI',url:'https://api.openai.com/v1/chat/completions',model:''},
  openrouter: {name:'OpenRouter',url:'https://openrouter.ai/api/v1/chat/completions',model:''},
  groq: {name:'Groq',url:'https://api.groq.com/openai/v1/chat/completions',model:''},
  gemini: {name:'Google Gemini',url:'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',model:''},
  anthropic: {name:'Anthropic / Claude',url:'https://api.anthropic.com/v1/messages',model:''}
};
export class AppError extends Error { constructor(message,status=400){super(message);this.status=status;} }
export async function complete(profile,key,messages,maxTokens,signal,fetcher=fetch){
  const provider=PROVIDERS[profile.provider];
  if(!provider)throw new AppError('Неизвестный провайдер.',400);
  let headers={'Content-Type':'application/json',Authorization:`Bearer ${key}`};
  let body={model:profile.model,messages,stream:false};
  if(profile.provider==='anthropic'){
    headers={'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'};
    body={model:profile.model,system:messages.filter(m=>m.role==='system').map(m=>m.content).join('\n'),messages:messages.filter(m=>m.role!=='system'),max_tokens:maxTokens,stream:false};
  }else{
    body[profile.provider==='openai'?'max_completion_tokens':'max_tokens']=maxTokens;
    if(profile.provider==='deepseek')body.thinking={type:'disabled'};
  }
  let response;
  try{
    // Some OpenAI-compatible gateways normalize the URL with a redirect.
    // Follow it because the destination is a fixed, trusted provider URL.
    response=await fetcher(provider.url,{method:'POST',headers,body:JSON.stringify(body),signal,redirect:'follow'});
  }catch(error){
    if(error?.name==='TimeoutError'||error?.name==='AbortError'){
      throw new AppError(`Провайдер ${provider.name} не ответил вовремя. Попробуйте ещё раз или выберите другую модель.`,504);
    }
    throw new AppError(`Не удалось подключиться к провайдеру ${provider.name}. Проверьте его доступность и API-ключ.`,502);
  }
  if(!response.ok){const messages={401:'Провайдер не принял API-ключ.',403:'Провайдер запретил доступ.',402:'Недостаточно средств на балансе провайдера.',404:'Модель не найдена.',429:'Превышен лимит провайдера.',400:'Провайдер отклонил параметры или модель.'};throw new AppError(messages[response.status]||'Провайдер ИИ временно недоступен.',502);}
  let data;try{data=await response.json();}catch{throw new AppError('Провайдер вернул некорректный ответ.',502);}
  const text=profile.provider==='anthropic'?data.content?.filter(b=>b.type==='text').map(b=>b.text).join('\n'):data.choices?.[0]?.message?.content;
  if(typeof text!=='string'||!text.trim())throw new AppError('Пустой ответ модели. Попробуйте другую текстовую модель или увеличьте лимит токенов.',502);
  const cut=profile.provider==='anthropic'?data.stop_reason==='max_tokens':data.choices?.[0]?.finish_reason==='length';
  if(cut)throw new AppError('Модель достигла лимита ответа. Увеличьте лимит токенов или задайте более короткий вопрос.',502);
  return text.slice(0,40000);
}
