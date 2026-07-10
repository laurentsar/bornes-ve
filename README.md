# Bornes VE ⚡

Application **PWA + APK** (Capacitor) pour référencer tes **bornes de recharge VE**
à partir de la **base officielle du gouvernement** (IRVE consolidée Etalab / data.gouv.fr),
filtrer par **type de prise** et **fournisseur**, et **comparer tes prix**.

## Fonctions
- 🔎 **Recherche par commune** dans la base officielle IRVE (tabular-API data.gouv.fr, en direct).
- 📍 **Autour de moi** : géolocalisation (plugin Capacitor Geolocation / `navigator.geolocation`),
  bornes dans un rayon réglable (2–20 km), tri et affichage par distance.
- 🎛️ **Filtres** : types de prise (Type 2 / CCS Combo / CHAdeMO / Type E-F / Autre), **fournisseur** (opérateur), puissance mini.
- ⭐ **Mes bornes** : tu suis les stations que tu veux, enregistrées **hors ligne** (localStorage).
- 💶 **Mon prix** par borne (€/kWh, €/session, €/min ou gratuit) + note → tri par prix.
- 🔄 **Actualisation** : réinterroge la base officielle pour chaque borne suivie (date `maj` affichée).
- 🗺️ Ouverture de la borne dans Google Maps (coordonnées officielles).

## Prix — précision importante
Il **n'existe pas** de prix de recharge officiel du gouvernement en **temps réel**.
L'appli affiche la **tarification déclarée** par l'opérateur dans la base IRVE (souvent vide)
et te laisse **saisir ton propre prix** pour comparer tes bornes. Les emplacements, opérateurs,
puissances et types de prise, eux, viennent bien de la source officielle.

## Source de données
- Base nationale **IRVE consolidée** (schéma statique Etalab), ressource permanente
  `eb76d20a-8501-400e-b336-d85724de5435` via `https://tabular-api.data.gouv.fr`.
- Licence Ouverte / Etalab. CORS ouvert (`*`) → utilisable directement depuis l'app.

## Build
- **PWA** : servir le dossier `www/` en HTTPS.
- **APK** : build automatique via GitHub Actions (`.github/workflows/build-apk.yml`) à chaque
  push sur `master` → une **Release** GitHub avec l'APK signé (clé fixe partagée : MAJ sans désinstaller).
- Bump de version : `package.json`, `android/app/build.gradle` (`versionCode` + `versionName`),
  `www/index.html` (`window.APP_VERSION`), et le `CACHE` de `www/sw.js`.

## Structure
- `www/` — l'appli (index.html, app.js, styles.css, sw.js, manifest, update-check.js partagé).
- `android/` — projet Capacitor (signé `fluxrss.p12`, keystore partagé entre mes apps).
- `tools_gen_icon.py` — génère les icônes (éclair vert), PWA + launcher (`--android`).
