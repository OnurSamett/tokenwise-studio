// Model catalog: friendly names, tiers and what each model is good at.
// source: "vendor description" = taken from the vendor's own text; "tokenwise default" = how tokenwise uses it.
const V = "vendor description", T = "tokenwise default";
const e = (agent, family, label, match, tier, goodAt, notes, source) => ({ agent, family, label, match, tier, goodAt, notes, source });

export const CATALOG = [
  e("codex", "luna", "Codex Luna", "luna", "fast", "easy, mechanical tasks", "OpenAI: fast and affordable model for easier tasks.", V),
  e("codex", "terra", "Codex Terra", "terra", "balanced", "straightforward coding, drafts, images", "Balanced Codex model; tokenwise uses it for images and simple edits.", T),
  e("codex", "sol", "Codex Sol", "sol", "balanced", "everyday coding (the workhorse)", "OpenAI: latest workhorse model for coding and everyday work.", V),
  e("codex", "astra", "Codex Astra", "astra", "frontier", "the hardest problems", "OpenAI: frontier intelligence for the most demanding work. Uses ChatGPT limits very fast.", V),

  e("claude", "haiku", "Claude Haiku", "haiku", "fast", "search, summaries, mechanical edits", "Fastest and cheapest Claude; tokenwise sends it reading-heavy work.", T),
  e("claude", "sonnet", "Claude Sonnet", "sonnet", "balanced", "implementing from a clear plan, tests", "Balanced Claude model for routine coding.", T),
  e("claude", "opus", "Claude Opus", "opus", "frontier", "architecture, hard bugs, reviews", "Deepest reasoning Claude; tokenwise keeps it for design, root causes and review.", T),

  // Gemini via Google Antigravity
  e("gemini", "hydrogen", "Gemini Hydrogen", "hydrogen", "balanced", "fast everyday work (default)", "Antigravity's fast default model.", T),
  e("gemini", "argon", "Gemini Argon", "argon", "frontier", "hard problems, second opinions", "Antigravity's frontier model.", T),
  e("gemini", "flash", "Gemini Flash", "flash", "fast", "quick, simple tasks", "Older fast Gemini model.", T),

  // NVIDIA build.nvidia.com free endpoints; `match` is tested against the model id
  e("free", "kimi-k2", "Kimi K2 (NVIDIA)", "kimi-k2", "balanced", "coding and agentic tasks", "Earlier Kimi generation; may not be on NVIDIA's free tier (the agent skips it if not).", T),
  e("free", "kimi-k3", "Kimi K3.1 Pro (NVIDIA)", "kimi-k3", "frontier", "agentic coding, 3D modeling, long context", "NVIDIA catalog: 3T-class open model with 1M-token context specialized for agentic coding, 3D modeling, and finance.", V),
  e("free", "mistral-large-4", "Mistral Large 4 (NVIDIA)", "mistral-large-4", "frontier", "reasoning, tool calling, structured output", "NVIDIA catalog: 1T-total / 52B-active MoE for text and image input with reasoning, function calling and structured outputs.", V),
  e("free", "deepseek-v4", "DeepSeek V4.1 Flash (NVIDIA)", "deepseek-v4", "balanced", "fast, low-cost general coding", "NVIDIA catalog: 552B MoE with 8B active parameters, native multimodal support and lower API cost.", V),
  e("free", "glm-5", "GLM 5.3 Flash (NVIDIA)", "glm-5", "balanced", "reasoning and tool calling", "NVIDIA catalog: multimodal 320B-total / 18B-active MoE with reasoning and tool calling.", V),
  e("free", "nemotron-3-ultra", "Nemotron 3 Ultra (NVIDIA)", "nemotron-3-ultra", "frontier", "agentic reasoning, planning, long context", "NVIDIA catalog: hybrid Mamba-Transformer MoE with 1M context, excelling in agentic reasoning, coding, planning and tool calling.", V),
  e("free", "step-5", "Step 5 Preview (NVIDIA)", "step-?5", "frontier", "long-context reasoning, tool calling", "NVIDIA catalog: ~600B-total / 27B-active multimodal MoE with 1M context, reasoning and tool calling.", V),
  e("free", "minimax-m3", "MiniMax M3.1 Flash (NVIDIA)", "minimax-m3", "balanced", "coding, agentic workflows", "NVIDIA catalog: native multimodal MoE for coding, agentic workflows, computer use and cybersecurity.", V),
  e("free", "laguna", "Laguna XS 2.1 (NVIDIA)", "laguna", "fast", "long-horizon agentic coding", "NVIDIA catalog: efficient 33B MoE for local, long-horizon agentic coding and terminal tasks.", V),
  e("free", "nemotron-3.5-lightning", "Nemotron 3.5 Lightning (NVIDIA)", "nemotron-3.5-lightning", "fast", "fast specialized agent tasks", "NVIDIA catalog: fastest 30B A3B MoE for specialized agentic tasks.", V),
  e("free", "gpt-oss", "GPT-OSS (open weights)", "gpt-oss", "balanced", "general coding on a budget", "OpenAI's open-weight model, hosted by free providers.", T),
];

/** Best matching catalog entry, or null. codex/claude/gemini: family equality; free: regex against the model id. */
export function describe(agent, modelIdOrFamily) {
  const id = String(modelIdOrFamily ?? "");
  if (!id) return null;
  if (agent === "free") {
    // Accept "provider:model" too; match against the model part.
    const model = id.includes(":") && /^(nvidia|openrouter|groq|mistral|custom):/.test(id) ? id.slice(id.indexOf(":") + 1) : id;
    return CATALOG.find((c) => c.agent === "free" && new RegExp(c.match, "i").test(model)) || null;
  }
  const fam = id.toLowerCase();
  return CATALOG.find((c) => c.agent === agent && c.family === fam) || null;
}
