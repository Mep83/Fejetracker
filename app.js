const KEY="fejetracker-v1";
const TODAY=()=>new Date().toISOString().slice(0,10);
let state=load();
let mode="idle", paused=false, watchId=null, current=[], currentLine=null, posMarker=null;
let layers=new Map();

function load(){
  try{
    const s=JSON.parse(localStorage.getItem(KEY));
    if(s && Array.isArray(s.segments)) return s;
  }catch(e){}
  return {segments:[], swept:{}};
}
function save(){localStorage.setItem(KEY,JSON.stringify(state))}
function rad(x){return x*Math.PI/180}
function meters(a,b){
  const R=6371000, dLat=rad(b[0]-a[0]), dLon=rad(b[1]-a[1]);
  const x=Math.sin(dLat/2)**2+Math.cos(rad(a[0]))*Math.cos(rad(b[0]))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(x));
}
function lineLen(points){let n=0;for(let i=1;i<points.length;i++)n+=meters(points[i-1],points[i]);return n}
function pointSegDist(p,a,b){
  const lat0=rad(p[0]), kx=111320*Math.cos(lat0), ky=110540;
  const px=(p[1])*kx, py=p[0]*ky, ax=a[1]*kx, ay=a[0]*ky, bx=b[1]*kx, by=b[0]*ky;
  const vx=bx-ax, vy=by-ay, wx=px-ax, wy=py-ay, c=vx*vx+vy*vy;
  let t=c?Math.max(0,Math.min(1,(wx*vx+wy*vy)/c)):0;
  return Math.hypot(px-(ax+t*vx),py-(ay+t*vy));
}
function nearPointOnSegment(p, pts, tol=12){
  for(let i=1;i<pts.length;i++) if(pointSegDist(p,pts[i-1],pts[i])<=tol) return i;
  return -1;
}
function sweptSet(){const d=TODAY();state.swept[d]??={};return state.swept[d]}
function colorFor(seg){return sweptSet()[seg.id]?.done ? "#24b36b" : "#d84646"}

const map=L.map("map",{zoomControl:true}).setView([55.63,12.60],13);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:20,attribution:"© OpenStreetMap"}).addTo(map);

function render(){
  layers.forEach(l=>map.removeLayer(l)); layers.clear();
  state.segments.forEach(seg=>{
    const l=L.polyline(seg.points,{color:colorFor(seg),weight:7,opacity:.9}).addTo(map).bindTooltip(seg.name);
    layers.set(seg.id,l);
  });
  updateStats(); renderList();
}
function renderList(){
  const el=document.getElementById("segmentsList"); el.innerHTML="";
  if(!state.segments.length){el.innerHTML="<p>Ingen cykelstier kortlagt endnu.</p>";return}
  state.segments.forEach(seg=>{
    const row=document.createElement("div");row.className="row";
    row.innerHTML=`<div><strong>${escapeHtml(seg.name)}</strong><br><small>${(lineLen(seg.points)/1000).toFixed(2)} km · ${new Date(seg.created).toLocaleDateString("da-DK")}</small></div><button>Slet</button>`;
    row.querySelector("button").onclick=()=>{if(confirm(`Slet "${seg.name}"?`)){state.segments=state.segments.filter(x=>x.id!==seg.id);save();render()}};
    el.appendChild(row);
  });
}
function escapeHtml(s){return s.replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]))}
function updateStats(){
  const total=state.segments.reduce((n,s)=>n+lineLen(s.points),0);
  const sw=sweptSet();
  const done=state.segments.reduce((n,s)=>n+(sw[s.id]?.done?lineLen(s.points):0),0);
  document.getElementById("sweptKm").textContent=(done/1000).toFixed(2).replace(".",",")+" km";
  document.getElementById("leftKm").textContent=(Math.max(0,total-done)/1000).toFixed(2).replace(".",",")+" km";
  document.getElementById("percent").textContent=(total?Math.round(done/total*100):0)+" %";
}
function setMode(m){
  mode=m;paused=false;
  const names={idle:"Klar",mapping:"Kortlægger",sweeping:"Fejer"};
  document.getElementById("modeBadge").textContent=names[m];
  document.getElementById("mapBtn").classList.toggle("hidden",m!=="idle");
  document.getElementById("sweepBtn").classList.toggle("hidden",m!=="idle");
  document.getElementById("pauseBtn").classList.toggle("hidden",m==="idle");
  document.getElementById("stopBtn").classList.toggle("hidden",m==="idle");
}
function startWatch(){
  if(!navigator.geolocation){alert("GPS er ikke tilgængelig.");return false}
  if(watchId!==null) navigator.geolocation.clearWatch(watchId);
  watchId=navigator.geolocation.watchPosition(onPos,onGpsError,{enableHighAccuracy:true,maximumAge:1000,timeout:15000});
  return true;
}
function onPos(p){
  const ll=[p.coords.latitude,p.coords.longitude], acc=Math.round(p.coords.accuracy);
  document.getElementById("gps").textContent="±"+acc+" m";
  if(!posMarker){posMarker=L.circleMarker(ll,{radius:8,color:"#fff",weight:3,fillColor:"#2589ff",fillOpacity:1}).addTo(map)}
  else posMarker.setLatLng(ll);
  if(mode==="idle") return;
  if(paused) return;
  if(mode==="mapping"){
    if(!current.length || meters(current[current.length-1],ll)>=3){
      current.push(ll);
      if(currentLine) map.removeLayer(currentLine);
      currentLine=L.polyline(current,{color:"#2589ff",weight:7}).addTo(map);
    }
  } else if(mode==="sweeping"){
    // Conservative V1: a whole saved segment turns green only after enough
    // distinct samples have been observed close to it.
    const sw=sweptSet();
    state.segments.forEach(seg=>{
      const idx=nearPointOnSegment(ll,seg.points,12);
      if(idx>=0){
        const r=sw[seg.id]??={hits:[],done:false};
        const bucket=Math.floor(idx/Math.max(1,Math.floor(seg.points.length/12)));
        if(!r.hits.includes(bucket)) r.hits.push(bucket);
        const needed=Math.min(5,Math.max(2,Math.ceil(seg.points.length/25)));
        if(r.hits.length>=needed) r.done=true;
      }
    });
    save();render();
  }
}
function onGpsError(e){document.getElementById("gps").textContent="Fejl"; if(e.code===1) alert("Giv FejeTracker adgang til din placering i Safari-indstillingerne.")}

