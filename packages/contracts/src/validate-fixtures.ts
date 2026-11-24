import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateFixture } from "./fixture.js";

/** Validate every *.json fixture in a directory; exit 1 if any is invalid. */
async function main(dir: string): Promise<number> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) {
    console.error(`no fixtures found in ${dir}`);
    return 1;
  }

  let failed = 0;
  for (const file of files) {
    const path = join(dir, file);
    let input: unknown;
    try {
      input = JSON.parse(await readFile(path, "utf8"));
    } catch (err) {
      failed++;
      console.error(`✗ ${path}: invalid JSON (${(err as Error).message})`);
      continue;
    }

    const result = validateFixture(input);
    if (result.ok) {
      console.log(`✓ ${path}: ${result.fixture.events.length} events`);
    } else {
      failed++;
      console.error(`✗ ${path}`);
      for (const issue of result.issues) console.error(`    ${issue.path}: ${issue.message}`);
    }
  }
  return failed === 0 ? 0 : 1;
}

main(process.argv[2] ?? "fixtures").then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
