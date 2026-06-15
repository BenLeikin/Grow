let S=null;

function fmt(d){return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});}
function mins(d){return d.getHours()*60+d.getMinutes()+d.getSeconds()/60;}

function curve(t,on,off,ramp,max){
  if(t<=on||t>=off)return 0;
  const fs=on+ramp, fe=off-ramp;
  if(fs>=fe){const mid=(on+off)/2;
    return t<=mid?max*(t-on)/(mid-on):max*(off-t)/(off-mid);}
  if(t<fs)return max*(t-on)/ramp;
  if(t>fe)return max*(off-t)/ramp;
  return max;
}

function draw(){
  if(!S)return;
  const W=640,H=240,L=34,R=12,T=20,B=34;
  const on=mins(S.on),off=mins(S.off),now=mins(S.now);
  const x=m=>L+(W-L-R)*m/1440, y=p=>H-B-(H-T-B)*p/100;
  let pts=[];
  for(let m=0;m<=1440;m+=4)pts.push([x(m),y(curve(m,on,off,S.ramp,S.max))]);
  const line=pts.map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1)).join('');
  const area=line+`L${x(1440)} ${y(0)} L${x(0)} ${y(0)} Z`;
  const hours=[0,6,12,18,24].map(h=>
    `<text x="${x(h*60)}" y="${H-12}" text-anchor="middle" font-size="11" fill="#3f7d45">${String(h).padStart(2,'0')}:00</text>
     <line x1="${x(h*60)}" y1="${T}" x2="${x(h*60)}" y2="${H-B}" stroke="#d8e6cd" stroke-width="1"/>`).join('');
  const sunM=mins(S.sunrise),setM=mins(S.sunset);
  document.getElementById('chart').innerHTML=`
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#e8b04b" stop-opacity=".85"/>
      <stop offset="55%" stop-color="#7fb069" stop-opacity=".75"/>
      <stop offset="100%" stop-color="#3f7d45" stop-opacity=".35"/>
    </linearGradient></defs>
    ${hours}
    <line x1="${L}" y1="${y(0)}" x2="${W-R}" y2="${y(0)}" stroke="#27432e" stroke-width="1.5"/>
    <path d="${area}" fill="url(#g)"/>
    <path d="${line}" fill="none" stroke="#27432e" stroke-width="2"/>
    <text x="${x(sunM)}" y="${T-5}" font-size="14" text-anchor="middle">&#127774;</text>
    <text x="${x(setM)}" y="${T-5}" font-size="14" text-anchor="middle">&#127771;</text>
    <line x1="${x(now)}" y1="${T}" x2="${x(now)}" y2="${y(0)}" stroke="#b3543a" stroke-width="2"/>
    <circle class="nowdot" cx="${x(now)}" cy="${y(curve(now,on,off,S.ramp,S.max))}" r="6"
            fill="#b3543a" stroke="#fff" stroke-width="2"/>
    <text x="${L}" y="${y(100)-4}" font-size="11" fill="#3f7d45">${S.max}%</text>`;
}

// ---- lighting-stage graphics: graphic follows the actual phase ----
const BULB={
  day:'<svg viewBox="0 0 100 100" class="sunsvg"><g class="raygroup"><path d="M61.0 32.0 Q50.0 3.0 50.0 3.0 L39.0 32.0 Z"/><path d="M68.5 39.9 Q73.5 9.3 73.5 9.3 L49.5 28.9 Z"/><path d="M71.1 50.5 Q90.7 26.5 90.7 26.5 L60.1 31.5 Z"/><path d="M68.0 61.0 Q97.0 50.0 97.0 50.0 L68.0 39.0 Z"/><path d="M60.1 68.5 Q90.7 73.5 90.7 73.5 L71.1 49.5 Z"/><path d="M49.5 71.1 Q73.5 90.7 73.5 90.7 L68.5 60.1 Z"/><path d="M39.0 68.0 Q50.0 97.0 50.0 97.0 L61.0 68.0 Z"/><path d="M31.5 60.1 Q26.5 90.7 26.5 90.7 L50.5 71.1 Z"/><path d="M28.9 49.5 Q9.3 73.5 9.3 73.5 L39.9 68.5 Z"/><path d="M32.0 39.0 Q3.0 50.0 3.0 50.0 L32.0 61.0 Z"/><path d="M39.9 31.5 Q9.3 26.5 9.3 26.5 L28.9 50.5 Z"/><path d="M50.5 28.9 Q26.5 9.3 26.5 9.3 L31.5 39.9 Z"/></g>'
     +'<circle class="sundisk" cx="50" cy="50" r="23"/>'
     +'<g class="face"><circle cx="43" cy="48" r="3"/><circle cx="57" cy="48" r="3"/>'
     +'<path d="M44 55 Q50 61 56 55" fill="none" stroke-width="2.6" stroke-linecap="round"/></g></svg>',
  rise:'<svg viewBox="0 0 100 100" class="risesvg"><g class="rays rerays">'
     +'<line x1="50" y1="28" x2="50" y2="14"/><line x1="34" y1="34" x2="26" y2="23"/>'
     +'<line x1="66" y1="34" x2="74" y2="23"/><line x1="28" y1="46" x2="14" y2="41"/>'
     +'<line x1="72" y1="46" x2="86" y2="41"/></g>'
     +'<circle class="redisk" cx="50" cy="50" r="17"/>'
     +'<g class="reface"><circle cx="44" cy="48" r="2.5"/><circle cx="56" cy="48" r="2.5"/>'
     +'<path d="M45 55 Q50 60 55 55" fill="none" stroke-width="2.4" stroke-linecap="round"/></g>'
     +'<line class="horizon" x1="8" y1="73" x2="92" y2="73"/></svg>',
  set:'<svg viewBox="0 0 100 100" class="setsvg"><g class="rays serays">'
     +'<line x1="50" y1="30" x2="50" y2="18"/><line x1="35" y1="36" x2="28" y2="26"/>'
     +'<line x1="65" y1="36" x2="72" y2="26"/><line x1="29" y1="48" x2="16" y2="44"/>'
     +'<line x1="71" y1="48" x2="84" y2="44"/></g>'
     +'<circle class="sedisk" cx="50" cy="54" r="17"/>'
     +'<g class="seface"><circle cx="44" cy="52" r="2.5"/><circle cx="56" cy="52" r="2.5"/>'
     +'<path d="M45 59 Q50 63 55 59" fill="none" stroke-width="2.4" stroke-linecap="round"/></g>'
     +'<line class="horizon" x1="8" y1="73" x2="92" y2="73"/></svg>'
};
function moonPhase(date){
  // illuminated fraction (0 new .. 1 full) and waxing flag, from the synodic month
  const synodic=29.530588853;
  const knownNew=Date.UTC(2000,0,6,18,14,0)/86400000;  // a reference new moon (days)
  const days=date.getTime()/86400000;
  let age=((days-knownNew)%synodic+synodic)%synodic;
  return {fraction:(1-Math.cos(2*Math.PI*age/synodic))/2, waxing:age<synodic/2, age};
}
function litMoonPath(cx,cy,R,f,waxing){
  if(f<=0.005)return '';                                   // new moon: nothing lit
  if(f>=0.995)return `M ${cx} ${cy-R} A ${R} ${R} 0 1 1 ${cx} ${cy+R} A ${R} ${R} 0 1 1 ${cx} ${cy-R} Z`;
  const rx=(R*Math.abs(2*f-1)).toFixed(2);
  const litRight=waxing, gibbous=f>0.5;
  const outer=litRight?1:0;
  const bulgeRight=litRight?!gibbous:gibbous;              // crescent bulges to lit side; gibbous to dark
  const inner=bulgeRight?0:1;
  return `M ${cx} ${cy-R} A ${R} ${R} 0 0 ${outer} ${cx} ${cy+R} A ${rx} ${R} 0 0 ${inner} ${cx} ${cy-R} Z`;
}
function moonSvg(){
  const {fraction,waxing}=moonPhase(new Date());
  const cx=50,cy=48,R=30, lit=litMoonPath(cx,cy,R,fraction,waxing);
  return '<svg viewBox="0 0 100 100" class="moonsvg">'
    +`<circle class="moondark" cx="${cx}" cy="${cy}" r="${R}"/>`
    +(lit?`<path class="moonlit" d="${lit}"/>`:'')
    +'<path class="star" d="M84 20 l1.5 3.4 3.4 1.5 -3.4 1.5 -1.5 3.4 -1.5 -3.4 -3.4 -1.5 3.4 -1.5 z"/>'
    +'<circle class="star" cx="77" cy="38" r="1.6"/>'
    +'<circle class="star" cx="86" cy="56" r="1.4"/></svg>';
}

