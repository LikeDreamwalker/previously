// Fake bridge: echoes the raw stdin payload JSON back, exit 0.
// Lets tests assert the exact wire contract (task/context/protocol fields).
// NOTE: the echoed payload has `protocol: 2` but no string `result`, so the
// kernel's protocol-2 parser must NOT treat it as an envelope.
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  data += chunk;
});
process.stdin.on("end", () => {
  process.stdout.write(data);
});
