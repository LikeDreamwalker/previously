// Fake bridge (protocol 2): streams two live NDJSON event lines, then the
// final envelope. The envelope echoes the same events — the kernel must skip
// the already-streamed prefix instead of double-reporting them.
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  data += chunk;
});
process.stdin.on("end", () => {
  const events = [
    { name: "Read", summary: "Read memory/2026-08-22-0340.md", status: "start" },
    { name: "Read", summary: "Read memory/2026-08-22-0340.md", status: "ok" },
  ];
  for (const event of events) {
    process.stdout.write(JSON.stringify({ event }) + "\n");
  }
  process.stdout.write(
    JSON.stringify({ protocol: 2, result: "the final answer", events }) + "\n",
  );
});
