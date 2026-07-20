export function sse(data: unknown, event?: string): string {
  const lines = [`data: ${typeof data === "string" ? data : JSON.stringify(data)}`];
  if (event) lines.unshift(`event: ${event}`);
  return `${lines.join("\n")}\n\n`;
}

export function sseDone(): string {
  return "data: [DONE]\n\n";
}
