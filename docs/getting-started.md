# Getting started with tokenwise studio

[Türkçe başlangıç rehberi](baslangic.md) · [Back to README](../README.md)

Studio is the local application that coordinates coding agents. It does **not** install Claude Code, Codex CLI or Antigravity, download their cloud models, or sign in to your provider accounts. Install the agents you want separately; you do not need every provider. Availability and limits depend on each provider and account.

## 1. Install studio and open a project

1. On macOS, [download the Mac app](https://github.com/OnurSamett/tokenwise-studio/releases/latest/download/tokenwise-studio.dmg), open the DMG and drag the app into Applications. The app includes its Node.js runtime. Install [Git](https://git-scm.com/install/) separately if needed.
2. Open tokenwise studio and choose a project folder. A Git repository is needed for writing workers and their isolated worktrees; the app can explain setup for a non-Git folder.
3. Windows has a [desktop beta](https://github.com/OnurSamett/tokenwise-studio/releases/latest/download/tokenwise-studio-windows.zip). See the [Windows install notes](../README.md#windows-beta), including limitations and prerequisites.

Already signed in to a supported CLI on this computer? Studio can use that existing login. Otherwise choose one or more providers below.

## 2. Install and sign in to an agent

- **Claude:** Install [Claude Code](https://code.claude.com/docs/en/setup), then run `claude auth login` in Terminal and follow its prompts. A Claude desktop login alone does not guarantee that Claude Code is installed or signed in.
- **Codex:** Install [Codex CLI](https://github.com/openai/codex#quickstart), then run `codex login` and choose your account sign-in method. Installing the Codex desktop app alone does not guarantee that its CLI is installed or signed in.
- **Gemini:** Install [Google Antigravity](https://antigravity.google/download) and sign in to it. Studio looks for its `agy` CLI; if your installation does not put `agy` on PATH, follow the provider's CLI setup instructions. For Gemini orchestration, enable the relevant Antigravity option in Studio Settings. Studio may register its MCP server with Antigravity; review the settings before changing them.

Follow each provider's documentation for supported platforms, accounts and plan requirements. A provider can appear unavailable when its CLI is missing, not on the app's PATH, signed out or over quota; restart Studio after setup and check its status indicators. Sign in directly with the provider, never by pasting passwords or verification codes into a chat.

If you installed the **standalone Studio CLI**, this command checks installed tools and sign-in status:

```sh
tokenwise-studio doctor
```

The bundled desktop app does not necessarily install that command on your system PATH. Its welcome view also shows provider status. A configured NVIDIA key is not a guarantee that a model will answer.

## 3. Optional: free or local models

- **NVIDIA hosted models:** Create an API key in the [NVIDIA API Catalog](https://docs.api.nvidia.com/nim/docs/api-quickstart), make it available to Studio as `NVIDIA_API_KEY`, and enable free models in Settings. Provider trial limits and model availability can change. Requests and project content sent to the provider are subject to its terms. Do not paste a key into a chat, commit it to a repository, or share it in screenshots.
- **Local Ollama:** Install and start [Ollama](https://docs.ollama.com/quickstart), install Codex CLI, and download the configured local model (the default is `gpt-oss:20b`, for example `ollama pull gpt-oss:20b`). Local inference uses your computer's resources; model size and hardware requirements vary.

## 4. Run your first task

Choose a ready orchestrator or team in the composer, ask for a small task and inspect the result. Writing jobs run in isolated Git worktrees. Use the review panel to inspect proposed changes before you apply them; a provider still needs to be available for the selected task. See [How it works](../README.md#how-it-works) for details.

## If a provider is not ready

1. Confirm its CLI is installed, signed in and available to your user account. Restart Studio after changing installation, PATH or environment variables.
2. If using the standalone CLI, run `tokenwise-studio doctor` from Terminal. If using only the app, look at the welcome status indicators and the provider's own sign-in command.
3. Check the provider's account and quota. API access, model availability and plan access are separate; trying all providers is not required to start.
4. For free models, confirm the key and opt-in are configured; a model listed by a provider may still be unavailable or fail to respond. For Ollama, check the service is running and the configured model has been downloaded.
