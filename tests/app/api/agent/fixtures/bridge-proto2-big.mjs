// Fake bridge (protocol 2): envelope whose result exceeds the 512k cap —
// the kernel must truncate it with the truncation note.
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  data += chunk;
});
process.stdin.on("end", () => {
  process.stdout.write(
    JSON.stringify({ protocol: 2, result: "x".repeat(600_000) }),
  );
});
