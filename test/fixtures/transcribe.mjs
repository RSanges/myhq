// Stands in for a speech-to-text command in the tests: prints the file it gets.
import fs from "node:fs";

process.stdout.write(fs.readFileSync(process.argv[2], "utf8"));
