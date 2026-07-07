# Samarqand Geoportali — Atmosfera Havosi Ifloslanish Dashboardi

Samarqand shahri uchun 2016–2025 yillar bo'yicha havo ifloslanish ko'rsatkichlarini interaktiv 2D xarita, grafiklar va **haqiqiy 3D shahar sahnasi** orqali vizuallashtiruvchi statik web dashboard.

## Ishga tushirish

> ⚠️ Har doim `serve.py` orqali ishga tushiring, oddiy `python -m http.server` orqali **emas** — 3D xaritadagi OpenStreetMap kafelchalari shu server orqali (CORS'siz) proksi qilinadi.

```bash
python serve.py
```

Brauzeringizda **http://localhost:8000** manzilini oching.

Kirish (login): `admin` / `admin1234`

## Asosiy imkoniyatlar

### 2D geoxarita
- Samarqand shahar chegarasi tanlangan **gaz turi va yil/oy o'lchoviga** (o'rtacha/maksimal) qarab rangi o'zgaradi.
- **Windy.com uslubidagi** oqib turuvchi rangli gradient fon (shamol tezligi ma'lumotlariga asoslangan).
- Animatsion shamol kompasi va oqim zarralari (real shamol gulidan hisoblangan yo'nalish/tezlik).
- Oylik trend, gazlar bo'yicha tahlil va shamol yo'nalishlari grafiklari (Chart.js).

### 3D shahar sahnasi (WebGPU)
- **Three.js `WebGPURenderer`** orqali render qilinadi — WebGPU mavjud bo'lmasa avtomatik WebGL2'ga o'tadi.
- `buildings.geojson`'dan ~45 000 tagacha bino ekstruziya qilinadi, Samarqand rasmiy chegarasi bo'yicha kesiladi.
- Bino balandligi/rangi tanlangan gaz va stansiyalarga yaqinlikka bog'liq.
- Haqiqiy OpenStreetMap kafelchalari 3D sahna ostiga tekstura sifatida joylashtiriladi (`serve.py` orqali proksi qilingan holda).
- Real fizikaga yaqin shamol oqimi: zarralar binolarga "urilganda" atrofidan aylanib o'tadi yoki yo'qoladi.
- Qo'lda shamol tezligi/yo'nalishini kiritish imkoniyati.
- Avtomatik kamera sayohati (stansiyalar bo'ylab) va aylanish animatsiyasi.

## Fayl tuzilishi

| Fayl/Papka | Vazifasi |
|---|---|
| `index.html`, `login.html` | Sahifalar |
| `style.css` | Dizayn |
| `dashboard.js` | 2D xarita, grafiklar, jadval, shamol animatsiyasi |
| `map3d.js` | 3D WebGPU shahar sahnasi (ES module) |
| `serve.py` | Lokal server + OSM kafelcha proksi (kesh bilan) |
| `data/samarqand_data.json` | 2016–2025 gaz va shamol ma'lumotlari (Excel'dan generatsiyalangan) |
| `data/stations.geojson` | Monitoring stansiyalari joylashuvi |
| `samarqand.json` | Shahar chegarasi geometriyasi |
| `buildings.geojson` | OSM bino konturlari (3D sahna uchun) |
| `build_data.py` | Excel fayllarni qayta JSON'ga aylantirish skripti |
| `*.xlsx` | Manba ma'lumotlar (yillik gaz ko'rsatkichlari, shamol guli) |

Batafsil imkoniyatlar tavsifi uchun [`FEATURES.md`](FEATURES.md) ga qarang.

## Texnologiyalar

Vanilla JavaScript, [Leaflet.js](https://leafletjs.com/) (2D xarita), [Chart.js](https://www.chartjs.org/) (grafiklar), [Three.js](https://threejs.org/) `WebGPURenderer` (3D sahna), Python standart kutubxonasi (lokal server).

## Ma'lum cheklovlar

- Kirish tizimi (`login.html`) faqat `sessionStorage` asosida — bu haqiqiy autentifikatsiya emas, faqat oddiy to'siq.
- Agar tarmog'ingizda antivirus/korporativ HTTPS tekshiruvi bo'lsa, `serve.py` buni avtomatik aniqlab, faqat xarita kafelchalarini yuklash uchun zaxira (fallback) ulanishga o'tadi.
