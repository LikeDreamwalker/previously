// Fake bridge (protocol 2 + deltas): streams only PART of the answer as live
// deltas (a dropped tail, as throttling/loss can cause) — the envelope result
// carries the full text and must win (the remainder is appended).
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  data += chunk;
});
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ delta: "Hello, " }) + "\n");
  process.stdout.write(
    JSON.stringify({ protocol: 2, result: "Hello, world!", events: [] }) + "\n",
  );
});