function setBulb(stage){
  const el=document.getElementById('bulb');
  if(!el||el.dataset.stage===stage)return;   // only swap on change (keeps animation steady)
  el.dataset.stage=stage;
  el.className='sun is-'+stage;
  el.innerHTML=stage==='night'?moonSvg():(BULB[stage]||BULB.day);
}

function phaseOf(){
  const on=mins(S.on),off=mins(S.off),now=mins(S.now);
  if(now<on)return['Night','Lights come on at '+fmt(S.on),'night'];
  if(now<on+S.ramp)return['Morning ramp','Full brightness at '+fmt(new Date(S.on.getTime()+S.ramp*60000)),'rise'];
  if(now<off-S.ramp)return['Full light','Evening ramp begins at '+fmt(new Date(S.off.getTime()-S.ramp*60000)),'day'];
  if(now<off)return['Evening ramp','Lights off at '+fmt(S.off),'set'];
  return['Night','Lights come on tomorrow around '+fmt(S.on),'night'];
}

function render(){
  if(!S)return;
  document.getElementById('pct').textContent=Math.round(S.brightness)+'%';
  document.getElementById('bulb').style.setProperty('--glow',S.brightness/100);
  const[p,n,stage]=phaseOf();
  document.getElementById('phase').textContent=p;
  document.getElementById('next').textContent=n;
  setBulb(stage);
  const dayLen=(S.off-S.on)/60000;
  document.getElementById('facts').innerHTML=`
    <dt>&#127774; Sunrise</dt><dd>${fmt(S.sunrise)}</dd>
    <dt>&#127771; Sunset</dt><dd>${fmt(S.sunset)}</dd>
    <dt>&#128161; Lights on</dt><dd>${fmt(S.on)}</dd>
    <dt>&#128164; Lights off</dt><dd>${fmt(S.off)}</dd>
    <dt>&#127804; Photoperiod</dt><dd>${Math.floor(dayLen/60)}h ${Math.round(dayLen%60)}m</dd>
    <dt>&#9202; Ramp length</dt><dd>${S.ramp} min</dd>`;
  document.getElementById('cfg').textContent=
    `GPIO${S.gpio} \u00b7 ${S.freq} Hz PWM \u00b7 updates every ${S.loop}s`;
  draw();
}

function renderPhoto(j){
  const card=document.getElementById('photocard');
  if(!j.photo_count){card.style.display='none';return;}
  card.style.display='';
  document.getElementById('photo').src='/photo/latest?'+ (j.latest_photo_time||Date.now());
  const when=j.latest_photo_time?new Date(j.latest_photo_time):null;
  document.getElementById('photoinfo').textContent=
    (when?`Taken ${when.toLocaleString()}`:'')+` \u00b7 ${j.photo_count} photos so far`;
}

function fillForm(cfg){
  const f=document.getElementById('cfgform');
  for(const k of ['latitude','longitude','timezone','max_bright','ramp_min',
                  'sunrise_offset_min','sunset_offset_min',
                  'capture_interval_min','capture_brightness','roi'])
    if(f.elements[k] && document.activeElement!==f.elements[k])
      f.elements[k].value=cfg[k];
  if(document.activeElement!==f.elements['capture_enabled'])
    f.elements['capture_enabled'].checked=!!cfg['capture_enabled'];
}

