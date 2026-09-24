const APP_VERSION="2.2.2";
const KEY="fejetracker-v1";
const TODAY=()=>new Date().toISOString().slice(0,10);
const MAX_GAP=25;          // forbind aldrig GPS-hop større end 25 m
const MATCH_TOL=7;         // konservativ maksimal afstand til kortlagt sti
const HOLD_TOL=9;          // lidt ekstra tolerance når vi allerede følger samme sti
const HEADING_TOL=40;      // retning skal passe tydeligt
const MAX_SWEEP_ACCURACY=8;// ved dårligere GPS markeres intet grønt
const CONFIRM_FIXES=3;     // samme spor skal bekræftes flere gange før markering
const LOCK_EDGE_WINDOW=14; // låst spor må kun fortsætte lokalt langs samme registrering
let state=load();
let mode="idle", paused=false, watchId=null, current=[], currentLine=null, posMarker=null;
let layers=new Map(), recentGps=[], lastMatch=null, candidateMatch=null, candidateCount=0, missCount=0, lastPaint=0, saveTimer=null;

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
const streetLayer=L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:20,attribution:"© OpenStreetMap contributors"});
// Esri World Imagery bruges som redigeringshjælp. Attribution skal vises.
const satelliteLayer=L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",{maxZoom:19,maxNativeZoom:19,attribution:"Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community"});
streetLayer.addTo(map);
L.control.layers({"Kort":streetLayer,"Satellit":satelliteLayer},null,{position:"topright",collapsed:false}).addTo(map);

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
  mode=m;paused=false;recentGps=[];lastMatch=null;candidateMatch=null;candidateCount=0;missCount=0;
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
      // Når vi først er låst på et spor, må vi kun fortsætte i nærheden af sidste kant.
      if(lastMatch && (lastMatch.id!==seg.id || Math.abs(i-lastMatch.i)>LOCK_EDGE_WINDOW))continue;
      const d=pointSegDist(ll,a,b);const tol=lastMatch?HOLD_TOL:MATCH_TOL;if(d>tol)continue;
      let dirPenalty=0;
      if(hdg!==null){const dd=headingDiff(hdg,bearing(a,b));if(dd>HEADING_TOL)continue;dirPenalty=dd*0.05;}
      const score=d+dirPenalty+(lastMatch?Math.abs(i-lastMatch.i)*0.12:0);
      if(!best||score<best.score)best={id:seg.id,i,d,score};
    }
  });
  return best;
}
function confirmMatch(m){
  if(!m){candidateMatch=null;candidateCount=0;missCount++;if(missCount>=4)lastMatch=null;return null;}
  missCount=0;
  if(lastMatch){lastMatch=m;return m;}
  const same=candidateMatch && candidateMatch.id===m.id && Math.abs(candidateMatch.i-m.i)<=LOCK_EDGE_WINDOW;
  if(same)candidateCount++;else{candidateMatch=m;candidateCount=1;}
  candidateMatch=m;
  if(candidateCount>=CONFIRM_FIXES){lastMatch=m;candidateMatch=null;candidateCount=0;return m;}
  return null;
}
function markMatchedEdge(match,ll){
  if(!match)return false;const seg=state.segments.find(s=>s.id===match.id);if(!seg)return false;
  const i=match.i;if(i<1||i>=seg.points.length)return false;
  const a=seg.points[i-1],b=seg.points[i];if(meters(a,b)>MAX_GAP)return false;
  // Kun den ene kant, vi faktisk følger, må blive grøn. Ingen nabokanter markeres automatisk.
  if(pointSegDist(ll,a,b)>MATCH_TOL)return false;
  const r=sweptSet()[seg.id]??={edges:[]};r.edges??=[];
  if(r.edges.includes(i))return false;
  r.edges.push(i);r.edges.sort((a,b)=>a-b);return true;
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
    // Dårlig GPS må hellere efterlade lidt rødt end markere en forkert cykelsti grøn.
    if(p.coords.accuracy>MAX_SWEEP_ACCURACY){candidateMatch=null;candidateCount=0;return;}
    const confirmed=confirmMatch(findBestEdge(ll));
    if(markMatchedEdge(confirmed,ll)){
      scheduleSave();const now=Date.now();if(now-lastPaint>900){lastPaint=now;render();}
    }
  }
}
function onGpsError(e){document.getElementById("gps").textContent="Fejl";if(e.code===1)alert("Giv FejeTracker adgang til din placering i Safari-indstillingerne.")}

