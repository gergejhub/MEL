# MEL Ops Assistant (LIDO 4D)

Statikus (GitHub Pages kompatibilis) webapp, ami:
- beírt **MEL szám / kulcsszó / szövegrészlet** alapján azonnal megmondja a **LIDO 4D / ICAO FPL** teendőket (Excel-mátrix alapján),
- és képes **több limitáció** együttes összegzésére (kombinált korlátok).
- opcionálisan **betöltött MEL PDF-ben** is tud keresni **lokálisan a böngészőben** (a PDF nem kerül feltöltésre sehova).

## Gyors használat
1. Nyisd meg az `index.html`-t (vagy GitHub Pages-en).
2. (Ajánlott) kattints: **+ MEL PDF betöltése (lokálisan)** és válaszd ki a saját `MEL.pdf` fájlodat.
3. Írj be keresést (pl. `TCAS`, `CPDLC`, `22-82-01`, `RNP APCH`, `WX RADAR`).
4. A találatoknál: **+ Aktív** → bekerül a jobb oldali “Aktív limitációk” listába.
5. A jobb oldalon megkapod:
   - operációs korlátok,
   - ICAO FPL változások (Item 10a/10b/18),
   - LIDO 4D teendők,
   - egyéb feladatok.

## Megjegyzés (FL LIMIT)
A FL LIMIT jellegű korlátoknál a rendszer tud **minimális MAX FL**-t számolni, ha kézzel hozzáadod:
- `FL350` vagy `MAX FL 330` jellegű címkével.

## Adatforrás
- `data/mel_actions.json` az általad adott Excel (MEL sheet) alapján készült.
- A PDF kereséshez a program `pdf.js`-t használ CDN-ről.

## GitHub Pages
- Repo gyökerében van az `index.html` → Settings → Pages → Deploy from branch → `main` / root.

