// Fake bridge (protocol 1 output): answers with prose + a trailing JSON
// tool-call object — the text tool protocol the bridge model parses back
// into a real tool-call part.
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  data += chunk;
});
process.stdin.on("end", () => {
  process.stdout.write(
    "Here are my findings from the timeline.\n" +
      '{"tool":"recallReport","input":{"hits":[],"confidence":0.5,' +
      '"reasoning":"nothing matched","recommended_reads":[]}}',
  );
});
