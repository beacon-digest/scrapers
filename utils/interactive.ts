import type { Interface } from "node:readline/promises";

const iterators = new WeakMap<Interface, AsyncIterator<string>>();

/**
 * Reads a single line from a readline interface that is shared across the
 * whole CLI session (one interface reused for URL collection, location
 * confirmation, etc.). `inquirer`'s prompt was tried for this first, but a
 * second sequential `inquirer.prompt()` call in the same process reliably
 * throws `ExitPromptError` in this environment — reproduced even with two
 * bare `input` prompts and no other logic involved, both over piped stdin
 * and a real pseudo-terminal.
 *
 * Do not use a one-line `for await` loop here. Returning from that loop also
 * returns the interface's async iterator, which can close the shared
 * readline interface and make every later prompt immediately hit EOF.
 */
export async function readLine(rl: Interface, prompt: string): Promise<string | null> {
  console.log(prompt);
  let iterator = iterators.get(rl);
  if (!iterator) {
    iterator = rl[Symbol.asyncIterator]();
    iterators.set(rl, iterator);
  }
  const result = await iterator.next();
  return result.done ? null : result.value.trim();
}
