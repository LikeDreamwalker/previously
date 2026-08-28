// Fake bridge: fails with a stderr message and a non-zero exit code.
process.stderr.write("bridge exploded");
process.exit(3);
