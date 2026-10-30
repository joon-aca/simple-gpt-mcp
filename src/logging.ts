export function log(
  event: string,
  metadata: {
    request_id?: string;
    session_id?: string;
    code?: string;
    status?: string;
    duration_ms?: number;
    error_name?: string;
    error_code?: string;
    sqlite_error?: string;
  } = {},
) {
  process.stderr.write(
    `${JSON.stringify({ time: new Date().toISOString(), event, ...metadata })}\n`,
  );
}
