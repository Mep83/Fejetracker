const KEY="fejetracker-v1";
const TODAY=()=>new Date().toISOString().slice(0,10);
const MAX_GAP=25;          // forbind aldrig GPS-hop større end 25 m
const MATCH_TOL=9;         // maksimal normal afstand til kortlagt sti
const HOLD_TOL=14;         // lidt ekstra tolerance når vi allerede følger samme sti
const HEADING_TOL=55;      // retning må afvige op til 55 grader
let state=load();
let mode="idle", paused=false, watchId=null, current=[], currentLine=null, posMarker=null;
let layers=new Map(), recentGps=[], lastMatch=null, lastPaint=0, saveTimer=null;

function load(){
  try{
    const s=JSON.parse(localStorage.getItem(KEY));
    if(s && Array.isArray(s.segments)){s.swept??={};return s;}
  }catch(e){}
  return {segments:[],swept:{}};
}
function save(){localStorage.setItem(KEY,JSON.stringify(state))}
function scheduleSave(){clearTimeout(saveTimer);saveTimer=setTimeout(save,700)}
function rad(x){return x*Math.PI/180}
function deg(x){return x*180/Math.PI}
function meters(a,b){
  const R=6371000,dLat=rad(b[0]-a[0]),dLon=rad(b[1]-a[1]);
  const x=Math.sin(dLat/2)**2+Math.cos(rad(a[0]))*Math.cos(rad(b[0]))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(x));
}
function edgeLen(a,b){const d=meters(a,b);return d<=MAX_GAP?d:0}
function lineLen(points){let n=0;for(let i=1;i<points.length;i++)n+=edgeLen(points[i-1],points[i]);return n}
function pointSegDist(p,a,b){
  const lat0=rad(p[0]),kx=111320*Math.cos(lat0),ky=110540;
  const px=p[1]*kx,py=p[0]*ky,ax=a[1]*kx,ay=a[0]*ky,bx=b[1]*kx,by=b[0]*ky;
  const vx=bx-ax,vy=by-ay,wx=px-ax,wy=py-ay,c=vx*vx+vy*vy;
  const t=c?Math.max(0,Math.min(1,(wx*vx+wy*vy)/c)):0;
  return Math.hypot(px-(ax+t*vx),py-(ay+t*vy));
}
function bearing(a,b){
  const y=Math.sin(rad(b[1]-a[1]))*Math.cos(rad(b[0]));
  const x=Math.cos(rad(a[0]))*Math.sin(rad(b[0]))-Math.sin(rad(a[0]))*Math.cos(rad(b[0]))*Math.cos(rad(b[1]-a[1]));
  return (deg(Math.atan2(y,x))+360)%360;
}
function headingDiff(a,b){let d=Math.abs(a-b)%180;return Math.min(d,180-d)} // begge kørselsretninger accepteres
function currentHeading(){
  if(recentGps.length<2)return null;
  const a=recentGps[0],b=recentGps[recentGps.length-1];
  return meters(a,b)>=8?bearing(a,b):null;
}
function sweptSet(){const d=TODAY();state.swept[d]??={};return state.swept[d]}
function sweptEdges(seg){const r=sweptSet()[seg.id]??={};r.edges??=[];return r.edges}
function isEdgeSwept(seg,i){return !!sweptSet()[seg.id]?.edges?.includes(i)}
function splitValid(points){
  const parts=[];let p=[];
  for(let i=0;i<points.length;i++){
    if(i>0 && meters(points[i-1],points[i])>MAX_GAP){if(p.length>1)parts.push(p);p=[];}
    p.push(points[i]);
  }
  if(p.length>1)parts.push(p);return parts;
}
function greenParts(seg){
  const done=new Set(sweptSet()[seg.id]?.edges||[]),out=[];let p=[];
  for(let i=1;i<seg.points.length;i++){
    const valid=meters(seg.points[i-1],seg.points[i])<=MAX_GAP;
    if(valid && done.has(i)){
      if(!p.length)p=[seg.points[i-1]];p.push(seg.points[i]);
    }else{if(p.length>1)out.push(p);p=[];}
  }
  if(p.length>1)out.push(p);return out;
}

const map=L.map("map",{zoomControl:true}).setView([55.63,12.60],13);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:20,attribution:"© OpenStreetMap"}).addTo(map);

