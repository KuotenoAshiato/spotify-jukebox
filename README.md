# Spotify Smart Jukebox Server

Dieses Projekt ist das Backend und Frontend einer interaktiven, webbasierten Spotify-Jukebox. Es ermöglicht Nutzern (Hosts), einen virtuellen Raum zu eröffnen, dem Gäste beitreten können. Gäste können Songs suchen, zur Warteschlange hinzufügen und über Genres abstimmen. Der Host behält die volle Kontrolle über die aktuelle Wiedergabe, das Layout und die Datenbank-Konfigurationen.

## Features

- **Spotify-Integration:** Direkte Verbindung zur Spotify-API via OAuth zur Steuerung der Wiedergabe.
- **Echtzeit-Kommunikation:** Synchronisation aller Clients (Host, Guest, Jukebox-Display) über Socket.io.
- **Smart Queue & Voting:** Songs werden automatisch nach Genres gruppiert. Ein RTV-System (Rock the Vote) ermöglicht es Gästen, über den Wechsel von Genres abzustimmen.
- **Globale Datenbank:** Automatische Lernfunktion für Künstler und Genres über eine MongoDB-Datenbank, um zukünftige Vorschläge zu verbessern.
- **Display-Modus:** Eine anpassbare Fullscreen-Ansicht für Partys (mit QR-Code für Gäste, Warteschlange, etc.).

## Voraussetzungen

- [Node.js](https://nodejs.org/) (v16 oder höher empfohlen)
- Eine aktive Spotify Premium-Mitgliedschaft (für die API-Steuerung erforderlich)
- Eine registrierte App im [Spotify Developer Dashboard](https://developer.spotify.com/dashboard/)

## Installation

1. Repository klonen und Abhängigkeiten installieren:
   ```bash
   npm install
   ```
