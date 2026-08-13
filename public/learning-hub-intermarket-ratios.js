(function(){
 const db=window.LEARNING_HUB_INTERMARKET_RATIOS||{};
 const items=Array.isArray(db.items)?db.items:[];
 const esc=v=>String(v??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));
 const norm=v=>String(v??"").toLocaleLowerCase("tr-TR").trim();
 let selected=items[0]?.no||1,bound=false;

 function filtered(){
  const q=norm(document.getElementById("intermarketSearch")?.value||"");
  const cat=document.getElementById("intermarketCategory")?.value||"all";
  const imp=document.getElementById("intermarketImportance")?.value||"all";
  return items.filter(x=>{
   if(cat!=="all"&&x.category!==cat)return false;
   if(imp!=="all"&&x.importance!==imp)return false;
   if(!q)return true;
   return norm([x.no,x.ratio,x.code,x.category,x.meaning,x.rising,x.falling,...x.risingBeneficiaries,...x.fallingBeneficiaries].join(" ")).includes(q);
  });
 }
 function tags(values,cls=""){
  return `<div class="imTags ${cls}">${(values||[]).map(x=>`<span>${esc(x)}</span>`).join("")}</div>`;
 }
 function detail(x){
  const host=document.getElementById("intermarketDetail");if(!host||!x)return;
  selected=x.no;
  host.innerHTML=`
   <div class="imDetailHead">
    <div class="imDetailIdentity"><span class="imNo">#${x.no}</span><div><span class="imEyebrow">${esc(x.category)}</span><h3>${esc(x.ratio)}</h3><small>${esc(x.importance)} · Relative Strength / Intermarket</small></div></div>
    <div class="imDetailActions"><button data-copy-code="${esc(x.code)}">Kopyala</button><button class="tv" data-tv-code="${esc(x.code)}">TV'de Aç</button></div>
   </div>
   <div class="imRuleBox"><strong>Temel Matematik</strong><p>${esc(db.coreRule)}</p></div>
   <section class="imDetailSection"><h4>Ne Ölçer?</h4><p>${esc(x.meaning)}</p><div class="imCode">${esc(x.code)}</div></section>
   <div class="imScenarioGrid">
    <section class="imScenario up"><div class="imScenarioTitle"><span>↑</span><div><b>ORAN YÜKSELİRSE</b><small>Pay / numerator göreli olarak güçlenir</small></div></div><p>${esc(x.rising)}</p><h5>Göreli olarak desteklenen</h5>${tags(x.risingBeneficiaries,"up")}<h5>Göreli olarak geride kalabilecek</h5>${tags(x.risingLagging,"down")}</section>
    <section class="imScenario down"><div class="imScenarioTitle"><span>↓</span><div><b>ORAN DÜŞERSE</b><small>Payda / denominator göreli olarak güçlenir</small></div></div><p>${esc(x.falling)}</p><h5>Göreli olarak desteklenen</h5>${tags(x.fallingBeneficiaries,"up")}<h5>Göreli olarak geride kalabilecek</h5>${tags(x.fallingLagging,"down")}</section>
   </div>
   <section class="imDetailSection"><h4>Nasıl Teyit Edilir?</h4>${tags(x.confirm,"confirm")}</section>
   <section class="imDetailSection caution"><h4>Yanlış Yorum Riski</h4><p>${esc(x.caution)}</p></section>`;
  host.querySelectorAll("[data-copy-code]").forEach(btn=>btn.addEventListener("click",async()=>{
   try{await navigator.clipboard.writeText(btn.dataset.copyCode||"");const old=btn.textContent;btn.textContent="Kopyalandı";setTimeout(()=>btn.textContent=old,900)}catch{}
  }));
  host.querySelectorAll("[data-tv-code]").forEach(btn=>btn.addEventListener("click",()=>{
   window.open(`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(btn.dataset.tvCode||"")}`,"_blank","noopener,noreferrer");
  }));
  document.querySelectorAll(".imRow").forEach(r=>r.classList.toggle("active",Number(r.dataset.no)===Number(x.no)));
 }
 function list(){
  const host=document.getElementById("intermarketList");if(!host)return;
  const f=filtered(),count=document.getElementById("intermarketResultCount");
  if(count)count.textContent=`${f.length} / ${items.length} gösterge`;
  if(!f.length){host.innerHTML='<div class="imEmpty">Filtreye uyan oran bulunamadı.</div>';return}
  const cats=[...new Set(f.map(x=>x.category))];
  host.innerHTML=cats.map(cat=>{
   const rr=f.filter(x=>x.category===cat);
   return `<div class="imCategory"><div class="imCategoryHead"><strong>${esc(cat.toLocaleUpperCase("tr-TR"))}</strong><span>${rr.length}</span></div>
   ${rr.map(x=>`<button type="button" class="imRow ${x.no===selected?"active":""}" data-no="${x.no}">
     <span class="imRowNo">${x.no}</span><span class="imRowMain"><strong>${esc(x.ratio)}</strong><small>${esc(x.code)}</small></span><b class="${x.importance.toLowerCase()}">${esc(x.importance)}</b>
   </button>`).join("")}</div>`;
  }).join("");
  host.querySelectorAll(".imRow").forEach(r=>r.addEventListener("click",()=>detail(items.find(x=>x.no===Number(r.dataset.no)))));
  if(!f.some(x=>x.no===selected))detail(f[0]);
 }
 function core(){
  const host=document.getElementById("intermarketCore");if(!host)return;
  const critical=items.filter(x=>x.importance==="Critical").slice(0,30);
  host.innerHTML=critical.map(x=>`<button type="button" data-core-no="${x.no}"><span>#${x.no}</span><strong>${esc(x.ratio)}</strong><small>${esc(x.category)}</small></button>`).join("");
  host.querySelectorAll("[data-core-no]").forEach(b=>b.addEventListener("click",()=>{
   document.getElementById("intermarketImportance").value="all";
   document.getElementById("intermarketCategory").value="all";
   document.getElementById("intermarketSearch").value="";
   list();detail(items.find(x=>x.no===Number(b.dataset.coreNo)));
   document.getElementById("intermarketWorkspace")?.scrollIntoView({behavior:"smooth",block:"start"});
  }));
 }
 function init(){
  if(bound)return;bound=true;
  const cats=[...new Set(items.map(x=>x.category))];
  const c=document.getElementById("intermarketCategory");
  if(c)c.innerHTML='<option value="all">Tüm Kategoriler</option>'+cats.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join("");
  ["intermarketCategory","intermarketImportance"].forEach(id=>document.getElementById(id)?.addEventListener("change",list));
  document.getElementById("intermarketSearch")?.addEventListener("input",list);
  document.getElementById("intermarketReset")?.addEventListener("click",()=>{
   document.getElementById("intermarketSearch").value="";document.getElementById("intermarketCategory").value="all";document.getElementById("intermarketImportance").value="all";selected=1;list();detail(items[0]);
  });
  document.getElementById("intermarketCriticalOnly")?.addEventListener("click",()=>{
   document.getElementById("intermarketImportance").value="Critical";list();
  });
 }
 window.renderLearningHubIntermarketRatios=function(){
  init();core();list();detail(items.find(x=>x.no===selected)||items[0]);
 };
})();
