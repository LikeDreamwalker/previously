// Fake bridge (protocol 2 + text deltas): streams live NDJSON delta lines
// (plus one malformed delta line that must be ignored), then the final
// envelope. The envelope result is the source of truth — it equals the
// concatenation of the well-formed deltas.
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  data += chunk;
});
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ delta: "Hello, " }) + "\n");
  process.stdout.write('{"delta":123}\n'); // malformed — ignored, never fatal
  process.stdout.write(JSON.stringify({ delta: "world!" }) + "\n");
  process.stdout.write(
    JSON.stringify({ protocol: 2, result: "Hello, world!", events: [] }) + "\n",
  );
});
