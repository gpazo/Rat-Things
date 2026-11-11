import {useReducer,useRef,useState,type CSSProperties,type PointerEvent} from 'react'
import {Stage,Window,Phone,Avatar,Pin,Row,Collapse,Swap,Stream,Popover,type Act} from '../../kit'
import {ArrowUp,ArrowLeft,MessageSquare,Globe,Image as ImageIcon,FileText,Camera,Check,X,RotateCcw,Users,CornerUpLeft} from 'lucide-react'
import {initial,poster,notes,answer,people,update,type Scene,type Action,type Anchor,type Note} from './model'
import './workspace.css'

async function script(a:Act<Scene>) {
  await a.wait(850)
  a.mark('capture')
  await a.click({at:'capture',x:.8,y:.5})
  a.put({capture:true})
  await a.wait(650)
  a.mark('pin')
  await a.click({at:'headline',x:.55,y:.7})
  const h=a.rect('headline'),frame=a.rect('artifact')
  a.put({anchor:{x:(h.x+h.width*.55-frame.x)/frame.width,y:(h.y+h.height*.7-frame.y)/frame.height,width:0,height:0},mobile:'conversation'})
  await a.wait(400)
  await a.click({at:'composer',x:.65,y:.5})
  await a.type('draft',notes[0].text,{interval:25})
  await a.click({at:'send',x:.7,y:.5})
  a.put({notes:[notes[0]],draft:'',mobile:'conversation'})
  await a.wait(700)
  a.mark('reply')
  a.put({typing:'Eli'})
  await a.wait(1100)
  a.put({notes:notes.slice(0,2),typing:'Sam'})
  await a.wait(1100)
  a.put({notes,typing:'',working:true})
  await a.wait(900)
  a.mark('agent')
  a.put({working:false,agentWords:1})
  for(let n=2;n<=answer.split(' ').length;n++) { a.put({agentWords:n});await a.wait(45) }
  await a.move({at:'discussion',x:.8,y:.5})
  await a.wait(2100)
  a.mark('complete')
}