let frames=[],fidx=0,ptimer=null;
function frameLabel(n){
  const m=n.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})/);
  return m?`${m[2]}/${m[3]} ${m[4]}:${m[5]}`:n;
}
function showFrame(){
  if(!frames.length)return;
  document.getElementById('vframe').src='/thumb/'+frames[fidx];
  document.getElementById('scrub').value=fidx;
  document.getElementById('pframe').textContent=
    `${frameLabel(frames[fidx])} \u00b7 ${fidx+1}/${frames.length}`;
  (new Image()).src='/thumb/'+frames[(fidx+1)%frames.length];
}
function stopPlay(){
  if(ptimer){clearInterval(ptimer);ptimer=null;}
  document.getElementById('playbtn').innerHTML='&#9654; Grow';
}
function togglePlay(){
  if(ptimer){stopPlay();return;}
  if(fidx>=frames.length-1)fidx=0;
  document.getElementById('playbtn').innerHTML='&#9208; Pause';
  ptimer=setInterval(()=>{
    if(fidx>=frames.length-1){stopPlay();return;}
    fidx++;showFrame();
  },125);
}
async function loadFrames(){
  try{
    const r=await fetch('/api/photos');const j=await r.json();
    const had=frames.length;
    frames=j.names||[];
    const card=document.getElementById('videocard');
    if(frames.length<2){card.style.display='none';return;}
    card.style.display='';
    document.getElementById('scrub').max=frames.length-1;
    if(!had){fidx=frames.length-1;showFrame();}
  }catch(e){}
}
document.getElementById('playbtn').addEventListener('click',togglePlay);
document.getElementById('renderbtn').addEventListener('click',async()=>{
  const info=document.getElementById('renderinfo');
  const dl=document.getElementById('dlbtn');
  const btn=document.getElementById('renderbtn');
  dl.style.display='none';          // hide download instantly, no race
  btn.disabled=true;
  btn.textContent='\u23F3 Rendering...';
  renderStart=Date.now();clearRenderTimer();renderTimer=setInterval(tickRender,1000);
  info.textContent='Starting render...';
  try{
    const r=await fetch('/api/render',{method:'POST'});
    const j=await r.json();
    if(!r.ok){info.textContent=j.error||'Render failed to start';btn.disabled=false;
      btn.textContent='\uD83C\uDFA5 Render video';}
  }catch(e){info.textContent='Render failed to start';btn.disabled=false;
    btn.textContent='\uD83C\uDFA5 Render video';}
});
let renderTimer=null, renderStart=null;
function clearRenderTimer(){if(renderTimer){clearInterval(renderTimer);renderTimer=null;}}
function tickRender(){
  if(renderStart===null)return;
  const s=Math.floor((Date.now()-renderStart)/1000);
  const mm=String(Math.floor(s/60)).padStart(2,'0'),ss=String(s%60).padStart(2,'0');
  const f=window._renderFrames?` of ${window._renderFrames} frames`:'';
  document.getElementById('renderinfo').textContent=
    `Rendering${f}... ${mm}:${ss} elapsed`;
}
function renderVideoState(j){
  const info=document.getElementById('renderinfo');
  const dl=document.getElementById('dlbtn');
  const btn=document.getElementById('renderbtn');
  const st=j.render||{};
  const running=(st.state==='running');
  btn.disabled=running;
  btn.textContent=running?'\u23F3 Rendering...':'\uD83C\uDFA5 Render video';
  if(running){
    window._renderFrames=st.frames||0;
    if(renderStart===null){
      renderStart=st.started?new Date(st.started).getTime():Date.now();
      clearRenderTimer();renderTimer=setInterval(tickRender,1000);
    }
    tickRender();
  } else {
    clearRenderTimer();renderStart=null;
    if(!canEdit && st.state!=='running'){
      // read-only viewer: hide render chatter, keep the video timestamp
      if(j.video_time){
        const w=new Date(j.video_time);
        info.textContent='Video from '+w.toLocaleString();
      } else info.textContent='';
    } else if(st.state==='error'){
      info.textContent='Render error'+(st.elapsed?` after ${Math.round(st.elapsed)}s`:'')+
        ': '+st.msg;
    } else if(j.video_time){
      const when=new Date(j.video_time);
      info.textContent='Video from '+when.toLocaleString()+
        (st.state==='done'?' \u00b7 '+st.msg:'');
    } else {info.textContent='No video rendered yet';}
  }
  dl.style.display=(!running && j.video_time)?'':'none';
  if(!running && j.video_time)
    dl.href='/video?t='+encodeURIComponent(j.video_time);
}
document.getElementById('scrub').addEventListener('input',ev=>{
  stopPlay();fidx=+ev.target.value;showFrame();
});

// ---------------- auth / read-only ----------------
let canEdit=true, authEnabled=false;
function applyAuth(j){
  authEnabled = !!j.auth_enabled;
  canEdit = (!authEnabled) || !!j.authed;
  document.body.classList.toggle('readonly', authEnabled && !canEdit);
  const box=document.getElementById('authbox');
  box.style.display = authEnabled ? 'flex' : 'none';
  document.getElementById('pw').style.display       = (authEnabled && !canEdit)?'':'none';
  document.getElementById('loginbtn').style.display = (authEnabled && !canEdit)?'':'none';
  document.getElementById('rolabel').style.display  = (authEnabled && !canEdit)?'':'none';
  document.getElementById('logoutbtn').style.display= (authEnabled && canEdit)?'':'none';
}
async function doLogin(){
  const pw=document.getElementById('pw');
  const err=document.getElementById('loginerr');err.textContent='';
  try{
    const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({password:pw.value})});
    if(r.ok){pw.value='';refresh();}
    else err.textContent='wrong password';
  }catch(e){err.textContent='login failed';}
}
async function doLogout(){
  try{await fetch('/api/logout',{method:'POST'});}catch(e){}
  refresh();
}
function initAuth(){
  document.getElementById('loginbtn').addEventListener('click',doLogin);
  document.getElementById('logoutbtn').addEventListener('click',doLogout);
  document.getElementById('pw').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin();});
}

// ---------------- sensors: readout, chart, overlay ----------------
let sensorData={};
let dryCal={};                 // per-cell {wet,dry} brightness anchors
const DRY_SPAN_DEFAULT=15;     // provisional wet->dry brightness span pre-calibration
function camMoisture(cell, b){
  const c=dryCal[cell];
  if(!c || c.wet==null) return null;          // not calibrated -> no %
  const wet=c.wet, dry=(c.dry!=null?c.dry:wet+DRY_SPAN_DEFAULT);
  if(dry<=wet) return null;
  return Math.max(0, Math.min(100, 100*(dry-b)/(dry-wet)));
}
let chartSensor=null, chartHours=168;

