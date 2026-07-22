# Portföy Takip Web

İnternete kurulabilir Node.js + Express web uygulaması.

## Özellikler

- Mevcut portföy ve model portföy arayüzü
- Yahoo Finance üzerinden gecikmeli fiyat ve günlük değişim
- 60 saniyede bir otomatik yenileme
- Manuel “Fiyatları Yenile” düğmesi
- BIST hisselerinde sembol otomatik olarak `.IS` ile tamamlanır
- Hisse, ETF, futures ve emtia sembolleri için manuel Yahoo Finance sembolü
- Veriler tarayıcının localStorage alanında saklanır

## Yahoo Finance sembol örnekleri

- THYAO: `THYAO.IS`
- ASELS: `ASELS.IS`
- Apple: `AAPL`
- S&P 500 ETF: `SPY`
- Altın vadeli: `GC=F`
- Brent vadeli: `BZ=F`
- EUR/USD: `EURUSD=X`

## Bilgisayarda çalıştırma

Node.js 20 veya üzeri gerekir.

```bash
npm install
npm start
```

Ardından:

```text
http://localhost:3000
```

## Render'a kurulum

1. Bu klasörü bir GitHub deposuna yükleyin.
2. Render hesabında **New > Blueprint** seçin.
3. GitHub deposunu bağlayın.
4. Render, `render.yaml` dosyasını okuyarak siteyi kurar.
5. Kurulum sonunda `https://...onrender.com` şeklinde bir adres oluşur.

## Önemli

Yahoo Finance bağlantısı resmî bir genel API değildir. Veri erişimi veya alan yapısı ileride değişebilir. Üretim ve müşteri kullanımı için lisanslı bir piyasa veri sağlayıcısı değerlendirilmelidir.

Portföy kayıtları sunucu veritabanında değil, her kullanıcının kendi tarayıcısında tutulur. Çok kullanıcılı hesap sistemi ve merkezi kayıt için sonraki aşamada veritabanı ve kullanıcı girişi eklenmelidir.


## Sürüm 2 geliştirmeleri

- Aktif pozisyonlarda güncel fiyat, güncel yüzdesel K/Z ve pozisyon büyüklüğü
- Genel Bakışta toplam açık pozisyon büyüklüğü
- Genel ve model portföy aktif pozisyonlarını düzenleme
- Markets sekmesi: endeks, BIST 100, S&P 500, ETF, emtia, kripto ve FX
- 24 saatlik mini trend grafikleri
- Üstte sabit BIST 100 kayan fiyat bandı
- Altta sabit emtia ve FX fiyat bandı
- Investing.com ekonomik takvim bileşeni
- Büyük listelerde parça parça veri çekme ve sunucu önbelleği

### Güncelleme

GitHub deposundaki `server.js` ve `public/index.html` dosyalarını bu paketteki dosyalarla değiştirin. Render otomatik deploy başlatır.


## Sürüm 3.0

- Aktif pozisyonlarda son güncellenen fiyat, veri saati ve anlık yüzdesel K/Z
- Aktif pozisyonlarda doğrudan Düzenle butonu
- Alış/açılış fiyatı, miktar, yön, tarih, stop, hedef ve Yahoo sembolü düzenleme
- Masaüstünde yatay kaydırmayı azaltan kompakt aktif pozisyon tablosu
- Üst BIST fiyat bandı yaklaşık %40 daha yavaş
- Markets altında All Assets, Favoriler, Indices, US Stocks, BIST, ETFs, Commodities, Crypto ve FX
- Market kartlarında yıldızla favorilere ekleme
- Favorilerin tarayıcıda kalıcı saklanması
- Yahoo Finance gecikmeli fiyatları ve mini trend grafikleri
- Investing.com ekonomik takvim bileşeni


## Sürüm 3.1 düzeltmesi

- Markets ve Calendar bölümleri Genel Bakış içinden çıkarılarak bağımsız ana sekmelere taşındı.
- Markets sekmesine girildiğinde veriler yeniden yükleniyor.
- All Assets, Favoriler, Indices, US Stocks, BIST, ETFs, Commodities, Crypto ve FX görünür hâle getirildi.
- Piyasa verisi alınamazsa boş sayfa yerine anlaşılır hata mesajı gösteriliyor.
- Investing.com ekonomik takvimine yüklenme durumu, yenileme butonu ve doğrudan erişim bağlantısı eklendi.


## Sürüm 3.2 kritik düzeltme

- Markets ve Calendar bölümleri HTML seviyesinde Genel Bakış bölümünün dışına kesin olarak taşındı.
- Sekme sırası: Genel Bakış → Markets → Calendar → Model Portföy.
- Markets tıklamasında içerik zorunlu olarak yeniden render edilir.
- Calendar tıklamasında Investing.com iframe'i yeniden etkinleştirilir.
- Sekme görünürlüğü için ek koruyucu CSS ve JavaScript eklendi.


## Sürüm 4

- Calendar sekmesinde yalnızca siyah temalı Investing.com Economic Calendar bulunur.
- Markets ve Calendar, Genel Bakış ve Model Portföy bölümlerinden tamamen ayrılmıştır.
- US Stocks bölümünde Yahoo Finance most-active taramasından en yüksek hacimli 100 ABD hissesi yüklenir.
- Market kartları, kayan bantlar ve aktif pozisyon sembolleri tıklanabilir.
- Sembole tıklandığında yukarıdan kayan güncel finansal bilgi paneli açılır.
- Panelde fiyat, günlük değişim, F/K, PD/DD, beta, FD/FAVÖK, nakit, borç, net kâr,
  öz sermaye, FAVÖK, temettü verimi, piyasa değeri, float, hacim ve 100 günlük tarihsel volatilite bulunur.
