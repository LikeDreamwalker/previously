// Fake bridge (protocol 1): plain-text output over the 30k legacy cap —
// the kernel must truncate it with the truncation note.
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  data += chunk;
});
process.stdin.on("end", () => {
  process.stdout.write("y".repeat(40_000));
});
