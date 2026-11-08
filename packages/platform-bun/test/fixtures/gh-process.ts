// oxlint-disable-next-line prefer-destructuring -- The fixture command starts at argv index two.
export const mode = process.argv[2];
if (mode === "ok") {
  process.stdout.write(process.argv[3] ?? "ok");
} else if (mode === "hang") {
  const filename = process.argv.at(3);
  if (filename === undefined) {
    throw new Error("Missing PID filename");
  }
  await Bun.write(filename, String(process.pid));
  setInterval(() => {
    Date.now();
  }, 1000);
} else if (mode === "large") {
  process.stdout.write("x".repeat(1000));
} else {
  process.stderr.write("secret-from-stderr");
  process.exitCode = 1;
}
