// Settings for npm run dev, from the environment or else agents/.env. A name set in
// the environment wins even when it is empty, so NAME= on the command line switches
// off what the file sets, as python-dotenv does for the agents.

// The value agents/.env gives a name, with quotes taken off, or undefined.
export const fileSetting = (file: string, name: string): string | undefined => {
  const match = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=[ \\t]*(.*)$`, "m").exec(file);
  const value = match?.[1]
    ?.replace(/^(['"])(.*)\1.*$/, "$2")
    .replace(/(^|[ \t]+)#.*$/, "")
    .trim();
  return value || undefined;
};

// The environment's value when the name is set there, even empty; else the file's.
export const setting = (env: NodeJS.ProcessEnv, file: string, name: string): string | undefined =>
  name in env ? env[name]?.trim() || undefined : fileSetting(file, name);

// Settings to hand on to a child: those the file supplies and the environment lacks.
// The child inherits the environment's own values, empty ones included.
export const fromFile = (env: NodeJS.ProcessEnv, file: string, names: string[]): Record<string, string> => {
  const found: Record<string, string> = {};
  for (const name of names) {
    if (name in env) continue;
    const value = fileSetting(file, name);
    if (value) found[name] = value;
  }
  return found;
};
