
(function(){
  const data=[
    ...(Array.isArray(window.CORE_MARKET_INTELLIGENCE_50)?window.CORE_MARKET_INTELLIGENCE_50:[]),
    ...(Array.isArray(window.CORE_MARKET_INTELLIGENCE_51_100)?window.CORE_MARKET_INTELLIGENCE_51_100:[]),
    ...(Array.isArray(window.CORE_MARKET_INTELLIGENCE_101_150)?window.CORE_MARKET_INTELLIGENCE_101_150:[]),
    ...(Array.isArray(window.CORE_MARKET_INTELLIGENCE_151_200)?window.CORE_MARKET_INTELLIGENCE_151_200:[]),
    ...(Array.isArray(window.CORE_MARKET_INTELLIGENCE_201_240)?window.CORE_MARKET_INTELLIGENCE_201_240:[])
  ].sort((a,b)=>a.rank-b.rank);
  let selectedRank=1;

  const esc=value=>String(value??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));

  function pillList(values){
    return (values||[]).map(x=>`<span class="marketIntelTradePill">${esc(x)}</span>`).join("");
  }

  function renderDetail(item){
    const detail=document.getElementById("marketIntelDetail");
    if(!detail||!item)return;
    selectedRank=item.rank;

    detail.innerHTML=`
      <div class="marketIntelDetailTop">
        <div class="marketIntelDetailIdentity">
          <div class="marketIntelDetailRank">#${item.rank}</div>
          <div>
            <h3>${esc(item.name)} <span class="marketIntelNameTr">(${esc(item.nameTr||"")})</span></h3>
            <div class="marketIntelDetailMeta">
              <span class="marketIntelTag ${item.importance==="Critical"?"critical":""}">${esc(item.importance)}</span>
              <span class="marketIntelTag">${esc(item.category)}</span>
              <span class="marketIntelTag">${esc(item.timing)}</span>
              <span class="marketIntelTag">${esc(item.frequency)}</span>
            </div>
          </div>
        </div>
        <div class="marketIntelSource">${esc(item.source)}</div>
      </div>

      <div class="marketIntelSection"><h4>Nedir?</h4><p>${esc(item.what)}</p></div>
      <div class="marketIntelSection"><h4>Ne işe yarar?</h4><p>${esc(item.use)}</p></div>

      <div class="marketIntelSection">
        <div class="marketIntelDirectionGrid">
          <div class="marketIntelDirection up">
            <h4>↑ Yükselirse / güçlenirse</h4>
            <p>${esc(item.up)}</p>
            <div class="marketIntelTradeGrid">
              <div class="marketIntelTradeBox long"><span>Tipik Long / Desteklenen</span><div>${pillList(item.upLong)}</div></div>
              <div class="marketIntelTradeBox short"><span>Tipik Short / Baskılanan</span><div>${pillList(item.upShort)}</div></div>
            </div>
          </div>
          <div class="marketIntelDirection down">
            <h4>↓ Düşerse / zayıflarsa</h4>
            <p>${esc(item.down)}</p>
            <div class="marketIntelTradeGrid">
              <div class="marketIntelTradeBox long"><span>Tipik Long / Desteklenen</span><div>${pillList(item.downLong)}</div></div>
              <div class="marketIntelTradeBox short"><span>Tipik Short / Baskılanan</span><div>${pillList(item.downShort)}</div></div>
            </div>
          </div>
        </div>
      </div>

      <div class="marketIntelSection">
        <h4>Hangi piyasaları etkiler?</h4>
        <div class="marketIntelMarketTags">${(item.markets||[]).map(x=>`<span class="marketIntelTag">${esc(x)}</span>`).join("")}</div>
      </div>

      <div class="marketIntelSection"><h4>Fon yöneticileri neden takip eder?</h4><p>${esc(item.why)}</p></div>

      <div class="marketIntelSection">
        <h4>Birlikte takip edilmesi gereken göstergeler</h4>
        <div class="marketIntelRelated">${(item.related||[]).map(x=>`<span>${esc(x)}</span>`).join("")}</div>
      </div>

      <div class="marketIntelSection"><h4>Yanlış sinyal / dikkat edilmesi gerekenler</h4><p class="marketIntelCaveat">${esc(item.caveat)}</p></div>
    `;

    document.querySelectorAll(".marketIntelRow").forEach(row=>{
      row.classList.toggle("active",Number(row.dataset.rank)===Number(item.rank));
    });
  }

  function filteredData(){
    const query=(document.getElementById("marketIntelSearch")?.value||"").toLocaleLowerCase("tr-TR").trim();
    const category=document.getElementById("marketIntelCategory")?.value||"all";
    const importance=document.getElementById("marketIntelImportance")?.value||"all";
    return data.filter(item=>{
      if(category!=="all"&&item.category!==category)return false;
      if(importance!=="all"&&item.importance!==importance)return false;
      if(!query)return true;
      const hay=[
        item.name,item.nameTr,item.short,item.category,item.what,item.use,item.source,
        ...(item.markets||[]),...(item.related||[])
      ].join(" ").toLocaleLowerCase("tr-TR");
      return hay.includes(query);
    }).sort((a,b)=>a.rank-b.rank);
  }

  function renderList(){
    const list=document.getElementById("marketIntelList");
    if(!list)return;
    const rows=filteredData();
    const count=document.getElementById("marketIntelResultCount");
    if(count)count.textContent=`${rows.length} gösterge`;

    if(!rows.length){
      list.innerHTML='<div class="marketIntelEmptyDetail" style="min-height:220px">Filtreye uyan gösterge bulunamadı.</div>';
      return;
    }

    list.innerHTML=rows.map(item=>`
      <button type="button" class="marketIntelRow ${item.rank===selectedRank?"active":""}" data-rank="${item.rank}">
        <span class="marketIntelRank">${item.rank}</span>
        <span class="marketIntelRowMain">
          <strong>${esc(item.name)} <span class="marketIntelNameTr">(${esc(item.nameTr||"")})</span></strong>
          <span>${esc(item.category)} · ${esc(item.timing)}</span>
        </span>
        <span class="marketIntelImportance ${esc(item.importance)}">${esc(item.importance)}</span>
      </button>
    `).join("");

    list.querySelectorAll(".marketIntelRow").forEach(row=>{
      row.addEventListener("click",()=>{
        const item=data.find(x=>x.rank===Number(row.dataset.rank));
        if(item)renderDetail(item);
      });
    });

    if(!rows.some(x=>x.rank===selectedRank)){
      renderDetail(rows[0]);
    }
  }

  function initFilters(){
    const category=document.getElementById("marketIntelCategory");
    if(category&&category.options.length===1){
      [...new Set(data.map(x=>x.category))].sort((a,b)=>a.localeCompare(b,"tr")).forEach(value=>{
        const option=document.createElement("option");
        option.value=value;option.textContent=value;category.appendChild(option);
      });
    }
    ["marketIntelSearch","marketIntelCategory","marketIntelImportance"].forEach(id=>{
      const el=document.getElementById(id);
      if(!el||el.dataset.bound==="1")return;
      el.dataset.bound="1";
      el.addEventListener(id==="marketIntelSearch"?"input":"change",renderList);
    });
    const reset=document.getElementById("marketIntelReset");
    if(reset&&reset.dataset.bound!=="1"){
      reset.dataset.bound="1";
      reset.addEventListener("click",()=>{
        document.getElementById("marketIntelSearch").value="";
        document.getElementById("marketIntelCategory").value="all";
        document.getElementById("marketIntelImportance").value="all";
        selectedRank=1;renderList();renderDetail(data[0]);
      });
    }
  }

  window.renderMarketIntelligence=function(){
    if(!data.length)return;
    initFilters();
    renderList();
    const current=data.find(x=>x.rank===selectedRank)||data[0];
    renderDetail(current);
  };

  let currentWorkspace="marketIntelligence";

  function setWorkspace(target,render=true){
    if(!["marketIntelligence","indexes"].includes(target))target="marketIntelligence";
    currentWorkspace=target;
    document.querySelectorAll("[data-learning-target]").forEach(x=>x.classList.toggle("active",x.dataset.learningTarget===target&&document.getElementById("learningHub")?.classList.contains("active")));
    document.querySelectorAll("[data-learning-workspace]").forEach(x=>x.classList.toggle("active",x.dataset.learningWorkspace===target));
    document.querySelectorAll(".learningWorkspace").forEach(x=>x.classList.toggle("active",x.id===target));
    if(render){
      if(target==="marketIntelligence")window.renderMarketIntelligence?.();
      if(target==="indexes")window.renderLearningHubIndexes?.();
    }
  }

  window.syncLearningHubNav=function(tabId){
    document.querySelectorAll("[data-learning-target]").forEach(x=>x.classList.toggle("active",tabId==="learningHub"&&x.dataset.learningTarget===currentWorkspace));
  };
  window.renderLearningHubWorkspace=function(){setWorkspace(currentWorkspace,true)};
  window.setLearningHubWorkspace=function(target){setWorkspace(target,true)};

  const main=document.getElementById("learningHubSideButton");
  if(main&&!main.dataset.learningBound){
    main.dataset.learningBound="1";
    main.addEventListener("click",()=>setTimeout(()=>window.renderLearningHubWorkspace?.(),0));
  }

  document.querySelectorAll("[data-learning-target]").forEach(button=>{
    if(button.dataset.learningBound==="1")return;
    button.dataset.learningBound="1";
    button.addEventListener("click",event=>{
      event.preventDefault();event.stopPropagation();
      currentWorkspace=button.dataset.learningTarget||"marketIntelligence";
      if(typeof showMainTab==="function")showMainTab("learningHub");
      setTimeout(()=>setWorkspace(currentWorkspace,true),0);
    });
  });

  document.querySelectorAll("[data-learning-workspace]").forEach(button=>{
    if(button.dataset.learningBound==="1")return;
    button.dataset.learningBound="1";
    button.addEventListener("click",()=>setWorkspace(button.dataset.learningWorkspace||"marketIntelligence",true));
  });

  setWorkspace("marketIntelligence",false);
})();
