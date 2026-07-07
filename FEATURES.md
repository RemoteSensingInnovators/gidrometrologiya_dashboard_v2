# Imkoniyatlar — batafsil

## 1. 2D geoxarita (`dashboard.js`)

- **Gaz bo'yicha noyob rang**: har bir gaz (SO₂, NO₂, NH₃, HF, NO, Fenol, CO, Cl₂, Chang) o'ziga xos rang tusiga (hue) ega. "O'rtacha" tanlanganda ochroq, "Maksimal" tanlanganda to'qroq soya ishlatiladi — hue gaz turiga, yorqinlik esa o'lchov turiga bog'liq.
- **Xarita ustidagi belgi (badge)**: joriy gaz va o'lchov nomini rang bilan mos holda doim ko'rsatib turadi, hatto xaritani tor kesib skrinshot qilinganda ham ko'rinadi.
- **Windy.com uslubidagi issiqlik maydoni**: fraktal shovqin (fractal noise) asosida generatsiya qilingan, tanlangan gazning intensivligiga qarab rangi o'zgaruvchi, sekin "oqib" turuvchi fon qatlami.
- **Shamol kompasi**: 8 yo'nalish bo'yicha o'rtacha tezlikni ko'rsatuvchi porlab turuvchi radial diagramma.
- **Shamol oqimi zarralari**: haqiqiy shamol vektoridan hisoblangan yo'nalish/tezlikda harakatlanuvchi, tanlangan gaz rangida porlovchi chiziqlar.

## 2. 3D shahar sahnasi (`map3d.js`)

### Render texnologiyasi
`three/webgpu` orqali import qilingan `THREE.WebGPURenderer` ishlatiladi. Brauzer WebGPU'ni qo'llab-quvvatlamasa (yoki tizimda mavjud bo'lmasa), renderer avtomatik ravishda WebGL2 backend'iga o'tadi — foydalanuvchi buni interfeysdagi "WebGPU" / "WebGL2 (zaxira)" belgisidan ko'rishi mumkin.

### Binolar
- `buildings.geojson`'dagi har bir bino konturi mahalliy metr koordinatalariga o'tkaziladi, `samarqand.json` rasmiy chegarasi ichida qolganlar filtrlanadi (chegaradan tashqaridagilar chiqarib tashlanadi).
- Juda ingichka (devor/panjara kabi) konturlar min-o'lcham filtri bilan olib tashlanadi.
- Har bir bino balandligi maydoniga qarab hisoblanadi, barcha binolar **bitta** `BufferGeometry`'ga birlashtiriladi (`mergeGeometries`) — bu minglab alohida chizish chaqiruvlari o'rniga bitta draw call bilan render qilishga imkon beradi.
- Rang har bir bino uchun eng yaqin monitoring stansiyasigacha bo'lgan masofa va tanlangan gaz intensivligi asosida hisoblanadi (vertex color orqali).

### Basemap (haqiqiy xarita kafelchalari)
OpenStreetMap kafelchalari CORS cheklovi tufayli to'g'ridan-to'g'ri WebGL teksturasi sifatida ishlatib bo'lmaydi. Buning yechimi sifatida `serve.py` o'zi **bir xil domendan (same-origin) kafelcha proksi** vazifasini bajaradi:

1. Brauzer `/osmtiles/{z}/{x}/{y}.png` so'raydi.
2. Server kafelchani OpenStreetMap'dan yuklab, diskka keshlaydi (`.tile_cache/`).
3. Agar server HTTPS sertifikat xatosiga duch kelsa (odatda antivirus/korporativ tarmoq tekshiruvi tufayli), avtomatik ravishda faqat shu kafelcha uchun sertifikatni tekshirmaydigan zaxira ulanishga o'tadi.
4. Barcha kafelchalar bitta katta canvas'ga birlashtiriladi va bitta tekstura sifatida 3D yer maydoniga qo'llaniladi (fon yuklanishi butun sahnani "to'xtatib qo'ymaydi" — orqa fonda progressiv yuklanadi).

### Shamol simulyatsiyasi
- Har bir zarracha o'zining so'nggi bir necha pozitsiyasini ("iz"/trail) saqlaydi va bu iz porlab turuvchi, dumidan boshigacha yorqinlashuvchi chiziq sifatida chiziladi.
- Zarralar oldinga "sezgi" (probe) yuboradi: agar yo'lida bino bo'lsa, qaysi tomon ochiqroq ekanini tekshirib, o'sha tomonga silliq buriladi (real shamol oqimiga o'xshash "aylanib o'tish" effekti).
- Katta, aniq ko'rinadigan o'q-belgi (hero arrow) shamol yo'nalishini doim ko'rsatib turadi.
- **Qo'lda kiritish**: foydalanuvchi tezlik (m/s) va yo'nalishni qo'lda kiritib, "Shamolni qo'llash" tugmasi orqali simulyatsiyani real ma'lumotlardan mustaqil boshqarishi mumkin ("Avtomatik" katagi orqali istalgan vaqtda ma'lumotlarga asoslangan rejimga qaytariladi).

### Kamera
`OrbitControls` orqali erkin aylanish/zoom, avtomatik sekin aylanish, va stansiyalar bo'ylab davriy "sayohat" (tur) — har safar yangi nuqtaga kelganda binolar balandligi qisqa "bounce" bilan tasdiqlanadi.

## 3. Ma'lumotlar quvuri (pipeline)

`build_data.py` — `2016.xlsx`...`2025.xlsx` (gaz ko'rsatkichlari) va `shamol.xlsx` (shamol guli) fayllarini o'qib, yagona `data/samarqand_data.json` formatiga birlashtiradi. Bu fayl o'zgarganda skriptni qayta ishga tushirish kifoya — frontend kodini o'zgartirish shart emas.
