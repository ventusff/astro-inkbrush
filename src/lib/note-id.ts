/**
 * The note id grammar: slash-separated segments of Unicode letters,
 * numbers, `_`, `.` and `-`; a segment never starts with `.` or `-` (no
 * hidden files, no option-looking names) and never is empty. Matches
 * what the content scanner discovers, so every scanned note is also
 * addressable. Defined here, free of server imports, so the libraries
 * that name units share it with the server.
 */
export const NOTE_ID = /^[\p{L}\p{N}_][\p{L}\p{N}_.-]*(\/[\p{L}\p{N}_][\p{L}\p{N}_.-]*)*$/u;
