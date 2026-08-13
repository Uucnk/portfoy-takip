(function(){
  const data=Array.isArray(window.LEARNING_HUB_EXTREM_INDEXES)?window.LEARNING_HUB_EXTREM_INDEXES:[];
  const esc=v=>String(v??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));
  const norm=v=>String(v??"").toLocaleLowerCase("tr-TR").trim();
  let bound=false;

  function filtered(){
    const q=norm(document.getElementById("extremIndexSearch")?.value||"");
    const cat=document.getElementById("extremIndexCategory")?.value||"all";
    return data.filter(x=>{
      if(cat!=="all"&&x.category!==cat)return false;
      if(!q)return true;
      return norm([x.category,x.subgroup,x.name,x.code,x.role,x.source].join(" ")).includes(q);
    });
  }

  function sourceClass(source){
    const s=norm(source);
    if(s.includes("tradingview"))return"tv";
    if(s.includes("fred"))return"fred";
    if(s.includes("bloomberg"))return"bloomberg";
    if(s.includes("cboe"))return"cboe";
    if(s.includes("etf"))return"etf";
    if(s.includes("framework")||s.includes("composite"))return"framework";
    return"market";
  }

  function render(){
    const rows=filtered();
    const host=document.getElementById("extremIndexGroups"); if(!host)return;
    const count=document.getElementById("extremIndexResultCount"); if(count)count.textContent=`${rows.length} gösterge`;
    if(!rows.length){
      host.innerHTML='<div class="extremEmpty">Filtreye uyan gösterge bulunamadı.</div>';
      return;
    }
    const cats=[...new Set(rows.map(x=>x.category))];
    host.innerHTML=cats.map(category=>{
      const catRows=rows.filter(x=>x.category===category);
      const subgroups=[...new Set(catRows.map(x=>x.subgroup||"").filter(Boolean))];
      const content=subgroups.length
        ? subgroups.map(sg=>renderGroup(catRows.filter(x=>x.subgroup===sg),sg)).join("")+
          (catRows.some(x=>!x.subgroup)?renderGroup(catRows.filter(x=>!x.subgroup),"Diğer"): "")
        : renderGroup(catRows,"");
      return `<section class="extremCategory">
        <div class="extremCategoryHead">
          <div><span class="extremCategoryEyebrow">EXTREM INDEX FAMILY</span><h4>${esc(category.toLocaleUpperCase("tr-TR"))}</h4></div>
          <span class="extremCategoryCount">${catRows.length} gösterge</span>
        </div>
        <div class="extremCategoryBody">${content}</div>
      </section>`;
    }).join("");
    bindActions(host);
  }

  function renderGroup(rows,subgroup){
    return `<div class="extremSubgroup">
      ${subgroup?`<div class="extremSubgroupTitle">${esc(subgroup.toLocaleUpperCase("tr-TR"))}</div>`:""}
      <div class="extremCardGrid">${rows.sort((a,b)=>a.priority-b.priority).map(x=>`
        <article class="extremItemCard">
          <div class="extremItemTop">
            <span class="extremPriority">#${x.priority}</span>
            <span class="extremSource ${sourceClass(x.source)}">${esc(x.source)}</span>
          </div>
          <h5>${esc(x.name)}</h5>
          <p>${esc(x.role)}</p>
          <div class="extremItemActions">
            <span class="extremCode">${esc(x.code)}</span>
            <button type="button" class="extremCopyBtn" data-copy="${esc(x.code)}">Kopyala</button>
            ${x.tvCode?`<button type="button" class="extremTvBtn" data-tv="${esc(x.tvCode)}">TV'de Aç</button>`:""}
          </div>
        </article>`).join("")}</div>
    </div>`;
  }

  function bindActions(host){
    host.querySelectorAll("[data-copy]").forEach(btn=>btn.addEventListener("click",async()=>{
      const value=btn.dataset.copy||"";
      try{
        await navigator.clipboard.writeText(value);
        const old=btn.textContent;btn.textContent="Kopyalandı";setTimeout(()=>btn.textContent=old,850);
      }catch{btn.textContent="Seç";}
    }));
    host.querySelectorAll("[data-tv]").forEach(btn=>btn.addEventListener("click",()=>{
      window.open(`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(btn.dataset.tv||"")}`,"_blank","noopener,noreferrer");
    }));
  }

  function init(){
    if(bound)return;bound=true;
    const categories=[...new Set(data.map(x=>x.category))];
    const select=document.getElementById("extremIndexCategory");
    if(select)select.innerHTML='<option value="all">Tüm Başlıklar</option>'+categories.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join("");
    const total=document.getElementById("extremIndexTotalCount");if(total)total.textContent=data.length;
    const cats=document.getElementById("extremIndexCategoryCount");if(cats)cats.textContent=categories.length;
    const sourceCount=document.getElementById("extremIndexSourceCount");if(sourceCount)sourceCount.textContent=new Set(data.map(x=>x.source)).size;
    document.getElementById("extremIndexSearch")?.addEventListener("input",render);
    document.getElementById("extremIndexCategory")?.addEventListener("change",render);
    document.getElementById("extremIndexReset")?.addEventListener("click",()=>{
      const q=document.getElementById("extremIndexSearch"),c=document.getElementById("extremIndexCategory");
      if(q)q.value="";if(c)c.value="all";render();
    });
  }

  window.renderLearningHubExtremIndexes=function(){init();render()};
})();
