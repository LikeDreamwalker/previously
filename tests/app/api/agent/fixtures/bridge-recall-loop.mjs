// Fake bridge emulating a two-round sub-agent loop (recall pattern):
//   round 1 — no tool result in the transcript yet: request readGlobalTimeline
//   round 2 — the kernel executed it server-side and the result came back as
//             `[tool result: readGlobalTimeline]` transcript text: report.
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  data += chunk;
});
process.stdin.on("end", () => {
  if (data.includes("[tool result: readGlobalTimeline]")) {
    process.stdout.write(
      "Search complete.\n" +
        '{"tool":"recallReport","input":{"hits":[],"confidence":0.4,' +
        '"reasoning":"searched the timeline","recommended_reads":[]}}',
    );
  } else {
    process.stdout.write('{"tool":"readGlobalTimeline","input":{}}');
  }
});