document.getElementById("locateBtn").onclick=()=>navigator.geolocation.getCurrentPosition(p=>{map.setView([p.coords.latitude,p.coords.longitude],17);onPos(p)},onGpsError,{enableHighAccuracy:true});
document.getElementById("mapBtn").onclick=()=>{current=[];if(startWatch())setMode("mapping")};
document.getElementById("sweepBtn").onclick=()=>{if(!state.segments.length)return alert("Kortlæg mindst én cykelsti først.");if(startWatch())setMode("sweeping")};
document.getElementById("pauseBtn").onclick=()=>{paused=!paused;document.getElementById("pauseBtn").textContent=paused?"▶ Fortsæt":"Ⅱ Pause";document.getElementById("modeBadge").textContent=paused?"Pause":(mode==="mapping"?"Kortlægger":"Fejer")};
document.getElementById("stopBtn").onclick=()=>{
  if(watchId!==null){navigator.geolocation.clearWatch(watchId);watchId=null}
  if(mode==="mapping" && current.length>1){document.getElementById("segmentName").value="Cykelsti "+(state.segments.length+1);document.getElementById("saveDialog").showModal()}
  else {if(currentLine){map.removeLayer(currentLine);currentLine=null}setMode("idle");render()}
};
document.getElementById("saveForm").addEventListener("submit",e=>{
  if(e.submitter?.value==="cancel"){current=[];if(currentLine){map.removeLayer(currentLine);currentLine=null}setMode("idle");return}
  e.preventDefault();
  const name=document.getElementById("segmentName").value.trim()||"Cykelsti "+(state.segments.length+1);
  state.segments.push({id:crypto.randomUUID(),name,created:new Date().toISOString(),points:[...current]});
  current=[];if(currentLine){map.removeLayer(currentLine);currentLine=null}save();document.getElementById("saveDialog").close();setMode("idle");render();
});
document.getElementById("listBtn").onclick=()=>document.getElementById("segmentsDialog").showModal();
document.getElementById("closeDialog").onclick=()=>document.getElementById("segmentsDialog").close();
document.getElementById("resetTodayBtn").onclick=()=>{if(confirm("Nulstil markeringen af dagens fejning?")){delete state.swept[TODAY()];save();render()}};
document.getElementById("exportBtn").onclick=()=>{
  const blob=new Blob([JSON.stringify(state,null,2)],{type:"application/json"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`FejeTracker-backup-${TODAY()}.json`;a.click();URL.revokeObjectURL(a.href);
};
document.getElementById("importFile").onchange=async e=>{
  try{const x=JSON.parse(await e.target.files[0].text());if(!Array.isArray(x.segments))throw 0;if(confirm("Erstat nuværende data med denne backup?")){state=x;save();render()}}catch{alert("Backup-filen kunne ikke læses.")}
};
if("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
render();startWatch();
