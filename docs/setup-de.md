# Erste Schritte mit tokenwise studio

**Sprache dieser Anleitung:** Deutsch. Ab Version 0.10.2 ist die Oberfläche auch auf Deutsch sowie auf Englisch, Türkisch, Spanisch und Französisch verfügbar.

## 1. Studio installieren

- **macOS:** Lade die [DMG der aktuellen Version](https://github.com/OnurSamett/tokenwise-studio/releases/latest/download/tokenwise-studio.dmg) herunter, öffne sie und ziehe die App nach **Applications**. Node.js ist enthalten. Zusätzlich brauchst du [Git](https://git-scm.com/downloads) sowie mindestens ein installiertes Anbieter-Tool, bei dem du angemeldet bist.
- **Windows (Beta):** Lade das [ZIP der aktuellen Version](https://github.com/OnurSamett/tokenwise-studio/releases/latest/download/tokenwise-studio-windows.zip) herunter, entpacke es **vollständig** in einen beschreibbaren Ordner und starte `TokenwiseStudio.exe`. Node.js und .NET sind enthalten; Git und mindestens ein Anbieter-Tool installierst du separat. Die Beta ist nicht signiert und wurde noch nicht auf echter Windows-Hardware getestet; SmartScreen kann eine Warnung anzeigen. Weitere Hinweise und Voraussetzungen stehen in der [README](../README.md#windows-beta).

Die Desktop-App und das Studio-Kommandozeilenwerkzeug werden unterschiedlich installiert. Wenn du die `tokenwise-studio`-Befehle aus dieser Anleitung verwenden möchtest, installiere die CLI wie in der [README](../README.md#macos-cli-installer) beschrieben. Die App allein stellt den Befehl im Terminal nicht unbedingt bereit.

## 2. Mindestens einen Anbieter installieren und verbinden

Gehostete Modelle laufen bei ihren jeweiligen Anbietern. Studio installiert Claude Code, Codex CLI und Antigravity **nicht automatisch** und lädt deren Modelle nicht herunter. Du musst nicht alle Anbieter einrichten; beginne mit einem.

- **Claude:** Installiere [Claude Code nach der offiziellen Anleitung](https://docs.anthropic.com/en/docs/claude-code/getting-started). Starte im Terminal `claude auth login` und melde dich mit deinem eigenen Konto an. Zugang und Limits hängen von deinem Anthropic-Tarif beziehungsweise deiner Konfiguration ab.
- **Codex:** Installiere [Codex CLI nach der offiziellen Anleitung](https://developers.openai.com/codex/cli/). Starte `codex login` und melde dich mit deinem Konto an. Die Verfügbarkeit hängt von deinem OpenAI-Tarif beziehungsweise deiner Konfiguration ab.
- **Gemini:** Installiere und öffne [Google Antigravity](https://antigravity.google/) und melde dich mit deinem Google-Konto an. Unter macOS kann Studio das in Gemini.app enthaltene `agy` erkennen. Für Worker wird außerdem Gemini CLI mit `GEMINI_API_KEY` unterstützt; siehe die [offizielle Gemini-CLI-Anleitung](https://github.com/google-gemini/gemini-cli). Konfiguration und verfügbare Funktionen hängen vom Anbieter und der Umgebung ab.

Die Anbieter-Tools speichern ihre Anmeldung mit ihren üblichen Mechanismen auf deinem Rechner. Gib Passwörter und Schlüssel nicht in einen Chat ein. Eine bereits vorhandene kompatible Anmeldung kann Studio erkennen.

## 3. Projekt öffnen

Öffne **tokenwise studio**, wähle einen Projektordner und beschreibe eine Aufgabe. Im Modellauswahlmenü und in den Team-Einstellungen kannst du aus den verfügbaren Optionen wählen. Auf dem Mac öffnet `⌘O` einen weiteren Ordner. Für Änderungsvorschläge der Worker über Worktrees benötigt das Projekt Git; prüfe Änderungen vor dem Anwenden.

Wenn du die Studio-CLI installiert hast, kannst du die erkannten Tools mit folgendem Befehl prüfen:

```sh
tokenwise-studio doctor
```

Der Befehl zeigt erkannte Tools und Einrichtungshinweise. Eine Anmeldung garantiert weder die Verfügbarkeit jedes Modells noch ein freies Nutzungskontingent. Falls ein Anbieter nicht erscheint, starte Studio nach Installation oder Anmeldung neu und prüfe die Dokumentation des Anbieters.

## 4. Optional: kostenlose oder lokale Modelle

- **NVIDIA und andere kostenlose Anbieter:** Erstelle deinen eigenen Schlüssel im [NVIDIA-Katalog](https://build.nvidia.com/) oder beim gewünschten Anbieter, konfiguriere ihn für die Umgebung von Studio und aktiviere kostenlose Modelle ausdrücklich in **Settings**. Verfügbarkeit und Limits können sich ändern. Übermittelte Inhalte unterliegen den Bedingungen des Anbieters; manche kostenlosen Angebote dürfen sie zum Training verwenden. Gib Schlüssel nicht in Chats oder Projekten weiter.
- **Lokales Ollama:** Installiere [Ollama](https://ollama.com/), starte den Dienst und lade das gewünschte lokale Modell herunter. Die README zeigt `ollama pull gpt-oss:20b`; für den lokalen Modus von Studio wird zusätzlich Codex CLI benötigt. Das Modell läuft auf deinem Rechner und benötigt genügend Ressourcen.

Weitere Optionen und die Unterschiede zwischen App und CLI stehen in der [Studio-README](../README.md) und auf der [Website](https://tokenwise.site/).
