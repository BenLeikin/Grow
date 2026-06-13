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

function phaseOf(){
  const on=mins(S.on),off=mins(S.off),now=mins(S.now);
  if(now<on)return['Night','Lights come on at '+fmt(S.on)];
  if(now<on+S.ramp)return['Morning ramp','Full brightness at '+fmt(new Date(S.on.getTime()+S.ramp*60000))];
  if(now<off-S.ramp)return['Full light','Evening ramp begins at '+fmt(new Date(S.off.getTime()-S.ramp*60000))];
  if(now<off)return['Evening ramp','Lights off at '+fmt(S.off)];
  return['Night','Lights come on tomorrow around '+fmt(S.on)];
}

function render(){
  if(!S)return;
  document.getElementById('pct').textContent=Math.round(S.brightness)+'%';
  document.getElementById('bulb').style.setProperty('--glow',S.brightness/100);
  const[p,n]=phaseOf();
  document.getElementById('phase').textContent=p;
  document.getElementById('next').textContent=n;
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
let sensorData={}, sensorStub=false;
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
  return {group:'Other', label:key, value:String(val), unit:''};
}
function renderSensors(j){
  sensorData=j.sensors||{};
  sensorStub=!!j.sensor_stub;
  const card=document.getElementById('sensorcard');
  const keys=Object.keys(sensorData);
  card.style.display=keys.length?'':'none';
  document.getElementById('stubbanner').style.display=sensorStub?'':'none';
  // grouped readout
  const groups={};
  for(const k of keys){
    const m=sensorMeta(k, sensorData[k].value);
    (groups[m.group]=groups[m.group]||[]).push(m);
  }
  const order=['Environment','Soil temp','Moisture','Other'];
  let h='';
  for(const g of order){
    if(!groups[g])continue;
    h+=`<div class="sgroup"><h3>${g}</h3>`;
    for(const m of groups[g])
      h+=`<span class="schip">${m.label} <b>${m.value}</b><span class="u">${m.unit}</span></span>`;
    h+='</div>';
  }
  document.getElementById('sreadout').innerHTML=h;
  // chart sensor dropdown (preserve selection)
  const sel=document.getElementById('chartsensor');
  const want=keys.sort().join(',');
  if(sel.dataset.keys!==want){
    sel.dataset.keys=want;
    const cur=sel.value;
    sel.innerHTML=keys.map(k=>{const m=sensorMeta(k,0);
      return `<option value="${k}">${m.group}: ${m.label}</option>`;}).join('');
    if(keys.includes(cur))sel.value=cur;
    else{chartSensor=keys.find(k=>k.startsWith('moisture:'))||keys[0];sel.value=chartSensor;loadChart();}
  }
  if(grid)drawGrid();   // refresh per-cell moisture overlay
}
async function loadChart(){
  if(!chartSensor)return;
  const info=document.getElementById('chartinfo');info.textContent='loading...';
  try{
    const r=await fetch(`/api/series?sensor=${encodeURIComponent(chartSensor)}&hours=${chartHours}`);
    const j=await r.json();drawChart(j.points||[]);info.textContent='';
  }catch(e){info.textContent='chart unavailable';}
}
function drawChart(pts){
  const svg=document.getElementById('histchart'),W=720,H=240,P=34;
  const toF=chartSensor&&chartSensor.startsWith('temp:');
  const data=pts.map(([t,v])=>[t, toF?c2f(v):v]);
  if(data.length<2){svg.innerHTML=`<text x="${W/2}" y="${H/2}" text-anchor="middle" fill="#7a8a72" font-size="15">Not enough data yet</text>`;return;}
  const xs=data.map(d=>d[0]),ys=data.map(d=>d[1]);
  const x0=Math.min(...xs),x1=Math.max(...xs);
  let y0=Math.min(...ys),y1=Math.max(...ys);if(y0===y1){y0-=1;y1+=1;}
  const sx=t=>P+(t-x0)/(x1-x0)*(W-2*P);
  const sy=v=>H-P-(v-y0)/(y1-y0)*(H-2*P);
  const line=data.map(d=>`${sx(d[0]).toFixed(1)},${sy(d[1]).toFixed(1)}`).join(' ');
  const fmtT=t=>{const d=new Date(t*1000);
    return chartHours<=24?d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})
                         :d.toLocaleDateString([],{month:'numeric',day:'numeric'});};
  let h='';
  h+=`<line x1="${P}" y1="${H-P}" x2="${W-P}" y2="${H-P}" stroke="#cdddc0"/>`;
  h+=`<line x1="${P}" y1="${P}" x2="${P}" y2="${H-P}" stroke="#cdddc0"/>`;
  h+=`<polyline fill="none" stroke="#4a7c59" stroke-width="2.5" points="${line}"/>`;
  h+=`<text x="${P-6}" y="${sy(y1)+4}" text-anchor="end" font-size="12" fill="#7a8a72">${y1.toFixed(0)}</text>`;
  h+=`<text x="${P-6}" y="${sy(y0)+4}" text-anchor="end" font-size="12" fill="#7a8a72">${y0.toFixed(0)}</text>`;
  h+=`<text x="${P}" y="${H-P+18}" font-size="12" fill="#7a8a72">${fmtT(x0)}</text>`;
  h+=`<text x="${W-P}" y="${H-P+18}" text-anchor="end" font-size="12" fill="#7a8a72">${fmtT(x1)}</text>`;
  svg.innerHTML=h;
}
function renderWater(j){
  const w=j.water;const box=document.getElementById('waterctl');
  if(!w){box.style.display='none';return;}
  box.style.display='';
  const fs=document.getElementById('floatstate');
  fs.textContent = w.float===null ? 'no sensor'
                 : (w.float>=1 ? 'closed' : 'open');
  document.getElementById('pumptoday').textContent=w.today_seconds;
  const btn=document.getElementById('pumpbtn');
  btn.disabled = !w.pump_hw || w.pump_running;
  btn.textContent = w.pump_running ? 'Pumping...' : 'Test pump';
  if(!w.pump_hw)document.getElementById('pumpinfo').textContent='no pump hardware';
  else if(w.pump_last && !w.pump_running)
    document.getElementById('pumpinfo').textContent='last: '+w.pump_last;
}
function initSensors(){
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
let grid=null, gdrag=-1;
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
    h+=`<text x="${(ctr[0]*S).toFixed(1)}" y="${(ctr[1]*S-3).toFixed(1)}" class="glbl" text-anchor="middle">${k}</text>`;
    const nm=grid.names[k];
    if(nm)h+=`<text x="${(ctr[0]*S).toFixed(1)}" y="${(ctr[1]*S+19).toFixed(1)}" class="gnm" text-anchor="middle">${esc(nm)}</text>`;
    if(mo)h+=`<text x="${(ctr[0]*S).toFixed(1)}" y="${(ctr[1]*S+(nm?40:19)).toFixed(1)}" class="gmoist" text-anchor="middle">${mo.value.toFixed(0)}%</text>`;
  }
  if(canEdit)for(let i=0;i<4;i++)
    h+=`<circle class="gh" data-i="${i}" cx="${(C[i][0]*S).toFixed(1)}" cy="${(C[i][1]*S).toFixed(1)}" r="16"/>`;
  svg.innerHTML=h;
}
function ptFrac(svg,e){
  const r=svg.getBoundingClientRect();
  return [Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),
          Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))];
}
async function saveGrid(){
  try{await fetch('/api/grid',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(grid)});}catch(e){}
}
async function detectGrid(){
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
}
function initGridSvg(){
  const svg=document.getElementById('gridsvg');
  svg.addEventListener('pointerdown',e=>{
    if(!canEdit)return;
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
  const upd=()=>{grid.rows=Math.max(1,Math.min(12,+document.getElementById('gridrows').value||4));
    grid.cols=Math.max(1,Math.min(12,+document.getElementById('gridcols').value||4));
    drawGrid();saveGrid();};
  document.getElementById('gridrows').addEventListener('change',upd);
  document.getElementById('gridcols').addEventListener('change',upd);
}
function handleGrid(j){
  if(j.settings&&j.settings.grid){
    if(grid===null){grid=j.settings.grid;
      if(!grid.names)grid.names={};syncGridControls();}
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
setInterval(refresh,15000);
setInterval(render,60000);
initAuth();
initGridSvg();
initSensors();
refresh();
