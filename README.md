# Tervezői jegyzetfüzet

Kézírásos projektjegyzet-füzet S Pennel, telepíthető webalkalmazásként (PWA). Internet nélkül is működik, a lapokat Google Drive-ra szinkronizálja.

## Funkciók

- **Eszközök** (a jobb oldali sávon):
  - toll: színkeverő, az előző 3 szín gyorsgombként, vastagság csúszkával
  - kiemelő
  - radír: egész vonalat vagy csak az alatta lévő részt törli; az S Pen oldalsó gombjával is radíroz
  - lasszó: mozgatás, másolás, törlés, átszínezés
- **Jelölők:**
  - jelölőnégyzet feladathoz: koppintásra kész, és a sor kihúzódik
  - „?” jelölő nyitott kérdéshez
- **Feladatok** gomb: a nyitott feladatok és kérdések listája lapszámmal, koppintásra a lapra ugrik.
- **Füzetek:** projektenként külön füzet.
- **A lapon:** a létrehozás dátuma jobb felül, az oldalszám alul középen.
- **Import:** PDF, PNG, JPEG (háttérként, rá lehet írni). **Export:** PDF (egy lap vagy az egész füzet).
- **Google Drive szinkron:** a „Tervezői jegyzetfüzet” mappába. Ebből dolgozik a napi összefoglaló.

## 1. Közzététel GitHub Pages-en

1. Hozz létre egy **nyilvános** tárolót, például `jegyzetfuzet` néven.
   - Csak a program kódja lesz nyilvános.
   - A jegyzeteid nem kerülnek ide: azok a tableten és a saját Drive-odon vannak.
2. Töltsd fel ennek a mappának a fájljait a tároló gyökerébe.
3. Állítsd be: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, ág: `main`, mappa: `/ (root)` → **Save**.
4. Pár perc múlva az app elérhető: `https://<felhasználónév>.github.io/jegyzetfuzet/`

## 2. Telepítés a tabletre

1. Nyisd meg a fenti címet **Chrome**-ban a tableten.
2. Válaszd: ⋮ menü → **Telepítés** / **Hozzáadás a kezdőképernyőhöz**.
3. Ezután saját ikonról indul, teljes képernyőn.

## 3. Google Drive szinkron beállítása (egyszer)

1. A [Google Cloud Console](https://console.cloud.google.com/)-ban hozz létre egy projektet (pl. „Jegyzetfüzet”).
2. Kapcsold be a **Google Drive API**-t: *APIs & Services → Library → Google Drive API → Enable*.
3. **Google Auth Platform:**
   - Regisztráld az appot (név, e-mail).
   - Az **Audience** résznél válaszd az *External* típust.
   - Add hozzá a saját Gmail-címedet **test user**-ként.
4. **Clients → Create client → Web application:**
   - **Authorized JavaScript origins:** `https://<felhasználónév>.github.io` (útvonal nélkül).
   - Redirect URI nem kell.
5. Másold ki a **Client ID**-t. A Client secret nem kell.
6. Az appban: ⋮ → **Beállítások és szinkron** → Client ID beillesztése → **Bejelentkezés és bekapcsolás**.

**Megjegyzések:**
- Teszt módban a Google 7 naponta újra engedélyt kér. Ilyenkor a jobb felső sarokban a „Drive: koppints a bejelentkezéshez” felirat jelenik meg.
- A bejelentkezés óránként lejár. Az app a következő eszköztár-koppintáskor frissíti: egy pillanatra megjelenhet egy Google-ablak.
- Az app csak a saját maga által létrehozott Drive-fájlokhoz fér hozzá (`drive.file` hatókör).

## Drive-mappa felépítése

```
Tervezői jegyzetfüzet/
├── index.json               füzetek, lapok, módosítási idők
├── nyitott.json             nyitott feladatok és kérdések (lapkép + kivágás %-ban)
├── Napi összefoglalók.md    a napi ütemezett összefoglaló ide írja (legfrissebb felül)
└── Lapok/
    ├── <Füzet> – 001.json   a lap vonalai időbélyeggel
    ├── <Füzet> – 001.jpg    a lap képe
    └── hatter-….jpg         importált PDF/kép háttér
```
