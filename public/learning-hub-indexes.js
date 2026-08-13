(function(){
  const data=Array.isArray(window.LEARNING_HUB_INDEXES)?window.LEARNING_HUB_INDEXES:[];
  const esc=v=>String(v??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));
  const norm=v=>String(v??"").toLocaleLowerCase("tr-TR").trim();
  let bound=false;
  const constituentCache=new Map();

  const countryCodes={
    "ABD":"us","Almanya":"de","Arjantin":"ar","Avustralya":"au","Avusturya":"at","Bahreyn":"bh",
    "Bangladeş":"bd","Belçika":"be","Birleşik Arap Emirlikleri":"ae","Birleşik Krallık":"gb",
    "Brezilya":"br","Bulgaristan":"bg","Danimarka":"dk","Endonezya":"id","Fas":"ma","Filipinler":"ph",
    "Finlandiya":"fi","Fransa":"fr","Güney Afrika":"za","Güney Kore":"kr","Hindistan":"in","Hollanda":"nl",
    "Hong Kong":"hk","Hırvatistan":"hr","Japonya":"jp","Kanada":"ca","Katar":"qa","Kazakistan":"kz",
    "Kenya":"ke","Kolombiya":"co","Kuveyt":"kw","Macaristan":"hu","Malezya":"my","Mauritius":"mu",
    "Meksika":"mx","Mısır":"eg","Nijerya":"ng","Norveç":"no","Pakistan":"pk","Peru":"pe","Polonya":"pl",
    "Portekiz":"pt","Romanya":"ro","Rusya":"ru","Singapur":"sg","Slovenya":"si","Sri Lanka":"lk",
    "Suudi Arabistan":"sa","Sırbistan":"rs","Tayland":"th","Tayvan":"tw","Tunus":"tn","Türkiye":"tr",
    "Umman":"om","Vietnam":"vn","Yeni Zelanda":"nz","Yunanistan":"gr","Çekya":"cz","Çin":"cn",
    "İrlanda":"ie","İspanya":"es","İsrail":"il","İsveç":"se","İsviçre":"ch","İtalya":"it",
    "İzlanda":"is","Şili":"cl"
  };
  const specialMarks={
    "Global":{symbol:"🌐",label:"GL"},
    "Avrupa":{symbol:"🇪🇺",label:"EU"},
    "Asya Pasifik":{symbol:"🌏",label:"AP"},
    "Latin Amerika":{symbol:"🌎",label:"LA"}
  };

  function flagMarkup(country){
    const special=specialMarks[country];
    if(special){
      return `<span class="indexCountryFlag noImage" aria-label="${esc(country)}"><span class="indexCountryFlagFallback" style="display:inline;font-size:13px">${special.symbol}</span></span>`;
    }
    const cc=countryCodes[country];
    if(!cc){
      return `<span class="indexCountryFlag noImage"><span class="indexCountryFlagFallback">--</span></span>`;
    }
    return `<span class="indexCountryFlag"><img loading="lazy" src="https://flagcdn.com/w80/${cc}.png" alt="${esc(country)} bayrağı" onerror="this.parentElement.classList.add('noImage')"><span class="indexCountryFlagFallback">${cc.toUpperCase()}</span></span>`;
  }

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

  function constituentsUrl(code){
    const slug=String(code||"").replace(":","-");
    return `https://www.tradingview.com/symbols/${encodeURIComponent(slug)}/components/`;
  }

  function renderConstituents(panel,payload,indexRow){
    const items=Array.isArray(payload?.items)?payload.items:[];
    if(!items.length){
      panel.innerHTML=`<div class="indexConstituentError"><strong>Bileşen listesi alınamadı.</strong>Bu endeks için veri kaynağı şu anda tam bileşen listesi döndürmedi.<br><button type="button" class="indexConstituentFallbackBtn">TradingView bileşenlerini aç</button></div>`;
      panel.querySelector(".indexConstituentFallbackBtn")?.addEventListener("click",e=>{
        e.stopPropagation();window.open(constituentsUrl(indexRow.code),"_blank","noopener,noreferrer");
      });
      return;
    }
    const fetched=payload.fetchedAt?new Date(payload.fetchedAt).toLocaleString("tr-TR"):"";
    panel.innerHTML=`
      <div class="indexConstituentHead">
        <div><strong>Endeks Bileşenleri</strong><small>${esc(payload.source||"Piyasa veri kaynağı")} · ${esc(fetched)}</small></div>
        <span class="indexConstituentCount">${items.length}${payload.totalCount&&payload.totalCount>items.length?` / ${payload.totalCount}`:""} kıymet</span>
      </div>
      <div class="indexConstituentSearch"><input type="search" placeholder="Hisse kodu veya şirket adı ara"></div>
      <div class="indexConstituentTableWrap">
        <table class="indexConstituentTable">
          <colgroup><col><col></colgroup>
          <thead><tr><th>Hisse Kodu</th><th>Hisse Adı</th></tr></thead>
          <tbody>${items.map(item=>`<tr data-search="${esc(norm([item.ticker,item.symbol,item.name].join(" ")))}"><td><span class="indexConstituentTicker" data-stock-symbol="${esc(item.symbol||item.ticker)}">${esc(item.ticker||item.symbol)}</span></td><td>${esc(item.name||item.ticker||"-")}</td></tr>`).join("")}</tbody>
        </table>
      </div>
      <div class="indexConstituentSourceNote">Endeks bileşenleri zaman içinde değişebilir. Liste kart açıldığında güncel kaynaktan alınır ve sunucuda geçici olarak önbelleğe alınır.</div>
    `;
    const search=panel.querySelector("input");
    search?.addEventListener("input",()=>{
      const q=norm(search.value);
      panel.querySelectorAll("tbody tr").forEach(tr=>tr.style.display=!q||String(tr.dataset.search||"").includes(q)?"":"none");
    });
    panel.querySelectorAll("[data-stock-symbol]").forEach(el=>el.addEventListener("click",e=>{
      e.stopPropagation();
      const symbol=el.dataset.stockSymbol||"";
      if(symbol.includes(":"))window.open(`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}`,"_blank","noopener,noreferrer");
    }));
  }

  async function loadConstituents(item,panel){
    const key=String(item.code||"").toUpperCase();
    if(constituentCache.has(key)){
      renderConstituents(panel,constituentCache.get(key),item);return;
    }
    panel.innerHTML='<div class="indexConstituentLoading">Bileşenler yükleniyor…</div>';
    try{
      const params=new URLSearchParams({code:item.code,index:item.index,country:item.country});
      const response=await fetch(`/api/index-constituents?${params.toString()}`,{headers:{"Accept":"application/json"}});
      const payload=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(payload.error||`HTTP ${response.status}`);
      constituentCache.set(key,payload);
      renderConstituents(panel,payload,item);
    }catch(error){
      panel.innerHTML=`<div class="indexConstituentError"><strong>Bileşen listesi alınamadı.</strong>${esc(error?.message||"Veri kaynağı geçici olarak erişilemiyor.")}<br><button type="button" class="indexConstituentFallbackBtn">TradingView bileşenlerini aç</button></div>`;
      panel.querySelector(".indexConstituentFallbackBtn")?.addEventListener("click",e=>{
        e.stopPropagation();window.open(constituentsUrl(item.code),"_blank","noopener,noreferrer");
      });
    }
  }

  function bindCardEvents(host){
    host.querySelectorAll("[data-copy-code]").forEach(btn=>btn.addEventListener("click",async e=>{
      e.stopPropagation();
      const code=btn.dataset.copyCode||"";
      try{await navigator.clipboard.writeText(code);const old=btn.textContent;btn.textContent="Kopyalandı";setTimeout(()=>btn.textContent=old,900)}
      catch{btn.textContent="Seç"}
    }));
    host.querySelectorAll("[data-open-code]").forEach(btn=>btn.addEventListener("click",e=>{
      e.stopPropagation();
      const code=btn.dataset.openCode||"";
      window.open(`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(code)}`,"_blank","noopener,noreferrer");
    }));
    host.querySelectorAll("[data-index-expand]").forEach(trigger=>trigger.addEventListener("click",()=>{
      const card=trigger.closest(".indexCardItem");
      const panel=card?.querySelector(".indexConstituentPanel");
      if(!card||!panel)return;
      const opening=!card.classList.contains("constituentsOpen");
      card.classList.toggle("constituentsOpen",opening);
      if(opening&&!panel.dataset.loaded){
        panel.dataset.loaded="1";
        const id=Number(trigger.dataset.indexExpand);
        const item=data.find(x=>Number(x.id)===id);
        if(item)loadConstituents(item,panel);
      }
    }));
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
          return `<article class="indexCountryCard">
            <div class="indexCountryCardHead">
              <div class="indexCountryIdentity">
                <h5 class="indexCountryTitle">${flagMarkup(country)}${esc(String(country).toLocaleUpperCase("tr-TR"))}</h5>
                <span class="indexCountryRegion">${esc(region)}</span>
              </div>
              <span class="indexCountryCount">${cr.length} endeks</span>
            </div>
            <div class="indexCountryIndexes">${cr.map(x=>`
              <section class="indexCardItem">
                <div class="indexCardTop indexCardTopClickable" data-index-expand="${x.id}">
                  <div class="indexCardName">
                    <strong>${esc(x.index)}</strong>
                    <small>${esc(x.country)}</small>
                    <span class="indexCardExpandHint"><span class="indexCardChevron">⌄</span> İçindeki kıymetleri göster</span>
                  </div>
                  <span class="indexSegment">${esc(x.segment)}</span>
                </div>
                <p class="indexCardDescription">${esc(x.description)}</p>
                <div class="indexCardActions">
                  <span class="indexCode">${esc(x.code)}</span>
                  <button class="indexCodeBtn" type="button" data-copy-code="${esc(x.code)}">Kopyala</button>
                  <button class="indexOpenBtn" type="button" data-open-code="${esc(x.code)}">TV'de Aç</button>
                </div>
                <div class="indexConstituentPanel"></div>
              </section>`).join("")}</div>
          </article>`;
        }).join("")}</div>
      </section>`;
    }).join("");
    bindCardEvents(host);
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
