// Fake bridge: echoes the PREVIOUSLY_BRAIN_AGENT it was spawned with, exit 0.
// Proves the bridge model pins the per-call agent in the child env.
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  data += chunk;
});
process.stdin.on("end", () => {
  process.stdout.write(`agent:${process.env.PREVIOUSLY_BRAIN_AGENT ?? "<unset>"}`);
});
