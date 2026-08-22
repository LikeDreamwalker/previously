// Fake bridge: answers with prose + a trailing JSON tool-call object whose
// tool name is NOT one of the offered tools — the bridge model must keep it
// as plain text in auto mode and fail when a specific tool is forced.
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  data += chunk;
});
process.stdin.on("end", () => {
  process.stdout.write(
    "Some prose.\n" + '{"tool":"notAnOfferedTool","input":{"x":1}}',
  );
});