function c2f(c){return c*9/5+32;}
// key -> {group, label, value, unit}
function sensorMeta(key, val){
  if(key==='temp:air')   return {group:'Environment', label:'Air',      value:c2f(val).toFixed(1), unit:'\u00b0F'};
  if(key==='humidity')   return {group:'Environment', label:'Humidity', value:val.toFixed(0),       unit:'%'};
  if(key==='lux')        return {group:'Environment', label:'Light',    value:Math.round(val).toLocaleString(), unit:'lx'};
  if(key.startsWith('temp:soil_'))
                         return {group:'Soil temp',   label:'Probe '+key.split('_')[1], value:c2f(val).toFixed(1), unit:'\u00b0F'};
  if(key.startsWith('moisture:')){
    const cell=key.slice(9);
    const nm=(grid&&grid.names&&grid.names[cell])?grid.names[cell]:cell;
    return {group:'Moisture', label:nm, value:val.toFixed(0), unit:'%'};
  }
  if(key.startsWith('growth_px:')){
    const cell=key.slice(10);
    const nm=(grid&&grid.names&&grid.names[cell])?grid.names[cell]:cell;
    return {group:'Growth', label:nm+' area', value:Math.round(val).toLocaleString(), unit:'px'};
  }
  if(key.startsWith('growth:')){
    const cell=key.slice(7);
    const nm=(grid&&grid.names&&grid.names[cell])?grid.names[cell]:cell;
    return {group:'Growth', label:nm, value:val.toFixed(1), unit:'%'};
  }
  if(key.startsWith('dry:')){
    const cell=key.slice(4);
    const nm=(grid&&grid.names&&grid.names[cell])?grid.names[cell]:cell;
    const m=camMoisture(cell, val);
    if(m!=null) return {group:'Moisture (cam)', label:nm, value:m.toFixed(0), unit:'%'};
    // uncalibrated: show raw surface-brightness index (higher = drier)
    return {group:'Dryness', label:nm, value:val.toFixed(0), unit:''};
  }
  return {group:'Other', label:key, value:String(val), unit:''};
}
function renderSensors(j){
  sensorData=j.sensors||{};
  dryCal=(j.settings&&j.settings.dryness_cal)||{};
  const card=document.getElementById('sensorcard');
  const keys=Object.keys(sensorData);
  card.style.display=keys.length?'':'none';
  // grouped readout
  const groups={};
  for(const k of keys){
    if(k.startsWith('growth_px:'))continue;   // raw counts are chart-only
    if(k==='float:tray')continue;             // shown in the water controls instead
    const v=sensorData[k].value;
    const missing = v==null || (typeof v==='number'&&isNaN(v));
    const m=sensorMeta(k, missing?0:v);
    if(missing)m.value='-';                    // no reading -> dash
    (groups[m.group]=groups[m.group]||[]).push(m);
  }
  const order=['Environment','Soil temp','Moisture','Moisture (cam)','Growth','Dryness','Other'];
  let h='';
  for(const g of order){
    if(!groups[g])continue;
    h+=`<div class="sgroup"><h3>${g}</h3>`;
    for(const m of groups[g])
      h+=`<span class="schip">${m.label} <b>${m.value}</b><span class="u">${m.unit}</span></span>`;
    h+='</div>';
  }
  document.getElementById('sreadout').innerHTML=h;
  const dc=document.getElementById('drycal');
  if(dc)dc.style.display = keys.some(k=>k.startsWith('dry:')) ? '' : 'none';
  // chart sensor dropdown (preserve selection); raw float not chart-worthy
  const sel=document.getElementById('chartsensor');
  const ckeys=keys.filter(k=>k!=='float:tray').sort();
  const want=ckeys.join(',');
  if(sel.dataset.keys!==want){
    sel.dataset.keys=want;
    const cur=sel.value;
    sel.innerHTML=ckeys.map(k=>{const m=sensorMeta(k,0);
      return `<option value="${k}">${m.group}: ${m.label}</option>`;}).join('');
    if(ckeys.includes(cur))sel.value=cur;
    else if(ckeys.length){chartSensor=ckeys.find(k=>k.startsWith('dry:'))||ckeys.find(k=>k.startsWith('moisture:'))||ckeys[0];sel.value=chartSensor;loadChart();}
  }
  if(grid)drawGrid();   // refresh per-cell overlay
}
async function loadChart(){
  if(!chartSensor)return;
  const info=document.getElementById('chartinfo');info.textContent='loading...';
  try{
    const r=await fetch(`/api/series?sensor=${encodeURIComponent(chartSensor)}&hours=${chartHours}`);
    const j=await r.json();drawChart(j.points||[]);info.textContent='';
  }catch(e){info.textContent='chart unavailable';}
}
let chartPlot=null;
function chartUnit(){
  const s=chartSensor||'';
  if(s.startsWith('temp:'))return '\u00b0F';
  if(s.startsWith('humidity')||s.startsWith('moisture:')||s.startsWith('growth:'))return '%';
  if(s.startsWith('dry:')){const c=dryCal[s.slice(4)];return (c&&c.wet!=null)?'%':'';}
  if(s.startsWith('lux'))return 'lx';
  return '';
}
function drawChart(pts){
  const svg=document.getElementById('histchart'),W=720,H=240,P=40;
  const toF=chartSensor&&chartSensor.startsWith('temp:');
  // camera dryness charts as moisture % when that cell is calibrated
  const camCell=(chartSensor&&chartSensor.startsWith('dry:'))?chartSensor.slice(4):null;
  const isCam=camCell&&dryCal[camCell]&&dryCal[camCell].wet!=null;
  const conv=v=>toF?c2f(v):(isCam?camMoisture(camCell,v):v);
  const data=pts.map(([t,v])=>[t, conv(v)]).filter(d=>d[1]!=null);
  if(data.length<2){svg.innerHTML=`<text x="${W/2}" y="${H/2}" text-anchor="middle" fill="#7a8a72" font-size="15">Not enough data yet</text>`;chartPlot=null;return;}
  const xs=data.map(d=>d[0]),ys=data.map(d=>d[1]);
  const x0=Math.min(...xs),x1=Math.max(...xs);
  let y0=Math.min(...ys),y1=Math.max(...ys);if(y0===y1){y0-=1;y1+=1;}
  const padY=(y1-y0)*0.08; y0-=padY; y1+=padY;
  const sx=t=>P+(t-x0)/((x1-x0)||1)*(W-2*P);
  const sy=v=>H-P-(v-y0)/((y1-y0)||1)*(H-2*P);
  const fmtT=t=>{const d=new Date(t*1000);
    return chartHours<=24?d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})
                         :d.toLocaleDateString([],{month:'numeric',day:'numeric'});};
  const unit=chartUnit(), dec=(unit==='%')?0:1;
  let h='';
  // horizontal gridlines + y labels (5)
  for(let i=0;i<=4;i++){
    const v=y0+(y1-y0)*i/4, yy=sy(v);
    h+=`<line x1="${P}" y1="${yy.toFixed(1)}" x2="${W-P}" y2="${yy.toFixed(1)}" stroke="#e6f0de"/>`;
    h+=`<text x="${P-7}" y="${(yy+4).toFixed(1)}" text-anchor="end" font-size="12" fill="#7a8a72">${v.toFixed(dec)}${unit}</text>`;
  }
  // x ticks + labels (4)
  for(let i=0;i<=3;i++){
    const t=x0+(x1-x0)*i/3, xx=sx(t);
    h+=`<line x1="${xx.toFixed(1)}" y1="${H-P}" x2="${xx.toFixed(1)}" y2="${H-P+4}" stroke="#cdddc0"/>`;
    const a=i===0?'start':(i===3?'end':'middle');
    h+=`<text x="${xx.toFixed(1)}" y="${H-P+18}" text-anchor="${a}" font-size="12" fill="#7a8a72">${fmtT(t)}</text>`;
  }
  h+=`<line x1="${P}" y1="${H-P}" x2="${W-P}" y2="${H-P}" stroke="#cdddc0"/>`;
  h+=`<line x1="${P}" y1="${P}" x2="${P}" y2="${H-P}" stroke="#cdddc0"/>`;
  const line=data.map(d=>`${sx(d[0]).toFixed(1)},${sy(d[1]).toFixed(1)}`).join(' ');
  h+=`<polyline fill="none" stroke="#4a7c59" stroke-width="2.5" points="${line}"/>`;
  // hover marker (hidden until mousemove)
  h+=`<line id="hvl" y1="${P}" y2="${H-P}" stroke="#4a7c59" stroke-width="1" stroke-dasharray="3 3" style="display:none"/>`;
  h+=`<circle id="hdot" r="4" fill="#2e7d32" stroke="#fff" stroke-width="1.5" style="display:none"/>`;
  svg.innerHTML=h;
  chartPlot={unit,dec,
    pts:data.map(d=>({x:sx(d[0]),y:sy(d[1]),v:d[1],t:d[0]})),
    fmt:t=>new Date(t*1000).toLocaleString([],{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})};
}
function chartMove(e){
  if(!chartPlot)return;
  const svg=document.getElementById('histchart'), ctm=svg.getScreenCTM&&svg.getScreenCTM();
  if(!ctm)return;
  const sp=svg.createSVGPoint(); sp.x=e.clientX; sp.y=e.clientY;
  const loc=sp.matrixTransform(ctm.inverse());
  let best=null,bd=1e9;
  for(const p of chartPlot.pts){const d=Math.abs(p.x-loc.x);if(d<bd){bd=d;best=p;}}
  if(!best)return;
  const vl=document.getElementById('hvl'),dot=document.getElementById('hdot'),tip=document.getElementById('charttip');
  if(vl){vl.setAttribute('x1',best.x);vl.setAttribute('x2',best.x);vl.style.display='';}
  if(dot){dot.setAttribute('cx',best.x);dot.setAttribute('cy',best.y);dot.style.display='';}
  if(tip){
    tip.textContent=`${best.v.toFixed(chartPlot.dec)}${chartPlot.unit} \u00b7 ${chartPlot.fmt(best.t)}`;
    tip.style.display='';tip.style.left=(e.clientX+12)+'px';tip.style.top=(e.clientY-32)+'px';
  }
}
function chartLeave(){
  ['hvl','hdot','charttip'].forEach(id=>{const el=document.getElementById(id);if(el)el.style.display='none';});
}
function floatLabel(v){
  return v===null ? 'no sensor' : (v>=1 ? 'not full' : 'full');
}
async function pollFloat(){
  try{
    const r=await fetch('/api/float');
    if(!r.ok)return;
    const j=await r.json();
    const fs=document.getElementById('floatstate');
    if(fs)fs.textContent=floatLabel(j.float);
  }catch(e){}
}
function renderWater(j){
  const w=j.water;const box=document.getElementById('waterctl');
  if(!w){box.style.display='none';return;}
  box.style.display='';
  document.getElementById('floatstate').textContent = floatLabel(w.float);
  document.getElementById('pumptoday').textContent=w.today_seconds;
  const btn=document.getElementById('pumpbtn');
  const fbtn=document.getElementById('fillbtn');
  const busy = !w.pump_hw || w.pump_running;
  btn.disabled = busy;
  if(fbtn)fbtn.disabled = busy;
  btn.textContent = w.pump_running ? 'Pumping...' : 'Test pump';
  if(fbtn)fbtn.textContent = w.pump_running ? 'Filling...' : 'Fill to float';
  if(!w.pump_hw)document.getElementById('pumpinfo').textContent='no pump hardware';
  else if(w.pump_last && !w.pump_running)
    document.getElementById('pumpinfo').textContent='last: '+w.pump_last;
}
async function calibrate(point){
  const info=document.getElementById('calinfo');info.textContent='saving...';
  try{
    const r=await fetch('/api/dryness_cal',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({point})});
    const j=await r.json().catch(()=>({}));
    if(r.ok&&j.ok){info.textContent=`${point} set (${j.cells} cells)`;refresh();}
    else info.textContent = r.status===401?'log in to calibrate'
                          :('failed: '+(j.error||('HTTP '+r.status)));
  }catch(e){info.textContent='calibration failed';}
}
function initSensors(){
  const fb=document.getElementById('fillbtn');
  if(fb)fb.addEventListener('click',async()=>{
    const info=document.getElementById('pumpinfo');info.textContent='filling...';
    try{
      const r=await fetch('/api/pump',{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({until_full:true})});
      const j=await r.json().catch(()=>({}));
      if(!r.ok)info.textContent = r.status===401 ? 'log in to run the pump'
              : ('fill failed: '+(j.error||('HTTP '+r.status)));
      // success/result shows via the status poll (pump_last) + live float
    }catch(e){info.textContent='fill request failed';}
  });
  const pb=document.getElementById('pumpbtn');
  if(pb)pb.addEventListener('click',async()=>{
    const secs=+document.getElementById('pumpsecs').value||3;
    document.getElementById('pumpinfo').textContent='starting...';
    try{
      const r=await fetch('/api/pump',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({seconds:secs})});
      const j=await r.json();
      if(!j.ok)document.getElementById('pumpinfo').textContent=j.error||'failed';
    }catch(e){document.getElementById('pumpinfo').textContent='request failed';}
  });
  const cw=document.getElementById('calwet');
  if(cw)cw.addEventListener('click',()=>calibrate('wet'));
  const cd=document.getElementById('caldry');
  if(cd)cd.addEventListener('click',()=>calibrate('dry'));
  const hc=document.getElementById('histchart');
  if(hc){hc.addEventListener('mousemove',chartMove);hc.addEventListener('mouseleave',chartLeave);}
  document.getElementById('chartsensor').addEventListener('change',e=>{
    chartSensor=e.target.value;loadChart();});
  document.querySelectorAll('#ranges button').forEach(b=>{
    b.addEventListener('click',()=>{
      chartHours=+b.dataset.h;
      document.querySelectorAll('#ranges button').forEach(x=>x.classList.remove('on'));
      b.classList.add('on');loadChart();});
  });
}

