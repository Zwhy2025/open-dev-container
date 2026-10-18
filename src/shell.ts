// Quoting a value for a POSIX shell is needed by every module that builds a
// command line, so it lives here instead of being re-implemented next to each
// caller.  Single quotes make the value literal; a quote inside the value is
// closed, escaped and reopened.
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Splits a command line into the words the shell would see.  Quoted runs
// collapse into one word, which keeps `ssh 'user@host'` intact.  Used to read
// back the ProxyCommand this extension wrote (see sshTarget.ts).
export function splitShellWords(line: string): string[] {
  const words: string[] = [];
  let current = '';
  let quoted = false;
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else if (char === '\\' && quote === '"' && index + 1 < line.length) {
        index += 1;
        current += line[index];
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      quoted = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (quoted || current) {
        words.push(current);
        current = '';
        quoted = false;
      }
      continue;
    }

    current += char;
  }

  if (quoted || current) {
    words.push(current);
  }

  return words;
}
