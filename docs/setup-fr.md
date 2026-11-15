# Premiers pas avec tokenwise studio

**Langue de ce guide :** français. Depuis la version 0.10.2, l’interface est également disponible en français, ainsi qu’en anglais, turc, espagnol et allemand.

## 1. Installer Studio

- **macOS :** téléchargez le [DMG de la dernière version](https://github.com/OnurSamett/tokenwise-studio/releases/latest/download/tokenwise-studio.dmg), ouvrez-le et faites glisser l’application dans **Applications**. Node.js est inclus. Il vous faut aussi [Git](https://git-scm.com/downloads) et au moins un outil de fournisseur installé et connecté à votre compte.
- **Windows (bêta) :** téléchargez le [ZIP de la dernière version](https://github.com/OnurSamett/tokenwise-studio/releases/latest/download/tokenwise-studio-windows.zip), extrayez **tout** son contenu dans un dossier accessible en écriture, puis lancez `TokenwiseStudio.exe`. Node.js et .NET sont inclus ; installez Git et au moins un outil de fournisseur séparément. La version bêta n’est pas signée et n’a pas encore été testée sur une machine Windows réelle ; SmartScreen peut afficher un avertissement. Consultez les détails et les prérequis dans le [README](../README.md#windows-beta).

L’application de bureau et l’outil en ligne de commande de Studio s’installent séparément. Pour utiliser les commandes `tokenwise-studio` de ce guide, installez la CLI comme indiqué dans le [README](../README.md#macos-cli-installer). Télécharger l’application seule ne garantit pas que cette commande soit disponible dans votre terminal.

## 2. Installer et connecter au moins un fournisseur

Les modèles hébergés s’exécutent chez leurs fournisseurs. Studio **n’installe pas automatiquement** Claude Code, Codex CLI ou Antigravity et ne télécharge pas leurs modèles. Il n’est pas nécessaire de tous les installer : commencez par celui de votre choix.

- **Claude :** installez [Claude Code en suivant le guide officiel](https://docs.anthropic.com/en/docs/claude-code/getting-started). Dans un terminal, exécutez `claude auth login`, puis connectez-vous avec votre propre compte. L’accès et les limites dépendent de votre abonnement ou de votre configuration Anthropic.
- **Codex :** installez [Codex CLI en suivant le guide officiel](https://developers.openai.com/codex/cli/). Exécutez `codex login`, puis connectez-vous avec votre compte. La disponibilité dépend de votre abonnement ou de votre configuration OpenAI.
- **Gemini :** installez et ouvrez [Google Antigravity](https://antigravity.google/), puis connectez-vous avec votre compte Google. Sur macOS, Studio peut détecter l’exécutable `agy` fourni avec Gemini.app. Studio prend également en charge Gemini CLI avec `GEMINI_API_KEY` pour ses agents ; consultez le [guide officiel de Gemini CLI](https://github.com/google-gemini/gemini-cli). La configuration et les fonctions disponibles dépendent du fournisseur et de l’environnement.

Les outils des fournisseurs conservent la connexion sur votre ordinateur selon leurs mécanismes habituels. Ne partagez pas vos mots de passe ou vos clés dans une conversation. Studio peut détecter une session compatible déjà ouverte.

## 3. Ouvrir un projet

Ouvrez **tokenwise studio**, choisissez un dossier de projet et décrivez une tâche. Le sélecteur de modèle et les réglages d’équipe permettent de choisir parmi les options disponibles. Sur Mac, `⌘O` ouvre un autre dossier. Pour que les agents proposent des modifications au moyen de worktrees, le projet doit utiliser Git ; examinez les changements avant de les appliquer.

Si vous avez installé la CLI de Studio, vérifiez les outils détectés avec :

```sh
tokenwise-studio doctor
```

Cette commande indique les outils détectés et les étapes de configuration. Une connexion ne garantit ni la disponibilité de tous les modèles ni un quota suffisant. Si un fournisseur n’apparaît pas, redémarrez Studio après l’installation ou la connexion, puis consultez sa documentation.

## 4. Facultatif : modèles gratuits ou locaux

- **NVIDIA et autres fournisseurs gratuits :** créez votre propre clé dans le [catalogue NVIDIA](https://build.nvidia.com/) ou chez le fournisseur choisi, configurez-la dans l’environnement de Studio et activez explicitement les modèles gratuits dans **Settings**. La disponibilité et les limites peuvent changer. Les données envoyées sont traitées selon les conditions du fournisseur ; certaines offres gratuites peuvent les utiliser pour l’entraînement. Ne collez pas vos clés dans une conversation ou un projet.
- **Ollama local :** installez [Ollama](https://ollama.com/), démarrez le service et téléchargez le modèle local souhaité. Le README donne l’exemple `ollama pull gpt-oss:20b` ; le mode local de Studio nécessite aussi Codex CLI. Le modèle s’exécute sur votre machine, qui doit disposer de ressources suffisantes.

Pour les autres options et les différences entre l’application et la CLI, consultez le [README de Studio](../README.md) et le [site](https://tokenwise.site/).
