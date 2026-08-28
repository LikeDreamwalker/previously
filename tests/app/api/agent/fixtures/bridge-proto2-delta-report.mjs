// Fake bridge (protocol 2 + deltas + report tail): streams deltas whose
// concatenation is prose + the JSON tool-call tail, then the envelope. Used
// to prove tool-protocol calls never stream deltas live (the machine JSON
// tail must not render) and keep the one-shot replay.
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  data += chunk;
});
process.stdin.on("end", () => {
  const text = "Here are my findings from the timeline.";
  const tail =
    '\n{"tool":"recallReport","input":{"hits":[],"confidence":0.5,"reasoning":"nothing matched","recommended_reads":[]}}';
  process.stdout.write(JSON.stringify({ delta: text }) + "\n");
  process.stdout.write(JSON.stringify({ delta: tail }) + "\n");
  process.stdout.write(
    JSON.stringify({ protocol: 2, result: text + tail, events: [] }) + "\n",
  );
});
