// Fake bridge: echoes the stdin payload back as a result, exit 0.
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  data += chunk;
});
process.stdin.on("end", () => {
  const payload = JSON.parse(data);
  process.stdout.write(`ok:${payload.task}|ctx:${payload.context}`);
});