// ---------------- cell grid overlay ----------------
let grid=null, gdrag=-1, gridDirty=false;
function colL(c){return String.fromCharCode(65+c);}
function cellKey(r,c){return colL(c)+(r+1);}
function bil(C,u,v){
  const t=[(1-u)*C[0][0]+u*C[1][0],(1-u)*C[0][1]+u*C[1][1]];
  const b=[(1-u)*C[3][0]+u*C[2][0],(1-u)*C[3][1]+u*C[2][1]];
  return [(1-v)*t[0]+v*b[0],(1-v)*t[1]+v*b[1]];
}
function esc(s){return (s||'').replace(/[<>&]/g,'');}
function moistColor(p){const h=35+(210-35)*(Math.max(0,Math.min(100,p))/100);
  return `hsla(${h.toFixed(0)},60%,50%,0.28)`;}
function gridEditable(){return canEdit && grid && !grid.locked;}
function drawGrid(){
  const svg=document.getElementById('gridsvg');
  if(!grid||!svg)return;
  svg.style.display=grid.show?'':'none';
  if(!grid.show){svg.innerHTML='';return;}
  const C=grid.corners,R=grid.rows,K=grid.cols,S=1000;
  let h='';
  for(let r=0;r<R;r++)for(let c=0;c<K;c++){
    const p=[bil(C,c/K,r/R),bil(C,(c+1)/K,r/R),bil(C,(c+1)/K,(r+1)/R),bil(C,c/K,(r+1)/R)];
    const pts=p.map(q=>(q[0]*S).toFixed(1)+','+(q[1]*S).toFixed(1)).join(' ');
    const k=cellKey(r,c);
    const mo=sensorData['moisture:'+k];
    const fill=mo?moistColor(mo.value):'rgba(127,176,105,0.12)';
    h+=`<polygon class="gc" data-k="${k}" points="${pts}" fill="${fill}" stroke="#eafff0" stroke-width="2"/>`;
    const ctr=bil(C,(c+0.5)/K,(r+0.5)/R);
    const cx=(ctr[0]*S).toFixed(1); let yy=ctr[1]*S-3;
    h+=`<text x="${cx}" y="${yy.toFixed(1)}" class="glbl" text-anchor="middle">${k}</text>`;
    const nm=grid.names[k];
    if(nm){yy+=22;h+=`<text x="${cx}" y="${yy.toFixed(1)}" class="gnm" text-anchor="middle">${esc(nm)}</text>`;}
    if(mo){yy+=21;h+=`<text x="${cx}" y="${yy.toFixed(1)}" class="gmoist" text-anchor="middle">${mo.value.toFixed(0)}%</text>`;}
    const gr=sensorData['growth:'+k];
    if(gr){yy+=21;h+=`<text x="${cx}" y="${yy.toFixed(1)}" class="ggrow" text-anchor="middle">\u{1F331} ${gr.value.toFixed(0)}%</text>`;}
    const dr=sensorData['dry:'+k];
    if(dr){const dm=camMoisture(k,dr.value);yy+=21;
      h+=`<text x="${cx}" y="${yy.toFixed(1)}" class="gdry" text-anchor="middle">\u{1F4A7} ${dm!=null?dm.toFixed(0)+'%':dr.value.toFixed(0)}</text>`;}
  }
  if(gridEditable())for(let i=0;i<4;i++)
    h+=`<circle class="gh" data-i="${i}" cx="${(C[i][0]*S).toFixed(1)}" cy="${(C[i][1]*S).toFixed(1)}" r="16"/>`;
  svg.innerHTML=h;
}
function ptFrac(svg,e){
  const r=svg.getBoundingClientRect();
  return [Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),
          Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))];
}
async function saveGrid(){
  gridDirty=true;                 // pending local edit; block poll-sync until saved
  const info=document.getElementById('gridinfo');
  try{
    const r=await fetch('/api/grid',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify(grid)});
    if(!r.ok){
      const j=await r.json().catch(()=>({}));
      if(info)info.textContent = r.status===401
        ? 'not saved \u2014 log in to edit the grid'
        : ('grid not saved: '+(j.error||('HTTP '+r.status)));
      return;                      // stay dirty so a poll won't revert unsaved edits
    }
    gridDirty=false;               // saved; tabs may sync again
    if(info && /not saved|HTTP|log in/.test(info.textContent)) info.textContent='';
  }catch(e){ if(info)info.textContent='grid not saved (request failed)'; }
}
async function detectGrid(){
  if(!gridEditable())return;
  const info=document.getElementById('gridinfo');info.textContent='Detecting...';
  try{
    const r=await fetch('/api/detect_grid',{method:'POST'});const j=await r.json();
    if(j.ok&&j.corners){grid.corners=j.corners;if(!grid.show){grid.show=true;
      document.getElementById('gridshow').checked=true;}
      drawGrid();saveGrid();info.textContent='Detected \u2014 drag corners to fine-tune.';}
    else info.textContent=j.error||'Detection failed; place corners by hand.';
  }catch(e){info.textContent='Detection unavailable; place corners by hand.';}
}
function syncGridControls(){
  if(!grid)return;
  document.getElementById('gridshow').checked=!!grid.show;
  document.getElementById('gridrows').value=grid.rows;
  document.getElementById('gridcols').value=grid.cols;
  applyGridLock();
}
function initGridSvg(){
  const svg=document.getElementById('gridsvg');
  svg.addEventListener('pointerdown',e=>{
    if(!gridEditable())return;
    if(e.target.classList.contains('gh')){
      gdrag=+e.target.dataset.i;svg.setPointerCapture(e.pointerId);e.preventDefault();}
  });
  svg.addEventListener('pointermove',e=>{
    if(gdrag<0||!grid)return;grid.corners[gdrag]=ptFrac(svg,e);drawGrid();});
  svg.addEventListener('pointerup',()=>{if(gdrag>=0){gdrag=-1;saveGrid();}});
  svg.addEventListener('click',e=>{
    if(!canEdit)return;
    if(!e.target.classList.contains('gc'))return;
    const k=e.target.dataset.k,cur=grid.names[k]||'';
    const v=prompt('Name for cell '+k+':',cur);
    if(v!==null){if(v.trim())grid.names[k]=v.trim();else delete grid.names[k];
      drawGrid();saveGrid();}
  });
  document.getElementById('gridshow').addEventListener('change',e=>{
    grid.show=e.target.checked;drawGrid();saveGrid();});
  document.getElementById('detectbtn').addEventListener('click',detectGrid);
  const upd=()=>{if(!gridEditable()){syncGridControls();return;}
    grid.rows=Math.max(1,Math.min(12,+document.getElementById('gridrows').value||4));
    grid.cols=Math.max(1,Math.min(12,+document.getElementById('gridcols').value||4));
    drawGrid();saveGrid();};
  document.getElementById('gridrows').addEventListener('change',upd);
  document.getElementById('gridcols').addEventListener('change',upd);
  const lockBtn=document.getElementById('gridlock');
  if(lockBtn)lockBtn.addEventListener('click',()=>{
    if(!grid||!canEdit)return;
    grid.locked=!grid.locked;
    applyGridLock();drawGrid();saveGrid();
  });
}
function applyGridLock(){
  if(!grid)return;
  const locked=!!grid.locked;
  document.body.classList.toggle('gridlocked',locked);
  const btn=document.getElementById('gridlock');
  if(btn)btn.textContent=locked?'\uD83D\uDD13 Unlock grid':'\uD83D\uDD12 Lock grid';
}
function adoptGrid(g){
  grid=g;
  if(!grid.names)grid.names={};
  if(grid.locked===undefined)grid.locked=false;
  syncGridControls();
}
function handleGrid(j){
  if(j.settings&&j.settings.grid){
    const srv=j.settings.grid;
    if(grid===null){
      adoptGrid(srv);
    } else if(gdrag<0 && !gridDirty && JSON.stringify(srv)!==JSON.stringify(grid)){
      // another tab/device saved a newer grid; sync to it instead of holding
      // a stale copy that could later overwrite the saved one
      adoptGrid(srv);
    }
    if(gdrag<0)drawGrid();
  }
}

