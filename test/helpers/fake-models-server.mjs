// Fake OpenAI-style /v1/models server for doctor tests. Runs in its own process because the doctor
// check uses spawnSync, which blocks the parent's event loop.
// usage: node fake-models-server.mjs <comma-separated model ids> [required bearer key]
import http from "node:http";

const ids = (process.argv[2] || "").split(",").filter(Boolean);
const requiredKey = process.argv[3] || "";

const server = http.createServer((req, res) => {
  if (requiredKey && req.headers.authorization !== `Bearer ${requiredKey}`) {
    res.writeHead(401, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "unauthorized" }));
  }
  if (req.url !== "/v1/models") { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ object: "list", data: ids.map((id) => ({ id, object: "model" })) }));
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
