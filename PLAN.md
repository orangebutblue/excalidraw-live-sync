# Offene Schritte

1. Den Fork in beide Vaults installieren: `npm run build`, dann `npm run install-plugin -- "<Vault-Pfad>"` für den Laptop-Vault und für den Smartboard-Vault. Obsidian in beiden Fenstern neu laden.
2. Im echten Obsidian prüfen: Laptop hostet, Smartboard tritt über `127.0.0.1` bei. Fadenkreuz-Knopf → Smartboard springt einmal auf den Ausschnitt. Cast-Knopf ein → Schieben, Mausrad-Zoom, Pinch und „Zoom to fit“ am Laptop werden am Smartboard mitgemacht. Am Smartboard zeichnen → Elemente kommen am Laptop an. Cast-Knopf am Smartboard ein → Laptop folgt, Laptop führt nicht mehr. Sitzung beenden → nichts folgt mehr.
3. Falls Excalidraw den Ausschnitt per `updateScene({ appState })` nicht übernimmt: Ausschnitt in `src/session.ts` (`applyView`) stattdessen über die Excalidraw-Ansicht setzen.
