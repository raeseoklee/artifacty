// Shared SSE (text/event-stream) frame parsing for consumers of GET
// /api/events, matching the wire format src/server.js's writeSseEvent /
// handleEventStream produce. Kept here rather than duplicated inline in
// src/cli.js's `artifacty watch` so the two can't drift.

// Parses one already-delimited frame (the text before a blank line) into
// { id, event, data }, or null when the frame carries no `data:` line
// (comments like ": connected"/": heartbeat" and bare `id:`/`event:`-only
// frames are not data events). Per the SSE spec, only a single leading
// space after the field's colon is stripped — not a full trim, which would
// also eat meaningful trailing whitespace from the field value.
export function parseSseFrame(rawFrame) {
  let id;
  let event;
  const dataLines = [];
  for (const line of String(rawFrame ?? "").split("\n")) {
    if (line.startsWith("id:")) {
      id = stripOneLeadingSpace(line.slice(3));
    } else if (line.startsWith("event:")) {
      event = stripOneLeadingSpace(line.slice(6));
    } else if (line.startsWith("data:")) {
      dataLines.push(stripOneLeadingSpace(line.slice(5)));
    }
  }
  if (dataLines.length === 0) {
    return null;
  }
  return { id, event, data: dataLines.join("\n") };
}

function stripOneLeadingSpace(value) {
  return value.startsWith(" ") ? value.slice(1) : value;
}

// Splits an accumulated stream buffer on blank-line frame boundaries,
// returning every complete frame found (parsed, with non-data frames
// filtered out) plus the leftover partial buffer for the next read.
export function parseSseFrames(buffer) {
  const frames = [];
  let rest = String(buffer ?? "");
  let boundary = rest.indexOf("\n\n");
  while (boundary !== -1) {
    const rawFrame = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);
    const parsed = parseSseFrame(rawFrame);
    if (parsed) {
      frames.push(parsed);
    }
    boundary = rest.indexOf("\n\n");
  }
  return { frames, rest };
}
