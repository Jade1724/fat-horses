// Structured JSON logs, one line per event (SPEC.md N7). CloudWatch reads stdout/stderr.

type Fields = Record<string, unknown>;

function write(level: "debug" | "info" | "warn" | "error", msg: string, fields: Fields): void {
  if (process.env.VITEST && level !== "error") return;
  const line = JSON.stringify({ level, msg, ...fields });
  if (level === "info" || level === "debug") console.log(line);
  else console.error(line);
}

export const log = {
  debug: (msg: string, fields: Fields = {}) => {
    if (process.env.LOG_LEVEL === "debug") write("debug", msg, fields);
  },
  info: (msg: string, fields: Fields = {}) => write("info", msg, fields),
  warn: (msg: string, fields: Fields = {}) => write("warn", msg, fields),
  error: (msg: string, fields: Fields = {}) => write("error", msg, fields),
};
