/**
 * Run every `test/*.test.mjs` without relying on shell glob expansion.
 *
 * `node --test "test/*.test.mjs"` needs a shell that expands the glob on POSIX
 * and Node >= 21 to expand it itself; Windows cmd expands nothing. Importing the
 * files in-process works on Node 18+ and on every shell.
 */
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const directory = dirname(fileURLToPath(import.meta.url))
const files = readdirSync(directory)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()

for (const file of files) {
  await import(pathToFileURL(join(directory, file)).href)
}
