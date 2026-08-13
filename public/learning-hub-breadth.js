(function(){
  const d=window.LEARNING_HUB_BREADTH_ANALYSIS||{};
  const esc=v=>String(v??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));
  let bound=false;

  const arrowClass=v=>String(v||"").includes("↓")?"down":String(v||"").includes("↑")?"up":"flat";

  function table(headers,rows,classes=""){
    return `<div class="breadthTableWrap"><table class="breadthTable ${classes}">
      <thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join("")}</tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table></div>`;
  }

  function scoreBand(model,score){
    return (model.bands||[]).find(b=>score>=b.min&&score<=b.max)||{label:"-"};
  }

  function renderScoreLab(){
    const host=document.getElementById("breadthScoreLab"); if(!host)return;
    const blocks=[
      ["equity","Equity Breadth","10 sinyal"],
      ["commodity","Commodity Breadth","7 sinyal"],
      ["risk","Risk Appetite","8 sinyal"]
    ];
    host.innerHTML=blocks.map(([key,title,count])=>{
      const model=d.scoreModels[key];
      return `<section class="breadthScoreBox" data-score-key="${key}">
        <div class="breadthScoreHead">
          <div><span class="breadthMiniEyebrow">MANUAL SIGNAL LAB</span><h4>${esc(model.title)}</h4></div>
          <div class="breadthScoreValue"><strong data-score-value="${key}">0</strong><span>/ ${model.signals.length}</span></div>
        </div>
        <div class="breadthSignalChecks">
          ${model.signals.map((s,i)=>`<label><input type="checkbox" data-breadth-check="${key}" value="${i}"><span>${esc(s)}</span><b>+1</b></label>`).join("")}
        </div>
        <div class="breadthScoreRegime"><span>Rejim</span><strong data-score-regime="${key}">${esc(scoreBand(model,0).label)}</strong></div>
        <div class="breadthScoreBands">${model.bands.map(b=>`<span>${b.min}${b.max!==b.min?`–${b.max}`:""} · ${esc(b.label)}</span>`).join("")}</div>
      </section>`;
    }).join("");

    host.querySelectorAll("[data-breadth-check]").forEach(box=>box.addEventListener("change",updateScores));
    updateScores();
  }

  function updateScores(){
    ["equity","commodity","risk"].forEach(key=>{
      const model=d.scoreModels[key];
      const score=[...document.querySelectorAll(`[data-breadth-check="${key}"]`)].filter(x=>x.checked).length;
      const value=document.querySelector(`[data-score-value="${key}"]`);
      const regime=document.querySelector(`[data-score-regime="${key}"]`);
      if(value)value.textContent=score;
      if(regime)regime.textContent=scoreBand(model,score).label;
    });
    const eq=[...document.querySelectorAll('[data-breadth-check="equity"]')].filter(x=>x.checked).length;
    const co=[...document.querySelectorAll('[data-breadth-check="commodity"]')].filter(x=>x.checked).length;
    const ri=[...document.querySelectorAll('[data-breadth-check="risk"]')].filter(x=>x.checked).length;
    const eqPct=eq/10,coPct=co/7,riPct=ri/8;
    const composite=Math.round((eqPct*.45+riPct*.35+coPct*.20)*100);
    const result=document.getElementById("breadthCompositeScore");
    const label=document.getElementById("breadthCompositeRegime");
    if(result)result.textContent=composite;
    if(label){
      label.textContent=composite>=75?"Güçlü Risk-On":
        composite>=58?"Kontrollü Risk-On":
        composite>=42?"Nötr / Geçiş":
        composite>=25?"Risk Azalt":"Global Risk-Off";
    }
  }

  function build(){
    const root=document.getElementById("breadthAnalysisContent"); if(!root)return;

    const quickRows=d.quickRules.map(x=>`<tr>
      <td><strong>${esc(x.signal)}</strong></td>
      <td>${esc(x.meaning)}</td>
      <td><span class="breadthStatus ${x.grade}">${x.grade==="strong"?"Teyit":x.grade==="warn"?"Dikkat":"Risk"}</span></td>
    </tr>`);

    const coreRows=d.usCore.map(x=>`<tr><td>${x.priority}</td><td><strong>${esc(x.index)}</strong></td><td><code>${esc(x.code)}</code></td><td>${esc(x.role)}</td></tr>`);

    const matrixRows=d.usMatrix.map(x=>`<tr>
      <td><strong>${esc(x.state)}</strong></td>
      ${["SPX","NDX","RUT","MID","RUA"].map(k=>`<td class="breadthArrow ${arrowClass(x[k])}">${esc(x[k])}</td>`).join("")}
      <td>${esc(x.comment)}</td>
    </tr>`);

    const ratioCards=d.criticalRatios.map((x,i)=>`<article class="breadthRatioCard">
      <div class="breadthRatioTop"><span>#${i+1}</span><b class="${x.priority==="Critical"?"critical":""}">${esc(x.priority)}</b></div>
      <h4>${esc(x.ratio)}</h4><p>${esc(x.meaning)}</p>
      <div class="breadthRatioDirection up"><strong>↑ Yükselirse</strong><span>${esc(x.up)}</span></div>
      <div class="breadthRatioDirection down"><strong>↓ Düşerse</strong><span>${esc(x.down)}</span></div>
    </article>`).join("");

    const internalCards=d.internals.map((x,i)=>`<article class="breadthInternalCard">
      <div class="breadthInternalTop"><span>${i+1}</span><b>${esc(x.use)}</b></div>
      <h4>${esc(x.name)} <code>${esc(x.code)}</code></h4>
      <p>${esc(x.what)}</p>
      <div><strong class="green">Boğa teyidi</strong><span>${esc(x.bull)}</span></div>
      <div><strong class="red">Risk sinyali</strong><span>${esc(x.bear)}</span></div>
    </article>`).join("");

    const globalRows=d.globalMatrix.map(x=>`<tr>
      <td><strong>${esc(x.scenario)}</strong></td><td>${esc(x.us)}</td><td>${esc(x.europe)}</td><td>${esc(x.japan)}</td>
      <td>${esc(x.china)}</td><td>${esc(x.india)}</td><td>${esc(x.commodity)}</td><td>${esc(x.comment)}</td>
    </tr>`);

    const eqComRows=d.equityCommodity.map(x=>`<tr><td><strong>${esc(x.state)}</strong></td><td>${esc(x.equity)}</td><td>${esc(x.commodity)}</td><td><span class="breadthRegimeTag">${esc(x.regime)}</span></td></tr>`);

    const commodityRows=d.commoditySet.map(x=>`<tr><td><strong>${esc(x.commodity)}</strong></td><td><code>${esc(x.code)}</code></td><td>${esc(x.macro)}</td><td>${esc(x.breadth)}</td></tr>`);

    const dashRows=d.dashboard.map(x=>`<tr><td><strong>${esc(x.block)}</strong></td><td><code>${esc(x.tickers)}</code></td><td>${esc(x.purpose)}</td></tr>`);

    root.innerHTML=`
      <section class="breadthIntro breadthAnchor" id="breadthPrimer">
        <div class="breadthIntroText">
          <span class="learningEyebrow">MARKET INTERNALS · CROSS-ASSET CONFIRMATION · REGIME ANALYSIS</span>
          <h3>${esc(d.overview.title)}</h3>
          <p>${esc(d.overview.definition)}</p>
          <div class="breadthPrinciples">${d.overview.principles.map(x=>`<div><span>✓</span><p>${esc(x)}</p></div>`).join("")}</div>
        </div>
        <div class="breadthComposite">
          <span>MANUAL COMPOSITE</span><strong id="breadthCompositeScore">0</strong><small>/ 100</small>
          <b id="breadthCompositeRegime">Global Risk-Off</b>
          <p>Equity %45 · Risk Appetite %35 · Commodity %20</p>
        </div>
      </section>

      <nav class="breadthLocalNav">
        ${[
          ["breadthPrimer","Okuma Sırası"],["breadthUS","ABD Breadth"],["breadthRatios","Kritik Oranlar"],
          ["breadthInternals","Market Internals"],["breadthGlobal","Global Matrix"],["breadthCommodity","Equity + Commodity"],
          ["breadthScores","Score Lab"],["breadthDashboard","Nihai Dashboard"]
        ].map(x=>`<button type="button" data-breadth-jump="${x[0]}">${x[1]}</button>`).join("")}
      </nav>

      <section class="breadthSection">
        <div class="breadthSectionHead">
          <div><span>01 · PROFESSIONAL WORKFLOW</span><h3>Breadth Nasıl Okunur?</h3></div>
          <p>En faydalı kullanım sırası: fiyat → katılım → liderlik → kredi → global → emtia → volatility/rates.</p>
        </div>
        <div class="breadthReadingGrid">${d.readingOrder.map(x=>`<article><strong>${x.n}</strong><div><h4>${esc(x.title)}</h4><p>${esc(x.text)}</p></div></article>`).join("")}</div>
        <div class="breadthSubTitle"><h4>Hızlı Breadth Kuralları</h4><span>Excel notlarının geliştirilmiş hali</span></div>
        ${table(["Sinyal","Profesyonel Yorum","Durum"],quickRows,"quick")}
      </section>

      <section class="breadthSection breadthAnchor" id="breadthUS">
        <div class="breadthSectionHead">
          <div><span>02 · U.S. CORE BREADTH</span><h3>ABD Endeks Breadth Analizi</h3></div>
          <p>SPX'in altında piyasa gerçekten ne yapıyor? Small-cap, mid-cap, total market ve mega-cap ayrışmasını birlikte oku.</p>
        </div>
        <div class="breadthSubTitle"><h4>Kurumsal Takip İçin En Kritik ABD Endeksleri</h4><span>Önem sırasına göre</span></div>
        ${table(["Öncelik","Endeks","Kod","Rolü"],coreRows)}
        <div class="breadthSubTitle"><h4>Ana Risk-On / Risk-Off Matrisi</h4><span>Headline index yerine segment yapısını oku</span></div>
        ${table(["Durum","SPX","NDX","RUT","MID","RUA","Yorum"],matrixRows,"matrix")}
      </section>

      <section class="breadthSection breadthAnchor" id="breadthRatios">
        <div class="breadthSectionHead">
          <div><span>03 · RELATIVE STRENGTH</span><h3>En Kritik Breadth Oranları</h3></div>
          <p>Oranlar, mutlak endeks seviyesinden daha hızlı biçimde liderlik değişimini ve risk rotasyonunu gösterir.</p>
        </div>
        <div class="breadthRatioGrid">${ratioCards}</div>
      </section>

      <section class="breadthSection breadthAnchor" id="breadthInternals">
        <div class="breadthSectionHead">
          <div><span>04 · INTERNAL PARTICIPATION</span><h3>Market Internals — Eksik Olmaması Gereken Breadth Seti</h3></div>
          <p>Excel setine eklediğim en önemli iç piyasa göstergeleri. Bunlar fiyat rallisinin kaç hisse ve ne kadar hacim tarafından desteklendiğini ölçer.</p>
        </div>
        <div class="breadthInternalGrid">${internalCards}</div>
        <div class="breadthDivergenceBox">
          <h4>Profesyonel Divergence Okuma</h4>
          <div><strong>1.</strong><span>SPX yeni zirve + NYAD yeni zirve → <b>teyit</b>.</span></div>
          <div><strong>2.</strong><span>SPX yeni zirve + NYAD / %200DMA lower high → <b>negatif divergence</b>.</span></div>
          <div><strong>3.</strong><span>SPX düşüyor fakat New Lows azalıyor + A/D iyileşiyor → <b>pozitif internal divergence</b>.</span></div>
          <div><strong>4.</strong><span>Divergence tek başına işlem tetikleyicisi değildir; fiyat trend kırılımı, credit veya volatility teyidi beklenir.</span></div>
        </div>
      </section>

      <section class="breadthSection breadthAnchor" id="breadthGlobal">
        <div class="breadthSectionHead">
          <div><span>05 · GLOBAL CONFIRMATION</span><h3>Global Breadth Okuma Tablosu</h3></div>
          <p>ABD hareketi dünyanın geri kalanı tarafından destekleniyor mu? Gerçek global risk-on ile ABD-only leadership'i ayır.</p>
        </div>
        ${table(["Senaryo","ABD","Avrupa","Japonya","Çin/HK","Hindistan","Emtia","Yorum"],globalRows,"globalMatrix")}
      </section>

      <section class="breadthSection breadthAnchor" id="breadthCommodity">
        <div class="breadthSectionHead">
          <div><span>06 · REAL ECONOMY CONFIRMATION</span><h3>Equity + Commodity Breadth Matrisi</h3></div>
          <p>Hisse breadth'i reel talep emtialarıyla teyit edildiğinde makro rejim sinyali çok daha güçlü hale gelir.</p>
        </div>
        ${table(["Durum","Endeks Yorumu","Emtia Yorumu","Makro Rejim"],eqComRows,"eqCommodity")}
        <div class="breadthSubTitle"><h4>Emtia Dahil Global Breadth — Ana Emtia Seti</h4><span>Growth, inflation ve safe-haven ayrımı</span></div>
        ${table(["Emtia","Kod","Makro Anlamı","Breadth Kullanımı"],commodityRows)}
      </section>

      <section class="breadthSection breadthAnchor" id="breadthScores">
        <div class="breadthSectionHead">
          <div><span>07 · SIGNAL SYSTEM</span><h3>Breadth Sinyal Sistemi</h3></div>
          <p>Excel'deki puanlama sistemini etkileşimli hale getirdim. Güncel gözlemini işaretle; rejim sınıflaması otomatik hesaplansın.</p>
        </div>
        <div id="breadthScoreLab" class="breadthScoreGrid"></div>
        <div class="breadthScoreMethod">
          <strong>Neden ağırlıklar %45 / %35 / %20?</strong>
          <p>Equity breadth ana rejim motorudur; risk appetite kredi/FX/volatility teyidini verir; commodity breadth ise büyüme ve enflasyonun fiziksel teyididir. Bu ağırlıklar eğitim amaçlı bir regime filter'dır, otomatik al/sat sistemi değildir.</p>
        </div>
      </section>

      <section class="breadthSection breadthAnchor" id="breadthDashboard">
        <div class="breadthSectionHead">
          <div><span>08 · FINAL COCKPIT</span><h3>Nihai Global Macro Breadth Dashboard</h3></div>
          <p>Tek ekranda izlemen gereken bloklar. TradingView watchlist veya cockpit ekranını bu sırayla kurabilirsin.</p>
        </div>
        ${table(["Blok","Tickerlar / Oranlar","Ne İçin?"],dashRows,"dashboard")}
        <div class="breadthSubTitle"><h4>En Sık Yapılan Hatalar</h4><span>Breadth'in yanlış kullanımını engelle</span></div>
        <div class="breadthMistakeGrid">${d.mistakes.map((x,i)=>`<article><span>${i+1}</span><div><h4>${esc(x.title)}</h4><p>${esc(x.text)}</p></div></article>`).join("")}</div>
      </section>
    `;

    renderScoreLab();

    root.querySelectorAll("[data-breadth-jump]").forEach(btn=>btn.addEventListener("click",()=>{
      document.getElementById(btn.dataset.breadthJump)?.scrollIntoView({behavior:"smooth",block:"start"});
    }));
  }

  window.renderLearningHubBreadthAnalysis=function(){
    if(bound)return;
    bound=true;
    build();
  };
})();