- Endeks ağırlığı ve endeks etkisi Yahoo Finance tarafından sağlanmadığında açıkça “mevcut değil” olarak gösterilir.
- Genel ve model portföy Hareket tabloları daha küçük yazı ve dar sütunlarla ekrana sığacak şekilde sıkıştırılmıştır.


## Sürüm 4.1 düzeltmeleri

- Sekme değiştirirken önceki sekmenin inline display değeri kapatılır; Calendar artık Markets altında kalmaz.
- Investing.com takvimi cross-origin kısıtına karşı CSS invert/hue filtresiyle zorunlu koyu ve okunabilir görünür.
- US Stocks başlığı sadeleştirildi.
- En aktif 100 ABD hissesi için üç aşamalı yedekleme eklendi:
  1. Yahoo Finance screener JSON
  2. Yahoo Finance most-active sayfası
  3. Uygulama içindeki 100 sembollük yedek liste
- Menkul kıymet detay paneli fiyat bilgilerini Yahoo chart API üzerinden mutlaka almaya çalışır.
- Temel veriler quoteSummary erişilebildiğinde eklenir; erişilemiyorsa fiyat ve tarihsel volatilite yine gösterilir.


## Sürüm 4.2

- Menkul kıymet detay paneli ürün türüne göre değişir.
- Hisselerde bilanço, değerleme, sermaye, float, borçluluk, marj, ROE ve ROA metrikleri gösterilir.
- Kaynakta olmayan bazı oranlar mevcut bilanço kalemlerinden otomatik hesaplanır.
- Futures ve emtialarda kontrat, vade, açık pozisyon, baz varlık, volatilite ve momentum gösterilir.
- FX paritelerinde baz/karşıt para, günlük aralık, hareketli ortalamalar ve trend uzaklıkları gösterilir.
- Kriptoda piyasa değeri, arz, hacim ve momentum gösterilir.
- Endekslerde hareketli ortalamalar, trend uzaklığı ve volatilite gösterilir.
- 20, 50 ve 200 günlük momentumlar günlük kapanışlardan otomatik hesaplanır.
- 50 ve 200 günlük ortalamalar ile 20/100 günlük volatilite otomatik hesaplanır.


## Sürüm 5.5

- Uygulama son sağlam tam sürüm üzerinden yeniden oluşturuldu.
- Portfolio, Model Portföy, Markets ve Calendar bölümleri geri getirildi.
- Sayfa açılışını ve sekme geçişlerini durduran JavaScript blok hatası giderildi.
- Eksik DOM elemanları ve boşa düşen JavaScript referansları temizlendi.
- Sol Dashboard menüsü ve açılır Markets alt menüsü yeniden entegre edildi.
- Sağ emir terminali güvenli biçimde mevcut Portfolio ve Model Portföy formlarına bağlandı.
- Günlük Değişim ve Vade alanları görünümden kaldırıldı; kayıt uyumluluğu korundu.
- Üst ve alt kayan fiyat bantları korundu.


## Sürüm 5.6

- Model Portföy üstündeki eski Pozisyon Ekle kartı kaldırıldı.
- Markets alt açıklama yazısı kaldırıldı.
- Markets sekme satırının sağına küresel sembol araması eklendi.
- Arama Yahoo Finance ürün araması ile TEFAS fon listesini birleştirir.
- Sonuçlar yalnızca yazılan harflerle başlayan sembolleri gösterir.
- Sonuca tıklamak ürün/fon detayını açar; + düğmesi ürünü açık Markets listesine ekler.
- Aynı canlı sembol araması Portfolio ve Model Portföy emir terminallerine eklendi.
- TEFAS 2026 JSON API gövdesi ve resultList alanlarıyla fon listesi entegrasyonu düzeltildi.


## Sürüm 6.0 — OpenBB Research Terminal

- Hisse ve diğer menkul kıymet kartlarına tıklandığında ekranın merkezini kaplayan tam araştırma penceresi açılır.
- Pencere; Özet, Temel Veriler, Finansal Tablolar, Analistler, Haberler ve Teknik Grafik bölümlerine ayrılmıştır.
- Temel veriler OpenBB REST API servisinden alınır.
- Gelir tablosu, bilanço ve nakit akışı beş yıllık tablo olarak gösterilir.
- Analist hedef fiyatları ve şirket haberleri ayrı bölümlerde sunulur.
- Sayfanın alt bölümünde dinamik TradingView Advanced Chart bulunur.
- BIST, ABD, kripto, FX ve temel vadeli kontratlar için TradingView sembol eşleştirmesi yapılır.
- Projeye `openbb-service` adlı ayrı Python servisi ve iki servisli Render blueprint eklendi.

### OpenBB yapılandırması

OpenBB verilerinin gelmesi için `portfolio-openbb` Render servisine seçilen veri sağlayıcının API anahtarı eklenmelidir.
Örnek sağlayıcı: FMP.

Node servisi için:

```text
OPENBB_BASE_URL=https://portfolio-openbb.onrender.com
OPENBB_PROVIDER=fmp
```

OpenBB servisi yapılandırılmasa bile TradingView teknik grafiği çalışır.


### Render deployment note

`portfolio-openbb` servisi deploy edildikten sonra oluşan tam HTTPS adresi,
Node servisindeki `OPENBB_BASE_URL` değişkenine elle girilmelidir.
`portfolio-openbb` servisine ayrıca kullanılacak sağlayıcının API anahtarı eklenmelidir.


## Sürüm 6.1

- OpenBB Render başlangıç komutu resmî `openbb-api` komutuna geçirildi.
- FMP sağlayıcı uzantısı açıkça requirements dosyasına eklendi.
- Render Blueprint ortam değişkenleri güvenli placeholder olarak düzenlendi.