function Person({who,size=24}:{who:number;size?:number}) {
  const p=people[who]
  return <Avatar name={p.name} size={size} style={{background:p.color,color:'var(--rt-bg)'}}/>
}
function Message({note,onReply}:{note:Note;onReply?:()=>void}) {
  const p=people[note.person]
  return <article className="rw-message"><Row pad={12} lead={<Person who={note.person}/>} title={<span style={{color:p.color}}>{p.name}<span className="rw-role">{p.role}</span></span>} meta={onReply&&<button className="rw-icon" aria-label={'Reply to '+p.name} onClick={onReply}><CornerUpLeft size={14}/></button>}/><div className="rw-message-body">{note.reply&&<span className="rw-reply-ref"><CornerUpLeft size={12}/> {note.reply}’s note</span>}{note.text}</div></article>
}
type ViewProps={s:Scene;manual:boolean;viewer:boolean;actor:number;compact:boolean;dispatch:(a:Action)=>void}
function WorkspaceView({s,manual,viewer,actor,compact,dispatch}:ViewProps) {
  const [peopleOpen,setPeopleOpen]=useState(false)
  const start=useRef<{x:number;y:number}|null>(null)
  const annotate=manual&&!viewer&&s.capture
  const point=(e:PointerEvent<HTMLElement>)=>{const r=e.currentTarget.getBoundingClientRect();return {x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))}}
  const finish=(e:PointerEvent<HTMLElement>)=>{
    if(!start.current)return
    const end=point(e),begin=start.current;start.current=null
    const isRegion=Math.abs(begin.x-end.x)+Math.abs(begin.y-end.y)>.045
    const anchor:Anchor=isRegion?{x:Math.min(begin.x,end.x),y:Math.min(begin.y,end.y),width:Math.abs(begin.x-end.x),height:Math.abs(begin.y-end.y)}:{...begin,width:0,height:0}
    dispatch({type:'anchor',anchor,person:actor})
  }
  const reply=(name:string)=>dispatch({type:'reply',name})
  const label=s.tab==='browser'?(s.capture?'Captured page':'Live browser'):(s.tab==='image'?'Image · saved version':'Brief · saved version')
  const context=s.reply?'Reply to '+s.reply:s.capture?(s.anchor?'Pinned feedback':'Feedback on this capture'):'Message the team and agent'
  const send=()=>{if(!viewer)dispatch({type:'send',person:actor})}
  const toolbar=<div className="rw-avatar-row" role="group" aria-label="Session participants">{people.map((p,i)=><button className="rw-person-button" key={p.name} aria-label={'View '+p.name} onClick={()=>setPeopleOpen(x=>!x)}><Person who={i} size={22}/></button>)}</div>
  const content=<>

    <div className="rw-session-meta"><span><img src="/mark.png" alt="" width="16" height="16"/>Product team <span className="rw-slash">/</span> Shared Session</span><span>{viewer?'Viewer':'Collaborator'}</span></div>
    <Popover show={peopleOpen} className="rw-people-popover" origin="top right" aria-label="People in this Session"><div className="rw-popover-heading">Session participants</div>{people.map((p,i)=><Row key={p.name} lead={<Person who={i}/>} title={p.name} subtitle={p.role} meta="Collaborator"/>)}<div className="rw-popover-foot">Access follows the Product team space.</div></Popover>
    <div className="rw-layout" data-mobile={s.mobile}>
      <section className="rw-work" aria-label="Shared artifacts">
        <div className="rw-tabs" role="tablist" aria-label="Artifacts">{([['browser',Globe,'Browser'],['image',ImageIcon,'Mockup'],['brief',FileText,'Brief']] as const).map(([tab,Icon,name])=><button key={tab} role="tab" aria-selected={s.tab===tab} onClick={()=>dispatch({type:'tab',tab})}><Icon size={14}/>{name}</button>)}</div>
        <div className="rw-modebar"><span className="rw-mode"><Swap id={label}><span className="rw-mode-name">{s.capture?<Camera size={14}/>:<Globe size={14}/>} {label}</span></Swap></span><div className="rw-mode-actions"><span data-active={s.capture||undefined}><button className="rw-quiet" disabled={!s.capture} onClick={()=>dispatch({type:'live'})}><ArrowLeft size={13}/>{s.tab==='browser'?'Return to live':'Done annotating'}</button></span><span data-active={!s.capture||undefined}><button className="rw-button" data-target="capture" disabled={viewer||s.capture} onClick={()=>dispatch({type:'capture'})}><MessageSquare size={14}/>Add comment</button></span></div></div>
        <div className="rw-capture-hint"><Swap id={s.capture?'capture':'live'}>{s.capture?'Feedback stays with this page version.':'One browser, shared by people and agent.'}</Swap></div>
        <div className="rw-artifact" data-target="artifact" data-cursor={s.capture?'crosshair':undefined} onPointerDown={e=>{if(annotate){start.current=point(e);e.currentTarget.setPointerCapture(e.pointerId)}}} onPointerUp={finish}>
          {s.tab==='brief'?<div className="rw-brief"><span className="rw-eyebrow">Product brief</span><div className="rw-artifact-title">Make the difference reproducible.</div><p>A shared investigation, starting with the evidence.</p>{['Capture runtime, command and result','Review the same evidence together','Choose one reproducible next step'].map(x=><Row key={x} lead={<Check size={16}/>} title={x}/>)}<div className="rw-brief-note">Open question<br/>How should reconnect preserve the team’s context?</div></div>:<div className="rw-concept">
            <div className="rw-concept-top"><span>Concept / 01</span><span>{s.tab==='image'?'Layout study':'Product direction'}</span></div>
            <div className="rw-artifact-title" data-target="headline" data-pinned={!manual&&!!s.anchor||undefined}>It works on<br/>my machine.</div>
            <p>Let’s find out what’s different.<br/>Together.</p>
            <div className="rw-evidence"><div className="rw-evidence-head"><span>One report. Shared evidence.</span><FileText size={16}/></div>
              <Row title="Environment" meta="Node 22 · Linux"/>
              <Row title="Failing command" meta={<code>npm test</code>}/>
              <Row title="Expected result" meta="A reproducible failure"/>
            </div>
            <button className="rw-concept-cta" disabled={s.capture||viewer} onPointerDown={e=>e.stopPropagation()} onClick={()=>dispatch({type:'capture'})}>Review together <ArrowUp size={16}/></button>
            <div className="rw-concept-foot">Capture the difference. Decide the next step.</div>
          </div>}
          <span className="rw-pin-position" data-visible={!!s.anchor||undefined} style={{left:(s.anchor?.x??.8)*100+'%',top:(s.anchor?.y??.28)*100+'%'}}><Pin name="1" size={28} selected style={{'--ss-accent':people[s.anchorPerson].color} as CSSProperties} onClick={e=>{e.stopPropagation();reply(people[s.anchorPerson].name)}}/></span>
          {!!s.anchor?.width&&<span className="rw-region" style={{left:s.anchor.x*100+'%',top:s.anchor.y*100+'%',width:s.anchor.width*100+'%',height:s.anchor.height*100+'%'}}/>}
        </div>
        <div className="rw-artifact-footer"><span><Swap id={s.capture?'captured':'preview'}>{s.capture?'Captured page · 1':'Concept preview'}</Swap></span><span><Swap id={s.capture?'captured':'live'}>{s.capture?'Original context preserved':'Browser actions are shared'}</Swap></span></div>
      </section>
      <aside className="rw-discussion" aria-label="Conversation and feedback">
        <div className="rw-discussion-head" data-target="discussion"><span><MessageSquare size={15}/><Swap id={s.capture?'capture':'conversation'}>{s.capture?'1 · On this capture':'Conversation'}</Swap></span>{<span className="rw-resolve" data-visible={s.notes.length>0||undefined}><button className="rw-quiet" disabled={viewer} onClick={()=>dispatch({type:'resolve'})}>{s.resolved?<RotateCcw size={14}/>:<Check size={14}/>} {s.resolved?'Reopen':'Resolve'}</button></span>}</div>
        <div className="rw-thread">
          <Collapse open={!s.capture||s.notes.length===0} reveal="drop"><Row className="rw-message rw-brief-message" pad={12} lead={<img src="/mark.png" width="24" height="24" alt="Rat Things"/>} title="Agent" subtitle="What should we change before building?"/></Collapse>
          <div className="rw-context-strip"><Camera size={13}/><Swap id={s.capture?'captured':'live'}>{s.capture?'Pin 1 · “It works on my machine.”':'Review the page together'}</Swap></div>
          {notes.map((note,index)=><Collapse key={note.id} open={s.notes.length>index} reveal="drop"><Message note={s.notes[index]??note} onReply={manual&&!viewer?()=>reply((s.notes[index]?people[s.notes[index].person]:people[note.person]).name):undefined}/></Collapse>)}
          {s.notes.slice(3).map(note=><Message key={note.id} note={note} onReply={!viewer?()=>reply(people[note.person].name):undefined}/>)}
          <Collapse open={s.agentWords>0} reveal="drop"><article className="rw-message rw-agent-message"><Row pad={12} lead={<img src="/mark.png" width="24" height="24" alt="Rat Things"/>} title="Agent"/><div className="rw-message-body"><Stream text={manual?"Your feedback is in the shared context. I’ll use this captured version as we continue.":answer} count={s.agentWords}/></div></article></Collapse>
          <Collapse open={s.resolved} reveal="drop"><div className="rw-resolution"><Check size={14}/>Discussion resolved · context kept</div></Collapse>
        </div>
        <div className="rw-composer-area">
          <div className="rw-typing" aria-live="polite"><Swap id={s.typing}>{s.typing?<span style={{color:people.find(p=>p.name===s.typing)?.color}}>{s.typing} is typing…</span>:<span/>}</Swap></div>
          {viewer?<div className="rw-viewer"><Users size={16}/>Viewer access · follow the shared work</div>:<div className="rw-composer"><div className="rw-composer-context"><Swap id={context}>{context}</Swap>{s.reply&&<button className="rw-icon" aria-label="Cancel reply" onClick={()=>dispatch({type:'reply',name:null})}><X size={14}/></button>}</div>
            <textarea data-target="composer" aria-label="Your feedback" placeholder="Add your perspective…" value={s.draft} readOnly={!manual} onChange={e=>dispatch({type:'draft',text:e.target.value})} onKeyDown={e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();send()}}}/>

            <div className="rw-composer-actions"><span>{manual?people[actor].name:'Maya'} <span className="rw-slash">·</span> ⌘ Enter</span><button className="rw-send" data-target="send" aria-label="Send feedback" disabled={manual&&!s.draft.trim()} onClick={send}><ArrowUp size={16}/></button></div>
          </div>}
          <div className="rw-agent-status"><Swap id={s.working?'working':s.agentWords?'complete':'ready'}>{s.working?'Agent is considering the feedback…':s.agentWords?'Feedback included · ready for the next step':'Agent ready · same Session'}</Swap></div>
        </div>
      </aside>
    </div>
    {compact&&<div className="rw-mobile-nav"><button aria-pressed={s.mobile==='work'} onClick={()=>dispatch({type:'mobile',tab:'work'})}><Globe size={15}/>Work</button><button aria-pressed={s.mobile==='conversation'} onClick={()=>dispatch({type:'mobile',tab:'conversation'})}><MessageSquare size={15}/>Conversation</button></div>}
  </>
  return compact?<Phone width={326} dark wallpaper="var(--rt-panel)" frame="outline" className="rw-phone"><main className="rw-compact-app"><div className="rw-compact-title"><span>Works on our machines</span>{toolbar}</div>{content}</main></Phone>:<Window title="Works on our machines" lights="grey" className="rw-window" toolbar={toolbar}>{content}</Window>
}
export default function Workspace({manual=false,viewer=false,actor=0}:{manual?:boolean;viewer?:boolean;actor?:number}) {
  const [state,dispatch]=useReducer(update,initial)
  return <Stage<Scene> width={1080} height={750} compact={{below:760,width:358,height:680}} initial={initial} poster={manual?state:poster} script={manual?undefined:script} play="once" theme="dark" fidelity="realistic" className="rw" cursor={manual?undefined:{at:{wide:{x:980,y:680},compact:{x:320,y:740}},style:'real'}}>
    {(s,_rect,layout)=><WorkspaceView s={manual?state:s} manual={manual} viewer={viewer} actor={actor} compact={layout==='compact'} dispatch={dispatch}/>}
  </Stage>
}
