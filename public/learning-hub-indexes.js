(function(){
  const data=Array.isArray(window.LEARNING_HUB_INDEXES)?window.LEARNING_HUB_INDEXES:[];
  const esc=v=>String(v??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));
  const norm=v=>String(v??"").toLocaleLowerCase("tr-TR").trim();
  let bound=false;

  function currentRows(){
    const q=norm(document.getElementById("indexHubSearch")?.value||"");
    const region=document.getElementById("indexHubRegion")?.value||"all";
    const country=document.getElementById("indexHubCountry")?.value||"all";
    return data.filter(x=>{
      if(region!=="all"&&x.region!==region)return false;
      if(country!=="all"&&x.country!==country)return false;
      if(!q)return true;
      return norm([x.country,x.region,x.index,x.code,x.description,x.segment].join(" ")).includes(q);
    });
  }

  function syncCountryOptions(){
    const region=document.getElementById("indexHubRegion")?.value||"all";
    const select=document.getElementById("indexHubCountry");if(!select)return;
    const old=select.value;
    const countries=[...new Set(data.filter(x=>region==="all"||x.region===region).map(x=>x.country))].sort((a,b)=>a.localeCompare(b,"tr"));
    select.innerHTML='<option value="all">Tüm Ülkeler</option>'+countries.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join("");
    if(countries.includes(old))select.value=old;
  }

  function render(){
    const rows=currentRows();
    const host=document.getElementById("indexHubGroups");if(!host)return;
    document.getElementById("indexHubResultCount").textContent=`${rows.length} endeks`;
    if(!rows.length){host.innerHTML='<div class="indexEmpty">Filtreye uyan endeks bulunamadı.</div>';return;}
    const regions=[...new Set(rows.map(x=>x.region))];
    host.innerHTML=regions.map(region=>{
      const rr=rows.filter(x=>x.region===region);
      const countries=[...new Set(rr.map(x=>x.country))];
      return `<section class="indexRegionBlock">
        <div class="indexRegionHeader"><h4>${esc(String(region).toLocaleUpperCase("tr-TR"))}</h4><span>${rr.length} endeks · ${countries.length} ülke/bölge</span></div>
        <div class="indexRegionGrid">${countries.map(country=>{
          const cr=rr.filter(x=>x.country===country);
          const initials=String(country).split(/\s+/).filter(Boolean).slice(0,2).map(w=>w[0]).join("").toLocaleUpperCase("tr-TR");
          return `<article class="indexCountryCard">
            <div class="indexCountryCardHead">
              <div class="indexCountryIdentity">
                <h5 class="indexCountryTitle"><span class="indexCountryMark">${esc(initials||"•")}</span>${esc(String(country).toLocaleUpperCase("tr-TR"))}</h5>
                <span class="indexCountryRegion">${esc(region)}</span>
              </div>
              <span class="indexCountryCount">${cr.length} endeks</span>
            </div>
            <div class="indexCountryIndexes">${cr.map(x=>`
              <section class="indexCardItem">
                <div class="indexCardTop">
                  <div class="indexCardName"><strong>${esc(x.index)}</strong><small>${esc(x.country)}</small></div>
                  <span class="indexSegment">${esc(x.segment)}</span>
                </div>
                <p class="indexCardDescription">${esc(x.description)}</p>
                <div class="indexCardActions">
                  <span class="indexCode">${esc(x.code)}</span>
                  <button class="indexCodeBtn" type="button" data-copy-code="${esc(x.code)}">Kopyala</button>
                  <button class="indexOpenBtn" type="button" data-open-code="${esc(x.code)}">TV'de Aç</button>
                </div>
              </section>`).join("")}</div>
          </article>`;
        }).join("")}</div>
      </section>`;
    }).join("");

    host.querySelectorAll("[data-copy-code]").forEach(btn=>btn.addEventListener("click",async()=>{
      const code=btn.dataset.copyCode||"";try{await navigator.clipboard.writeText(code);const old=btn.textContent;btn.textContent="Kopyalandı";setTimeout(()=>btn.textContent=old,900)}catch{btn.textContent="Seç"}
    }));
    host.querySelectorAll("[data-open-code]").forEach(btn=>btn.addEventListener("click",()=>{
      const code=btn.dataset.openCode||"";window.open(`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(code)}`,"_blank","noopener,noreferrer");
    }));
  }

  function init(){
    if(bound)return;bound=true;
    const regions=[...new Set(data.map(x=>x.region))];
    const region=document.getElementById("indexHubRegion");
    if(region)region.innerHTML='<option value="all">Tüm Bölgeler</option>'+regions.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join("");
    syncCountryOptions();
    const countries=new Set(data.map(x=>x.country));
    document.getElementById("indexHubCountryCount").textContent=countries.size;
    document.getElementById("indexHubIndexCount").textContent=data.length;
    document.getElementById("indexHubRegionCount").textContent=regions.length;
    document.getElementById("indexHubSearch")?.addEventListener("input",render);
    document.getElementById("indexHubRegion")?.addEventListener("change",()=>{syncCountryOptions();render()});
    document.getElementById("indexHubCountry")?.addEventListener("change",render);
    document.getElementById("indexHubReset")?.addEventListener("click",()=>{
      const q=document.getElementById("indexHubSearch"),r=document.getElementById("indexHubRegion"),c=document.getElementById("indexHubCountry");
      if(q)q.value="";if(r)r.value="all";syncCountryOptions();if(c)c.value="all";render();
    });
  }
  window.renderLearningHubIndexes=function(){init();render()};
})();
