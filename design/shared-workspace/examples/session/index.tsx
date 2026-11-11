import {useReducer,useState,type ReactNode} from 'react'
import {Stage,Window,Phone,Row,Avatar,Collapse,Stream,Swap,Popover,type Act} from '../../kit'
import {ArrowUp,Folder,CornerUpLeft,X,ChevronRight,Check,PanelRight} from 'lucide-react'
import {people} from '../workspace/model'
import {initial,poster,update,question,answer,type Scene,type Action} from './model'
import '../workspace/workspace.css'
import './session.css'

async function script(a:Act<Scene>){
 await a.wait(700);a.mark('reply')
 await a.click({at:'reply',x:.5,y:.5});a.put({reply:true});await a.wait(450)
 a.mark('compose');await a.click({at:'composer',x:.4,y:.5});await a.type('draft',question,{interval:34})
 await a.wait(500);a.mark('send');await a.click({at:'send',x:.5,y:.5});a.put({sent:true,sentReply:true,reply:false,draft:''})
 await a.wait(1000);a.mark('answer');a.put({words:1})
 for(let i=2;i<=answer.split(' ').length;i++){await a.wait(55);a.put({words:i})}
 a.put({phase:'answer'})
 await a.move({at:'progress',x:.3,y:.5});await a.wait(2700);a.mark('complete')
}
function Person({who}:{who:number}){return <Avatar size={24} name={people[who].name} style={{background:people[who].color,color:'var(--rt-bg)'}}/>}
function Message({who,children,quote,onReply,target}:{who:number|'agent';children:ReactNode;quote?:boolean;onReply?:()=>void;target?:string}){
 return <article className="sc-message"><Row pad={8} lead={who==='agent'?<img src="/mark.png" alt="" width="24" height="24"/>:<Person who={who}/>} title={<span style={{color:who==='agent'?'var(--rt-text)':people[who].color}}>{who==='agent'?'Agent':people[who].name}{who!=='agent'&&<span className="sc-role">{people[who].role}</span>}</span>} meta={onReply&&<button data-target={target} className="sc-reply" onClick={onReply}><CornerUpLeft size={14}/>Reply</button>}/><div className="sc-message-body">{quote&&<div className="sc-quote"><span>Eli · Engineer</span><p>One captured page, runtime version, and failing command.</p></div>}{children}</div></article>
}
function View({s,manual,viewer,compact,dispatch}:{s:Scene;manual:boolean;viewer:boolean;compact:boolean;dispatch:(a:Action)=>void}){
 const [activity,setActivity]=useState(false),[work,setWork]=useState(false),[sentText,setSentText]=useState(question)
 const reply=()=>dispatch({type:'reply'})
 const send=()=>{if(!viewer&&s.draft.trim()){setSentText(s.draft.trim());dispatch({type:'send'})}}
 const toolbar=<button className="sc-work-button" onClick={()=>setWork(x=>!x)} aria-expanded={work}><PanelRight size={14}/>{compact?'Work':'Shared workspace'}</button>

 const content=<><div className="sc-context"><span>Product team <span> / </span> Shared Session</span><span>{viewer?'Viewer':'Collaborator'}</span></div>
 <Popover show={work} className="sc-work-popover" origin="top right"><div className="sc-pop-title">Keep the work beside the conversation.</div><Row title="Shared browser" subtitle="One page for everyone" lead={<PanelRight size={16}/>}/><Row title="direction.md" subtitle="Saved artifact" lead={<Folder size={16}/>}/><a href="/?try=1">Open the workspace study <ChevronRight size={14}/></a></Popover>
 <div className="sc-body"><section className="sc-history" aria-label="Conversation">
  <Message who={0}>Let’s make environment differences visible.</Message>
  <Message who={1} onReply={!viewer?reply:undefined} target="reply">One captured page, runtime version, and failing command.</Message>
  <Collapse open={s.sent} reveal="drop"><Message who={2} quote={s.sentReply}>{manual?sentText:question}</Message></Collapse>
  <Collapse open={s.words>0} reveal="drop"><Message who="agent"><Stream text={answer} count={s.words}/></Message></Collapse>
 </section><div className="sc-input-area">
  <div className="sc-progress" data-target="progress"><span className="sc-progress-label" data-working={s.phase==='working'||undefined}><span className="sc-progress-icon"><span className="sc-status-dot" data-active={s.phase==='working'||undefined}/><Check size={14} data-active={s.phase==='answer'||undefined}/></span><Swap id={s.phase}>{s.phase==='working'?'Agent is working':'Ready for the next step'}</Swap></span><button className="sc-activity" onClick={()=>setActivity(x=>!x)} aria-expanded={activity}>Activity <ChevronRight size={14}/></button></div>
  <Collapse open={activity}><div className="sc-activity-list"><Row pad={8} title="Read direction.md" meta="Complete"/><Row pad={8} title="Review constraints" meta="Complete"/></div></Collapse>
  {viewer?<div className="sc-viewer">Viewer access · follow the shared progress here.</div>:<div className="sc-composer"><Collapse open={s.reply}><div className="sc-reply-context"><div><span>Replying to Eli</span><button aria-label="Cancel reply" onClick={()=>dispatch({type:'cancel'})}><X size={14}/></button></div><p>One captured page, runtime version, and failing command.</p></div></Collapse><textarea data-target="composer" aria-label="Message" value={s.draft} readOnly={!manual} placeholder="Add your perspective…" onChange={e=>dispatch({type:'draft',text:e.target.value})} onKeyDown={e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();send()}}}/><div className="sc-composer-actions"><span>Sam · QA <span> · </span> ⌘ Enter</span><button data-target="send" aria-label="Send message" className="sc-send" onClick={send} disabled={manual&&!s.draft.trim()}><ArrowUp size={16}/></button></div></div>}

 </div></div></>
 return compact?<Phone width={326} frame="outline" dark wallpaper="var(--rt-panel)" className="sc-phone"><main className="sc-compact-app"><div className="sc-mobile-title"><span>Works on our machines</span>{toolbar}</div>{content}</main></Phone>:<Window title="Works on our machines" toolbar={toolbar} lights="grey" className="sc-window">{content}</Window>
}
export default function Session({manual=false,viewer=false}:{manual?:boolean;viewer?:boolean}){
 const [state,dispatch]=useReducer(update,initial)
 return <Stage<Scene> width={960} height={620} compact={{below:760,width:358,height:600}} initial={initial} poster={poster} script={manual?undefined:script} play="once" className="rw sc" theme="dark" fidelity="realistic" cursor={manual?undefined:{at:{wide:{x:860,y:550},compact:{x:310,y:550}},style:'real'}}>{(s,_rect,layout)=><View s={manual?state:s} compact={layout==='compact'} manual={manual} viewer={viewer} dispatch={dispatch}/>}</Stage>
}