async function refresh(){
  try{
    const r=await fetch('/api/status');const j=await r.json();
    S={...j,now:new Date(j.now),on:new Date(j.on),off:new Date(j.off),
       sunrise:new Date(j.sunrise),sunset:new Date(j.sunset)};
    fillForm(j.settings);
    renderPhoto(j);
    renderVideoState(j);
    loadFrames();
    applyAuth(j);
    setAiControls(j.settings);
    {const rc=document.getElementById('reportctl');if(rc)rc.style.display=canEdit?'':'none';}
    fetchReport();
    requestAnimationFrame(fitReportHeight);
    handleGrid(j);
    renderSensors(j);
    renderWater(j);
    render();
  }catch(e){document.getElementById('phase').textContent='Controller unreachable';}
}

document.getElementById('cfgform').addEventListener('submit',async ev=>{
  ev.preventDefault();
  const f=ev.target,msg=document.getElementById('msg');
  const body={};
  for(const k of ['latitude','longitude','max_bright','ramp_min',
                  'sunrise_offset_min','sunset_offset_min',
                  'capture_interval_min','capture_brightness'])
    body[k]=parseFloat(f.elements[k].value);
  body.timezone=f.elements['timezone'].value.trim();
  body.roi=f.elements['roi'].value.trim();
  body.capture_enabled=f.elements['capture_enabled'].checked;
  msg.textContent='Planting...';msg.className='';
  try{
    const r=await fetch('/api/settings',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const j=await r.json();
    if(r.ok){msg.textContent='Saved \u{1F331}';msg.className='ok';setTimeout(refresh,800);}
    else{msg.textContent=j.error||'Save failed';msg.className='err';}
  }catch(e){msg.textContent='Save failed';msg.className='err';}
});

setInterval(()=>{const d=new Date();
  document.getElementById('clock').textContent=d.toLocaleTimeString();
  if(S){S.now=d;}},1000);
// ---------------- AI garden report ----------------
function rBadge(h){
  const m={good:['Healthy','rbg-good'],watch:['Watch','rbg-watch'],problem:['Problem','rbg-problem']};
  const v=m[h]||['\u2014','rbg-watch'];
  return `<span class="rbadge ${v[1]}">${v[0]}</span>`;
}
function rList(title,arr){
  if(!arr||!arr.length)return '';
  return `<div class="rsec"><h4>${title}</h4><ul>${arr.map(x=>`<li>${esc(String(x))}</li>`).join('')}</ul></div>`;
}
function rAgo(ts){
  if(!ts)return '';
  return new Date(ts*1000).toLocaleString([],{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
}
function fitReportHeight(){
  const card=document.getElementById('reportcard');
  const media=document.querySelector('.amedia');
  if(!card||!media)return;
  if(window.innerWidth<1100){card.style.maxHeight='';return;}  // single column: let it flow
  const top=card.getBoundingClientRect().top;
  const mediaBottom=media.getBoundingClientRect().bottom;
  card.style.maxHeight=Math.max(220,Math.round(mediaBottom-top))+'px';
}
function renderReport(j){
  const body=document.getElementById('reportbody'); if(!body)return;
  if(j.generating){body.innerHTML='<p class="rmuted">Generating report\u2026</p>';return;}
  if(j.have_key===false){body.innerHTML='<p class="rmuted">No API key on the controller. Add a <code>.anthropic_key</code> file (or set ANTHROPIC_API_KEY) to enable AI reports.</p>';return;}
  if(j.ok===null||j.ok===undefined){body.innerHTML='<p class="rmuted">No report yet. Generate one, or enable the daily report.</p>';return;}
  if(j.ok===false){body.innerHTML=`<p class="rmuted">Last attempt failed: ${esc(j.error||'unknown error')}</p>`;return;}
  const r=j.report||{};
  let h=`<div class="rhead">${rBadge(r.overall_health)}<span class="rtime">${rAgo(j.ts)}${j.model?' \u00b7 '+esc(j.model):''}</span></div>`;
  if(r.summary)h+=`<p class="rsummary">${esc(r.summary)}</p>`;
  const f=[];
  if(r.germination&&r.germination.sprouted!=null&&r.germination.total_cells!=null)
    f.push(`Germinated ${r.germination.sprouted}/${r.germination.total_cells}`);
  if(r.growth_stage)f.push('Stage: '+esc(r.growth_stage));
  if(r.light&&r.light.assessment)f.push('Light: '+esc(r.light.assessment));
  if(r.water&&r.water.assessment)f.push('Water: '+esc(r.water.assessment));
  if(f.length)h+=`<p class="rfacts">${f.join(' \u00b7 ')}</p>`;
  if(r.light&&r.light.reason)h+=`<p class="rreason"><b>Light:</b> ${esc(r.light.reason)}</p>`;
  if(r.water&&r.water.reason)h+=`<p class="rreason"><b>Water:</b> ${esc(r.water.reason)}</p>`;
  h+=rList('Concerns',r.concerns);
  h+=rList('Recommendations',r.recommendations);
  if(r.per_cell&&r.per_cell.length)
    h+=`<div class="rsec"><h4>Cell notes</h4><ul>${r.per_cell.map(c=>`<li><b>${esc(c.cell||'')}</b> ${esc(c.note||'')}</li>`).join('')}</ul></div>`;
  if(r.species&&r.species.length)
    h+=`<div class="rsec"><h4>Species guesses</h4><ul>${r.species.map(s=>`<li><b>${esc(s.cell||'')}</b> ${esc(s.guess||'unsure')}${s.confidence?` <span class="rconf">(${esc(s.confidence)})</span>`:''}${s.why?` &mdash; ${esc(s.why)}`:''}</li>`).join('')}</ul></div>`;
  if(r.confidence)h+=`<p class="rconf">Confidence: ${esc(r.confidence)}${j.parse_error?' \u00b7 (reply was not structured JSON)':''}</p>`;
  body.innerHTML=h;
}
let lastReportSig=null;
async function fetchReport(){
  try{
    const r=await fetch('/api/report');
    const j=await r.json();
    const sig=`${j.ts}|${j.generating}|${j.ok}|${j.have_key}`;
    if(sig!==lastReportSig){           // only re-render when something changed
      lastReportSig=sig;
      renderReport(j);
      requestAnimationFrame(fitReportHeight);
    }
    if(j.generating)setTimeout(fetchReport,4000);   // poll faster until it lands
  }catch(e){}
}
async function genReport(){
  const info=document.getElementById('reportinfo');if(info)info.textContent='working\u2026';
  document.getElementById('reportbody').innerHTML='<p class="rmuted">Generating report\u2026 this takes ~20s.</p>';
  try{
    const r=await fetch('/api/report',{method:'POST'});
    const j=await r.json();
    if(info)info.textContent='';
    if(j.ok){renderReport({...j,have_key:true});lastReportSig=`${j.ts}|${j.generating}|${j.ok}|true`;}
    else renderReport({ok:false,error:j.error||('HTTP '+r.status)});
    requestAnimationFrame(fitReportHeight);
  }catch(e){
    if(info)info.textContent='';
    document.getElementById('reportbody').innerHTML='<p class="rmuted">Request timed out, but it may still be generating. Reload in a moment to see it.</p>';
  }
}
function setAiControls(s){
  if(!s)return;
  const en=document.getElementById('aienabled'),t=document.getElementById('aitime');
  if(en&&document.activeElement!==en)en.checked=!!s.ai_enabled;
  if(t&&document.activeElement!==t&&s.ai_report_hour!=null){
    const h=String(s.ai_report_hour).padStart(2,'0');
    const m=String(s.ai_report_minute||0).padStart(2,'0');
    t.value=`${h}:${m}`;
  }
}
async function saveAi(){
  const en=document.getElementById('aienabled'),t=document.getElementById('aitime');
  const parts=(t.value||'08:00').split(':');
  const h=Math.min(23,Math.max(0,parseInt(parts[0],10)||0));
  const m=Math.min(59,Math.max(0,parseInt(parts[1],10)||0));
  try{await fetch('/api/ai_settings',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ai_enabled:en.checked,ai_report_hour:h,ai_report_minute:m})});}catch(e){}
}
function initReport(){
  const gb=document.getElementById('genreport');if(gb)gb.addEventListener('click',genReport);
  const en=document.getElementById('aienabled');if(en)en.addEventListener('change',saveAi);
  const t=document.getElementById('aitime');if(t)t.addEventListener('change',saveAi);
  window.addEventListener('resize',fitReportHeight);
  if('ResizeObserver' in window){
    const m=document.querySelector('.amedia');
    if(m)new ResizeObserver(()=>fitReportHeight()).observe(m);
  }
  fetchReport();
}

setInterval(refresh,15000);
setInterval(render,60000);
setInterval(pollFloat,1500);
[initAuth, initSensors, initGridSvg, initReport].forEach(fn=>{
  try{ fn(); }catch(e){ console.error(fn.name+' init failed:', e); }
});
refresh();
