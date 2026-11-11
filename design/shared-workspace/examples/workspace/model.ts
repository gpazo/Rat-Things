export const people = [
  {name:'Maya', role:'Designer', color:'var(--rt-participant-1)'},
  {name:'Eli', role:'Engineer', color:'var(--rt-participant-2)'},
  {name:'Sam', role:'QA', color:'var(--rt-participant-3)'}
] as const
export type Anchor = {x:number;y:number;width:number;height:number}
export type Note = {id:number;person:number;text:string;reply?:string}
export type Scene = {
  capture:boolean; anchor:Anchor|null; anchorPerson:number; surfaces:Partial<Record<Scene['tab'],Surface>>; notes:Note[]; draft:string;
  reply:string|null; typing:string; working:boolean; agentWords:number;
  resolved:boolean; tab:'browser'|'image'|'brief'; mobile:'work'|'conversation';
}
type Surface=Omit<Scene,'tab'|'mobile'|'surfaces'>
export const initial:Scene={capture:false,anchor:null,anchorPerson:0,surfaces:{},notes:[],draft:'',reply:null,typing:'',working:false,agentWords:0,resolved:false,tab:'browser',mobile:'work'}
export const notes:Note[]=[
  {id:1,person:0,text:'Lead with shared evidence, not blame.'},
  {id:2,person:1,text:'Start with the runtime version and failing command.',reply:'Maya'},
  {id:3,person:2,text:'Keep the captured evidence when the connection drops.'}
]
export const answer='I’ll update the brief: shared evidence, a focused first release, and captures that survive reconnects.'
export const poster:Scene={...initial,capture:true,anchor:{x:.54,y:.28,width:0,height:0},notes,agentWords:99,mobile:'conversation'}
export type Action =
 | {type:'capture'} | {type:'live'} | {type:'anchor';anchor:Anchor;person:number}
 | {type:'draft';text:string} | {type:'reply';name:string|null}
 | {type:'send';person:number} | {type:'resolve'} | {type:'tab';tab:Scene['tab']}
 | {type:'mobile';tab:Scene['mobile']} | {type:'sample'}
export function update(s:Scene,a:Action):Scene {
  switch(a.type) {
    case 'capture':return {...s,capture:true,anchor:null,reply:null,resolved:false}
    case 'live':return {...s,capture:false,reply:null}
    case 'anchor':return {...s,capture:true,anchor:a.anchor,anchorPerson:a.person,reply:null,mobile:'conversation'}
    case 'draft':return {...s,draft:a.text}
    case 'reply':return {...s,reply:a.name}
    case 'send':return s.draft.trim()?{...s,notes:[...s.notes,{id:s.notes.length+1,person:a.person,text:s.draft.trim(),...(s.reply?{reply:s.reply}:{})}],draft:'',reply:null,agentWords:99,mobile:'conversation'}:s
    case 'resolve':return {...s,resolved:!s.resolved}
    case 'tab': {
      if(s.tab===a.tab)return s
      const {tab,mobile,surfaces,...surface}=s
      const saved={...surfaces,[tab]:surface}
      const {tab:_tab,mobile:_mobile,surfaces:_surfaces,...empty}=initial
      return {...(saved[a.tab]??empty),tab:a.tab,mobile,surfaces:saved}
    }
    case 'mobile':return {...s,mobile:a.tab}
    case 'sample':return poster
  }
}
