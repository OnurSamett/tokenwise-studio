// Side-effect module: import it FIRST so every later module sees the user's shell variables.
import { importShellEnv } from "./shellenv.js";
importShellEnv();
