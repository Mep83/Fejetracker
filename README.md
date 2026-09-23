# FejeTracker PWA V1

Første testversion til iPhone.

## Funktioner
- Kortlæg cykelstier med GPS
- Gemmer cykelstier lokalt på telefonen
- Viser hele cykelstinettet
- Start / pause / stop fejning
- Rød = mangler, grøn = registreret fejet
- Dagens km og procent
- Slet forkert kortlagt strækning
- JSON-backup og gendannelse
- Ingen dagsruter

## Sådan får du den på iPhone
En PWA med GPS skal ligge på en HTTPS-adresse. Upload hele mappen til en statisk webhost
(fx GitHub Pages, Netlify eller Cloudflare Pages). Åbn derefter HTTPS-adressen i Safari på
iPhone og vælg Del > Føj til hjemmeskærm.

Safari spørger om adgang til placering. Vælg Tillad.

## Vigtigt ved V1-test
iOS kan begrænse GPS-opdateringer for webapps, når skærmen låses eller appen går i baggrunden.
Brug derfor V1 med FejeTracker åben og skærmen tændt under kortlægning/fejning.

Kortlaget kommer fra OpenStreetMap og kræver internet for nye kortfelter. Selve cykelstidata
gemmes lokalt.

GPS-tolerancen er 12 meter i app.js. Første praktiske test bør være en vej med cykelsti på
begge sider, hvor kun den ene side køres under fejning.
