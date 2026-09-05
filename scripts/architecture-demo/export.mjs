import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

function run(command,args,{binary=false}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{stdio:['ignore','pipe','pipe']});
    const output=[],errors=[];
    child.stdout.on('data',chunk=>output.push(chunk));child.stderr.on('data',chunk=>errors.push(chunk));
    child.on('error',reject);
    child.on('exit',code=>code===0?resolve(binary?Buffer.concat(output):Buffer.concat(output).toString('utf8')):reject(new Error(`${command} failed (${code}): ${Buffer.concat(errors).toString('utf8').slice(-6000)}`)));
  });
}

/** Timing comes from an off-crop color slate, not guessed wall-clock offsets. */
export async function exportDemo(options={}) {
  const directory=resolve(options.directory??'test-results/architecture-demo');
  const output=resolve(options.output??'assets/rat-things-architecture-demo.mp4');
  const poster=resolve(options.poster??'assets/rat-things-architecture-demo-poster.jpg');
  const recording=JSON.parse(await readFile(resolve(directory,'recording.json'),'utf8'));
  if(!recording.raw || recording.errors.length || recording.recorded.length!==12) throw new Error('The recording must contain all 12 clean chapters.');
  const probe=JSON.parse(await run('ffprobe',['-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',recording.raw]));
  const colors=await run('ffmpeg',['-hide_banner','-loglevel','error','-i',recording.raw,'-vf','crop=8:8:20:20,scale=1:1,format=rgb24','-fps_mode','passthrough','-f','rawvideo','pipe:1'],{binary:true});
  if(colors.length/3!==probe.frames.length)throw new Error('Video frames and timing samples disagree.');
  const expected=recording.recorded.map(chapter=>[1,3,5].map(offset=>parseInt(chapter.color.slice(offset,offset+2),16)));
  const groups=expected.map(()=>[]);
  for(let index=0;index<probe.frames.length;index++) {
    const pixel=Array.from(colors.subarray(index*3,index*3+3));
    const distances=expected.map(rgb=>rgb.reduce((sum,value,channel)=>sum+(value-pixel[channel])**2,0));
    const best=Math.min(...distances);
    if(best<35**2)groups[distances.indexOf(best)].push(index);
  }
  await mkdir(resolve(directory,'clips'),{recursive:true});
  const timeline=[];
  let elapsed=0;
  for(const [index,chapter] of recording.recorded.entries()) {
    const frames=groups[index];
    if(frames.length<40)throw new Error(`No usable timing slate for ${chapter.id}`);
    const start=Number(probe.frames[frames[0]].best_effort_timestamp_time);
    const end=Number(probe.frames[frames.at(-1)].best_effort_timestamp_time)+.04;
    const duration=end-start;
    if(duration<chapter.seconds*.65 || duration>chapter.seconds*6)throw new Error(`Unexpected captured duration for ${chapter.id}: ${duration}`);
    const speed=chapter.seconds/duration;
    const crop={x:Math.floor(chapter.crop.x/2)*2,y:Math.floor(chapter.crop.y/2)*2,width:Math.floor(chapter.crop.width/2)*2,height:Math.floor(chapter.crop.height/2)*2};
    if(crop.x<80 || crop.y<80) {
      // The final wide shot includes the header; cover the timing slate in that cut.
      if(chapter.id!=='source')throw new Error('Timing slate would leak into the exported frame.');
    }
    const mask=chapter.id==='source'?'drawbox=x=0:y=0:w=65:h=65:color=0x081316:t=fill,':'';
    const filter=`[0:v]${mask}setpts=(PTS-STARTPTS)*${speed.toFixed(8)},crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},scale=1000:610:force_original_aspect_ratio=decrease:flags=lanczos,pad=1000:610:(ow-iw)/2:(oh-ih)/2:color=0x081316,pad=1080:1080:40:222:color=0x081316,setsar=1,fps=30[scene];[scene][1:v]overlay=0:0:shortest=1:format=auto,format=yuv420p,fade=t=in:st=0:d=0.15,fade=t=out:st=${(chapter.seconds-.15).toFixed(2)}:d=0.15[v]`;
    const clip=resolve(directory,'clips',`${String(index+1).padStart(2,'0')}-${chapter.id}.mp4`);
    await run('ffmpeg',['-hide_banner','-loglevel','error','-y','-ss',String(start),'-t',String(duration),'-i',recording.raw,'-loop','1','-i',resolve(directory,`${chapter.id}-caption.png`),'-filter_complex_threads','1','-filter_complex',filter,'-map','[v]','-an','-t',String(chapter.seconds),'-c:v','libx264','-preset','fast','-crf','19','-maxrate','8M','-bufsize','16M','-threads','2','-pix_fmt','yuv420p','-movflags','+faststart',clip]);
    timeline.push({id:chapter.id,start:elapsed,end:elapsed+chapter.seconds,title:chapter.title.replaceAll('\n',' '),sourceStart:start,sourceEnd:end,playbackRate:1/speed,clip});
    elapsed+=chapter.seconds;
    options.onProgress?.({chapter:chapter.id,completed:index+1,total:recording.recorded.length});
  }
  const list=resolve(directory,'clips.txt');
  await writeFile(list,timeline.map(chapter=>`file '${chapter.clip.replaceAll("'","'\\''")}'`).join('\n')+'\n');
  await run('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i',list,'-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=48000','-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','64k','-shortest','-movflags','+faststart',output]);
  await run('ffmpeg',['-hide_banner','-loglevel','error','-y','-ss','1.5','-i',output,'-frames:v','1','-q:v','2',poster]);
  const final=JSON.parse(await run('ffprobe',['-v','error','-show_streams','-show_format','-of','json',output]));
  const video=final.streams.find(stream=>stream.codec_type==='video');
  const audio=final.streams.find(stream=>stream.codec_type==='audio');
  const bytes=(await stat(output)).size;
  if(video.codec_name!=='h264'||video.pix_fmt!=='yuv420p'||video.width!==1080||video.height!==1080||video.r_frame_rate!=='30/1'||audio?.codec_name!=='aac'||Number(final.format.duration)>140||bytes>=512*1024*1024)throw new Error('The export does not meet the expected X upload profile.');
  await run('ffmpeg',['-hide_banner','-loglevel','error','-xerror','-i',output,'-f','null','-']);
  const result={video:output,poster,seconds:Number(final.format.duration),bytes,dimensions:[video.width,video.height],fps:30,codec:video.codec_name,audio:'silent AAC',timeline,sourceRevision:JSON.parse(await readFile('dist-pages/architecture/data.json','utf8')).provenance,notes:['Actual local explorer footage; captions and framing added for the social edit.','Timing slate is outside the crop or covered in the final wide shot.','Interaction-heavy sequences are time-compressed. No AWS execution is claimed.'],uploadReference:'https://help.x.com/en/using-x/x-videos'};
  await writeFile(resolve('assets/rat-things-architecture-demo-evidence.json'),JSON.stringify(result,null,2)+'\n');
  await writeFile(resolve(directory,'export.json'),JSON.stringify(result,null,2)+'\n');
  return result;
}
