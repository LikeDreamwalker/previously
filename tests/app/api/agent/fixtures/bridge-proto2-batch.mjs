// Fake bridge (protocol 2, batch mode): no live event lines, just the final
// envelope carrying both the result and the events — the kernel must flush
// the envelope events to onEvent at completion.
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  data += chunk;
});
process.stdin.on("end", () => {
  process.stdout.write(
    JSON.stringify({
      protocol: 2,
      result: "batched result",
      events: [
        { name: "Bash", summary: "Bash pnpm test", status: "ok" },
        { name: "Read", summary: "Read output.log", status: "error" },
      ],
    }),
  );
});
