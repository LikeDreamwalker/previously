// Fake bridge (protocol 2 + deltas): the live deltas DIVERGE from the
// envelope result (adapter bug). The advisory block is closed and the
// authoritative result is re-emitted as a fresh text block (result wins).
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  data += chunk;
});
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ delta: "draft" }) + "\n");
  process.stdout.write(
    JSON.stringify({ protocol: 2, result: "final answer", events: [] }) + "\n",
  );
});