document.getElementById("locateBtn").onclick=()=>navigator.geolocation.getCurrentPosition(p=>{map.setView([p.coords.latitude,p.coords.longitude],17);onPos(p)},onGpsError,{enableHighAccuracy:true});
document.getElementById("mapBtn").onclick=()=>{current=[];if(startWatch())setMode("mapping")};
document.getElementById("sweepBtn").onclick=()=>{if(!state.segments.length)return alert("Kortlæg mindst én cykelsti først.");if(startWatch())setMode("sweeping")};
document.getElementById("pauseBtn").onclick=()=>{paused=!paused;recentGps=[];lastMatch=null;candidateMatch=null;candidateCount=0;missCount=0;document.getElementById("pauseBtn").textContent=paused?"▶ Fortsæt":"Ⅱ Pause";document.getElementById("modeBadge").textContent=paused?"Pause":(mode==="mapping"?"Kortlægger":"Fejer")};
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
if("serviceWorker" in navigator){navigator.serviceWorker.register("sw.js?v=2.2.2").then(r=>r.update()).catch(()=>{});}
render();startWatch();

// ---- v2.2 Korteditor (PC/iPhone) ----
let editorMode=null, drawPoints=[], drawLine=null, editHistory=[];
const editorBar=document.getElementById("editorBar"), editorHint=document.getElementById("editorHint");
function snapshotEdit(){editHistory.push(JSON.stringify(state.segments));if(editHistory.length>20)editHistory.shift()}
function setEditorMode(m){editorMode=m;drawPoints=[];if(drawLine){map.removeLayer(drawLine);drawLine=null}
  document.getElementById("drawBtn").classList.toggle("active",m==="draw");
  document.getElementById("deletePartBtn").classList.toggle("active",m==="delete");
  editorHint.textContent=m==="draw"?"Klik langs cykelstien. Når du er færdig, tryk Gem tegning.":m==="delete"?"Klik på det røde stykke, der skal slettes. Kun den valgte kant fjernes.":"Vælg et redigeringsværktøj.";
}
function openEditor(){if(mode!=="idle")return alert("Stop kortlægning/fejning før du redigerer kortet.");editorBar.classList.remove("hidden");setEditorMode("draw")}
function closeEditor(){editorBar.classList.add("hidden");setEditorMode(null);render()}
function redrawDraft(){if(drawLine)map.removeLayer(drawLine);if(drawPoints.length>1)drawLine=L.polyline(drawPoints,{color:"#2589ff",weight:7,dashArray:"8 5"}).addTo(map)}
function nearestEdge(ll,maxD=18){let best=null;state.segments.forEach(seg=>{for(let i=1;i<seg.points.length;i++){if(meters(seg.points[i-1],seg.points[i])>MAX_GAP)continue;const d=pointSegDist(ll,seg.points[i-1],seg.points[i]);if(d<=maxD&&(!best||d<best.d))best={seg,i,d}}});return best}
function deleteEdgeAt(ll){const hit=nearestEdge(ll);if(!hit)return alert("Jeg fandt ikke en cykelsti tæt nok på klikket. Zoom længere ind og prøv igen.");snapshotEdit();const seg=hit.seg,i=hit.i,a=seg.points.slice(0,i),b=seg.points.slice(i);const repl=[];if(a.length>1)repl.push({...seg,id:crypto.randomUUID(),name:seg.name+" A",points:a});if(b.length>1)repl.push({...seg,id:crypto.randomUUID(),name:seg.name+" B",points:b});state.segments=state.segments.flatMap(s=>s.id===seg.id?repl:[s]);save();render()}
map.on("click",e=>{if(editorBar.classList.contains("hidden"))return;const ll=[e.latlng.lat,e.latlng.lng];if(editorMode==="draw"){drawPoints.push(ll);redrawDraft()}else if(editorMode==="delete")deleteEdgeAt(ll)});
const editMapBtn=document.getElementById("editMapBtn");
if(editMapBtn){editMapBtn.addEventListener("click",e=>{e.preventDefault();openEditor();});}
document.getElementById("drawBtn").onclick=()=>setEditorMode("draw");
document.getElementById("deletePartBtn").onclick=()=>setEditorMode("delete");
document.getElementById("closeEditorBtn").onclick=closeEditor;
document.getElementById("undoEditBtn").onclick=()=>{if(drawPoints.length){drawPoints.pop();redrawDraft();return}if(!editHistory.length)return alert("Der er ikke mere at fortryde.");state.segments=JSON.parse(editHistory.pop());save();render()};
document.getElementById("finishEditBtn").onclick=()=>{if(editorMode!=="draw"||drawPoints.length<2)return alert("Tegn mindst to punkter først.");const name=prompt("Navn på cykelstien:","Manuelt tegnet cykelsti")||"Manuelt tegnet cykelsti";snapshotEdit();state.segments.push({id:crypto.randomUUID(),name,created:new Date().toISOString(),source:"manual",points:[...drawPoints]});drawPoints=[];if(drawLine){map.removeLayer(drawLine);drawLine=null}save();render();editorHint.textContent="Gemt. Du kan tegne næste cykelsti."};
