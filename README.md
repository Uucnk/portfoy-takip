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
