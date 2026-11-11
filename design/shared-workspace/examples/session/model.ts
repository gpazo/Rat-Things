export const question='Keep the evidence readable after reconnecting.'
export const answer='We’ll start with one shared capture, runtime and command details, and a reconnect path that preserves the discussion.'
export type Scene={draft:string;reply:boolean;sent:boolean;sentReply:boolean;phase:'working'|'answer';words:number}
export const initial:Scene={draft:'',reply:false,sent:false,sentReply:false,phase:'working',words:0}
export const poster:Scene={...initial,sent:true,sentReply:true,phase:'answer',words:answer.split(' ').length}
export type Action={type:'draft';text:string}|{type:'reply'}|{type:'cancel'}|{type:'send'}
export function update(s:Scene,a:Action):Scene {
 switch(a.type){
  case 'draft':return {...s,draft:a.text}
  case 'reply':return {...s,reply:true}
  case 'cancel':return {...s,reply:false}
  case 'send':return s.draft.trim()?{...s,sent:true,sentReply:s.reply,reply:false,draft:'',phase:'answer',words:99}:s
 }
}