function clearSegLayers(){layers.forEach(arr=>arr.forEach(l=>map.removeLayer(l)));layers.clear()}
function render(){
  clearSegLayers();
  state.segments.forEach(seg=>{
    const arr=[];
    splitValid(seg.points).forEach(part=>arr.push(L.polyline(part,{color:"#d84646",weight:7,opacity:.9}).addTo(map).bindTooltip(seg.name)));
    greenParts(seg).forEach(part=>arr.push(L.polyline(part,{color:"#24b36b",weight:8,opacity:1}).addTo(map).bindTooltip(seg.name+" · fejet")));
    layers.set(seg.id,arr);
  });
  updateStats();renderList();
}
function renderList(){
  const el=document.getElementById("segmentsList");el.innerHTML="";
  if(!state.segments.length){el.innerHTML="<p>Ingen cykelstier kortlagt endnu.</p>";return}
  state.segments.forEach(seg=>{
    const row=document.createElement("div");row.className="row";
    row.innerHTML=`<div><strong>${escapeHtml(seg.name)}</strong><br><small>${(lineLen(seg.points)/1000).toFixed(2)} km · ${new Date(seg.created).toLocaleDateString("da-DK")}</small></div><button>Slet</button>`;
    row.querySelector("button").onclick=()=>{if(confirm(`Slet "${seg.name}"?`)){state.segments=state.segments.filter(x=>x.id!==seg.id);save();render()}};
    el.appendChild(row);
  });
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]))}
function sweptLength(seg){let n=0;const done=new Set(sweptSet()[seg.id]?.edges||[]);for(let i=1;i<seg.points.length;i++)if(done.has(i))n+=edgeLen(seg.points[i-1],seg.points[i]);return n}
function updateStats(){
  const total=state.segments.reduce((n,s)=>n+lineLen(s.points),0);
  const done=state.segments.reduce((n,s)=>n+sweptLength(s),0);
  document.getElementById("sweptKm").textContent=(done/1000).toFixed(2).replace(".",",")+" km";
  document.getElementById("leftKm").textContent=(Math.max(0,total-done)/1000).toFixed(2).replace(".",",")+" km";
  document.getElementById("percent").textContent=(total?Math.round(done/total*100):0)+" %";
}
function setMode(m){
  mode=m;paused=false;recentGps=[];lastMatch=null;
  const names={idle:"Klar",mapping:"Kortlægger",sweeping:"Fejer"};
  document.getElementById("modeBadge").textContent=names[m];
  document.getElementById("mapBtn").classList.toggle("hidden",m!=="idle");
  document.getElementById("sweepBtn").classList.toggle("hidden",m!=="idle");
  document.getElementById("pauseBtn").classList.toggle("hidden",m==="idle");
  document.getElementById("stopBtn").classList.toggle("hidden",m==="idle");
}
function startWatch(){
  if(!navigator.geolocation){alert("GPS er ikke tilgængelig.");return false}
  if(watchId!==null)navigator.geolocation.clearWatch(watchId);
  watchId=navigator.geolocation.watchPosition(onPos,onGpsError,{enableHighAccuracy:true,maximumAge:500,timeout:15000});return true;
}
function findBestEdge(ll){
  const hdg=currentHeading();let best=null;
  state.segments.forEach(seg=>{
    for(let i=1;i<seg.points.length;i++){
      const a=seg.points[i-1],b=seg.points[i];if(meters(a,b)>MAX_GAP)continue;
      const d=pointSegDist(ll,a,b);let tol=MATCH_TOL;
      // Hysterese: hold fast i den del af sporet vi allerede følger.
      const nearLast=lastMatch && lastMatch.id===seg.id && Math.abs(i-lastMatch.i)<=18;
      if(nearLast)tol=HOLD_TOL;if(d>tol)continue;
      let dirPenalty=0;
      if(hdg!==null){const dd=headingDiff(hdg,bearing(a,b));if(dd>HEADING_TOL && !nearLast)continue;dirPenalty=dd*0.035;}
      let score=d+dirPenalty;
      if(nearLast)score-=3.0;
      if(!best||score<best.score)best={id:seg.id,i,d,score};
    }
  });
  return best;
}
function markAround(match,ll){
  if(!match)return false;const seg=state.segments.find(s=>s.id===match.id);if(!seg)return false;
  const r=sweptSet()[seg.id]??={edges:[]};r.edges??=[];const done=new Set(r.edges);let changed=false;
  // Markér kun den del der faktisk er passeret: ca. 12 m omkring den aktuelle position.
  for(let i=Math.max(1,match.i-4);i<=Math.min(seg.points.length-1,match.i+4);i++){
    if(meters(seg.points[i-1],seg.points[i])>MAX_GAP)continue;
    if(pointSegDist(ll,seg.points[i-1],seg.points[i])<=12 && !done.has(i)){done.add(i);changed=true;}
  }
  if(changed)r.edges=[...done].sort((a,b)=>a-b);return changed;
}
function onPos(p){
  const ll=[p.coords.latitude,p.coords.longitude],acc=Math.round(p.coords.accuracy);
  document.getElementById("gps").textContent="±"+acc+" m";
  if(!posMarker)posMarker=L.circleMarker(ll,{radius:8,color:"#fff",weight:3,fillColor:"#2589ff",fillOpacity:1}).addTo(map);else posMarker.setLatLng(ll);
  if(mode==="idle"||paused)return;
  recentGps.push(ll);while(recentGps.length>6)recentGps.shift();
  if(mode==="mapping"){
    if(!current.length){current.push(ll);return;}
    const d=meters(current[current.length-1],ll);
    if(d>=3){
      current.push(ll);
      if(currentLine)map.removeLayer(currentLine);
      const parts=splitValid(current);currentLine=L.layerGroup(parts.map(part=>L.polyline(part,{color:"#2589ff",weight:7}))).addTo(map);
    }
  }else if(mode==="sweeping"){
    const m=findBestEdge(ll);if(m)lastMatch=m;
    if(markAround(m,ll)){
      scheduleSave();const now=Date.now();if(now-lastPaint>900){lastPaint=now;render();}
    }
  }
}
function onGpsError(e){document.getElementById("gps").textContent="Fejl";if(e.code===1)alert("Giv FejeTracker adgang til din placering i Safari-indstillingerne.")}

