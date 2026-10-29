## 1.2.0

- Go live in five areas (Hostwerk with SDK 3.11): the Hostwerk app is a section in Go live → Access (#/live/zugriff/app); older Hostwerk versions keep the tab. “Pair phone …” stays in the remote access card. Links and hints point to the new places (Access → Remote access, Monitoring → Alerts). / Livebetrieb in fünf Bereichen (Hostwerk mit SDK 3.11): Die Hostwerk-App ist ein Abschnitt unter Livebetrieb → Zugriff (#/live/zugriff/app); ältere Hostwerk-Versionen behalten den Reiter. „Handy koppeln …“ bleibt in der Fernzugriffs-Karte. Links und Hinweise zeigen auf die neuen Orte (Zugriff → Fernzugriff, Überwachung → Meldungen).

## 1.1.0

- Loading states show Hostwerk’s spinner next to the text (SDK 3.6) instead of text alone. / Ladezustände zeigen Hostwerks Kreisel neben dem Text (SDK 3.6) statt nur Text.

## 1.0.1

- New animated icon and banner in the common Hostwerk style (isometric block). / Neues animiertes Symbol und Banner im gemeinsamen Hostwerk-Stil (isometrischer Block).

## 1.0.0

- The phone app as its own extension (Hostwerk with SDK 3.4): before, the phone view `#/handy`, the web app manifest, the service worker and the page `/app-laden` were built into Hostwerk. Small screens still start in the phone view, old QR codes still work. / Die Handy-App als eigene Erweiterung: vorher waren Handy-Ansicht, Manifest, Service Worker und `/app-laden` in Hostwerk eingebaut. Schmale Bildschirme starten weiter in der Handy-Ansicht, alte QR-Codes funktionieren weiter.
- New: pair a phone with a one-time QR code (5 minutes, once) for your account or for a member – the phone stays signed in like an app. / Neu: Handy per Einmal-QR-Code koppeln (5 Minuten, einmal) – für dein Konto oder ein Mitglied; das Handy bleibt angemeldet wie eine App.
- New: paired devices with approval on the PC, blocking, expiry after 30 unused days and a security log. / Neu: gekoppelte Geräte mit Freigabe am PC, Sperren, Ablauf nach 30 unbenutzten Tagen und Sicherheitsprotokoll.
- Security: only fingerprints of device keys are stored, a new password invalidates all devices of the account, requests started by other websites never count, members' phones always wait for approval. / Sicherheit: nur Fingerabdrücke gespeichert, neues Passwort macht alle Geräte des Kontos ungültig, Anfragen fremder Webseiten zählen nie, Handys von Mitgliedern warten immer auf Freigabe.
