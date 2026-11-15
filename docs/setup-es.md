# Primeros pasos con tokenwise studio

**Idioma de esta guía:** español. La interfaz de Studio está disponible en inglés y turco; esta traducción de la guía no añade español a la aplicación.

## 1. Instala Studio

- **macOS:** descarga el [archivo DMG de la última versión](https://github.com/OnurSamett/tokenwise-studio/releases/latest/download/tokenwise-studio.dmg), ábrelo y arrastra la aplicación a **Applications**. Incluye Node.js; también necesitas [Git](https://git-scm.com/downloads) y al menos una herramienta de proveedor instalada y con sesión iniciada.
- **Windows (beta):** descarga el [ZIP de la última versión](https://github.com/OnurSamett/tokenwise-studio/releases/latest/download/tokenwise-studio-windows.zip), extrae **todo** su contenido en una carpeta con permisos de escritura y ejecuta `TokenwiseStudio.exe`. El paquete incluye Node.js y .NET. Instala Git y al menos una herramienta de proveedor por separado. La versión beta no está firmada ni se ha probado en hardware Windows real; puede aparecer una advertencia de SmartScreen. Consulta los detalles y requisitos en el [README](../README.md#windows-beta).

La aplicación de escritorio y la herramienta de terminal de Studio son formas distintas de instalación. Para usar los comandos `tokenwise-studio` de esta guía, instala la versión CLI siguiendo el [README](../README.md#macos-cli-installer); la descarga de la app por sí sola no garantiza que el comando esté disponible en tu terminal.

## 2. Instala y conecta al menos un proveedor

Los modelos alojados se ejecutan en los servicios de sus proveedores: Studio **no instala automáticamente** Claude Code, Codex CLI ni Antigravity, y no descarga sus modelos. No tienes que instalar todos; empieza con el que quieras usar.

- **Claude:** instala [Claude Code siguiendo la guía oficial](https://docs.anthropic.com/en/docs/claude-code/getting-started). En una terminal, ejecuta `claude auth login` y completa el inicio de sesión con tu propia cuenta. El acceso y los límites dependen de tu plan o configuración de Anthropic.
- **Codex:** instala [Codex CLI siguiendo la guía oficial](https://developers.openai.com/codex/cli/). Ejecuta `codex login` y completa el acceso con tu cuenta. La disponibilidad depende de tu plan o configuración de OpenAI.
- **Gemini:** instala y abre [Google Antigravity](https://antigravity.google/) e inicia sesión con tu cuenta de Google. En macOS, Studio puede detectar el ejecutable `agy` incluido con Gemini.app. También admite Gemini CLI con `GEMINI_API_KEY` para sus trabajadores; consulta la [guía oficial de Gemini CLI](https://github.com/google-gemini/gemini-cli). La configuración y las funciones disponibles dependen del proveedor y del entorno.

La sesión del proveedor se guarda en tu ordenador con sus herramientas habituales; no compartas contraseñas ni claves en un chat. Si ya tenías una sesión compatible, Studio puede detectarla.

## 3. Abre un proyecto

Abre **tokenwise studio**, elige una carpeta de proyecto y escribe una tarea. En el selector de modelo y en los ajustes del equipo puedes elegir entre las opciones disponibles. En macOS, `⌘O` abre otra carpeta. Para que los trabajadores puedan proponer cambios mediante worktrees, el proyecto necesita Git; revisa los cambios antes de aplicarlos.

Si instalaste la CLI de Studio, puedes comprobar las herramientas detectadas con:

```sh
tokenwise-studio doctor
```

El comando informa de las herramientas detectadas y los pasos de configuración; una cuenta conectada no garantiza que todos los modelos estén disponibles ni que haya cuota. Si un proveedor no aparece, reinicia Studio después de instalarlo o iniciar sesión y consulta la documentación del proveedor.

## 4. Opcional: modelos gratuitos o locales

- **NVIDIA y otros proveedores gratuitos:** crea tu propia clave en el [catálogo NVIDIA](https://build.nvidia.com/) o en el proveedor elegido, configúrala para el entorno de Studio y habilita explícitamente los modelos gratuitos en **Settings**. La disponibilidad y los límites pueden cambiar. El contenido enviado se procesa según las condiciones del proveedor; algunos planes gratuitos pueden usarlo para entrenamiento. No pegues claves en conversaciones ni proyectos.
- **Ollama local:** instala [Ollama](https://ollama.com/), inicia su servicio y descarga el modelo local que quieras usar. El README muestra `ollama pull gpt-oss:20b`; también se necesita Codex CLI para el modo local de Studio. El modelo se ejecuta en tu equipo y requiere recursos suficientes.

Para más opciones y diferencias entre la app y la CLI, consulta el [README de Studio](../README.md) y la [guía del sitio](https://tokenwise.site/).