document.getElementById("locateBtn").onclick=()=>navigator.geolocation.getCurrentPosition(p=>{map.setView([p.coords.latitude,p.coords.longitude],17);onPos(p)},onGpsError,{enableHighAccuracy:true});
document.getElementById("mapBtn").onclick=()=>{current=[];if(startWatch())setMode("mapping")};
document.getElementById("sweepBtn").onclick=()=>{if(!state.segments.length)return alert("Kortlæg mindst én cykelsti først.");if(startWatch())setMode("sweeping")};
document.getElementById("pauseBtn").onclick=()=>{paused=!paused;recentGps=[];lastMatch=null;document.getElementById("pauseBtn").textContent=paused?"▶ Fortsæt":"Ⅱ Pause";document.getElementById("modeBadge").textContent=paused?"Pause":(mode==="mapping"?"Kortlægger":"Fejer")};
document.getElementById("stopBtn").onclick=()=>{
  if(watchId!==null){navigator.geolocation.clearWatch(watchId);watchId=null}save();
  if(mode==="mapping"&&current.length>1){document.getElementById("segmentName").value="Cykelsti "+(state.segments.length+1);document.getElementById("saveDialog").showModal()}
  else{if(currentLine){map.removeLayer(currentLine);currentLine=null}setMode("idle");render()}
};
document.getElementById("saveForm").addEventListener("submit",e=>{
  if(e.submitter?.value==="cancel"){current=[];if(currentLine){map.removeLayer(currentLine);currentLine=null}setMode("idle");return}
  e.preventDefault();const name=document.getElementById("segmentName").value.trim()||"Cykelsti "+(state.segments.length+1);
  state.segments.push({id:crypto.randomUUID(),name,created:new Date().toISOString(),points:[...current]});
  current=[];if(currentLine){map.removeLayer(currentLine);currentLine=null}save();document.getElementById("saveDialog").close();setMode("idle");render();
});
document.getElementById("listBtn").onclick=()=>document.getElementById("segmentsDialog").showModal();
document.getElementById("closeDialog").onclick=()=>document.getElementById("segmentsDialog").close();
document.getElementById("resetTodayBtn").onclick=()=>{if(confirm("Nulstil markeringen af dagens fejning?")){delete state.swept[TODAY()];save();render()}};
document.getElementById("exportBtn").onclick=()=>{const blob=new Blob([JSON.stringify(state,null,2)],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`FejeTracker-backup-${TODAY()}.json`;a.click();URL.revokeObjectURL(a.href)};
document.getElementById("importFile").onchange=async e=>{try{const x=JSON.parse(await e.target.files[0].text());if(!Array.isArray(x.segments))throw 0;if(confirm("Erstat nuværende data med denne backup?")){state=x;state.swept??={};save();render()}}catch{alert("Backup-filen kunne ikke læses.")}};
if("serviceWorker" in navigator)navigator.serviceWorker.register("sw.js");
render();startWatch();
