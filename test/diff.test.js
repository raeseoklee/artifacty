import assert from "node:assert/strict";
import test from "node:test";
import { createStructuredDiff, renderUnifiedDiffText } from "../src/lib/diff.js";

test("json diff matches array items by unique ruleId key", () => {
  const before = JSON.stringify({
    runs: [{ results: [{ ruleId: "a", message: "one" }, { ruleId: "b", message: "two" }] }]
  });
  const after = JSON.stringify({
    runs: [{ results: [{ ruleId: "a", message: "one changed" }, { ruleId: "c", message: "three" }] }]
  });

  const diff = createStructuredDiff(before, after, { format: "sarif" });

  assert.equal(diff.kind, "json");
  const changed = diff.entries.find((entry) => entry.op === "changed");
  assert.ok(changed, "expected a changed entry for the ruleId=a result");
  assert.equal(changed.path, "$.runs[0].results[0].message");
  assert.equal(changed.before, "one");
  assert.equal(changed.after, "one changed");

  const removed = diff.entries.find((entry) => entry.op === "removed");
  assert.equal(removed.path, "$.runs[0].results[1]");
  assert.deepEqual(removed.before, { ruleId: "b", message: "two" });

  const added = diff.entries.find((entry) => entry.op === "added");
  assert.equal(added.path, "$.runs[0].results[1]");
  assert.deepEqual(added.after, { ruleId: "c", message: "three" });

  assert.deepEqual(diff.summary, { added: 1, removed: 1, changed: 1 });
});

test("json diff falls back to positional matching without a unique key", () => {
  const before = JSON.stringify({ items: [{ x: 1 }, { x: 2 }] });
  const after = JSON.stringify({ items: [{ x: 1 }, { x: 3 }, { x: 4 }] });

  const diff = createStructuredDiff(before, after, { format: "json" });

  assert.equal(diff.kind, "json");
  const changed = diff.entries.find((entry) => entry.path === "$.items[1].x");
  assert.ok(changed);
  assert.equal(changed.before, 2);
  assert.equal(changed.after, 3);

  const added = diff.entries.find((entry) => entry.path === "$.items[2]");
  assert.ok(added);
  assert.equal(added.op, "added");
});

test("csv diff reports header change and cell change keyed by unique first column", () => {
  const before = "id,name\n1,Alice\n2,Bob\n";
  const after = "id,fullName\n1,Alicia\n3,Carol\n";

  const diff = createStructuredDiff(before, after, { format: "csv" });

  assert.equal(diff.kind, "csv");
  const headerChange = diff.entries.find((entry) => entry.row === "header");
  assert.ok(headerChange, "expected a header change entry");
  assert.equal(headerChange.column, 1);
  assert.equal(headerChange.before, "name");
  assert.equal(headerChange.after, "fullName");

  const cellChange = diff.entries.find((entry) => entry.op === "changed" && entry.row === "1");
  assert.ok(cellChange);
  assert.equal(cellChange.column, 1);
  assert.equal(cellChange.before, "Alice");
  assert.equal(cellChange.after, "Alicia");

  const removedRow = diff.entries.find((entry) => entry.op === "removed");
  assert.equal(removedRow.row, "2");
  assert.deepEqual(removedRow.cells, ["2", "Bob"]);

  const addedRow = diff.entries.find((entry) => entry.op === "added");
  assert.equal(addedRow.row, "3");
  assert.deepEqual(addedRow.cells, ["3", "Carol"]);
});

test("csv diff falls back to positional row matching when the first column repeats", () => {
  const before = "id,name\nx,Alice\nx,Bob\n";
  const after = "id,name\nx,Alicia\nx,Bobby\n";

  const diff = createStructuredDiff(before, after, { format: "csv" });

  const changes = diff.entries.filter((entry) => entry.op === "changed" && entry.row !== "header");
  assert.equal(changes.length, 2);
  assert.ok(changes.every((entry) => typeof entry.row === "number"));
  assert.deepEqual(changes.map((entry) => entry.row).sort(), [0, 1]);
});

test("markdown/text line diff includes word-level highlight ranges for changed lines", () => {
  const before = "hello world\nsame line\n";
  const after = "hello there\nsame line\nnew line\n";

  const diff = createStructuredDiff(before, after, { format: "markdown" });

  assert.equal(diff.kind, "lines");
  const changed = diff.entries.find((entry) => entry.op === "changed");
  assert.ok(changed);
  assert.ok(Array.isArray(changed.words));
  const removedWord = changed.words.find((w) => w.op === "removed");
  const addedWord = changed.words.find((w) => w.op === "added");
  assert.equal(removedWord.text, "world");
  assert.equal(addedWord.text, "there");

  const same = diff.entries.find((entry) => entry.op === "same");
  assert.ok(same);
  assert.equal(same.text, "same line");

  const added = diff.entries.find((entry) => entry.op === "added");
  assert.equal(added.text, "new line");
});

test("createStructuredDiff caps entries and sets truncated when maxEntries is exceeded", () => {
  const beforeLines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
  const afterLines = Array.from({ length: 50 }, (_, i) => `line ${i} changed`).join("\n");

  const diff = createStructuredDiff(beforeLines, afterLines, { format: "text", maxEntries: 5 });

  assert.equal(diff.truncated, true);
  assert.ok(diff.entries.length <= 5);
});

test("createStructuredDiff respects ARTIFACTY_MAX_DIFF_ENTRIES when maxEntries is not passed", () => {
  const previous = process.env.ARTIFACTY_MAX_DIFF_ENTRIES;
  process.env.ARTIFACTY_MAX_DIFF_ENTRIES = "2";
  try {
    const before = "a\nb\nc\nd\n";
    const after = "1\n2\n3\n4\n";
    const diff = createStructuredDiff(before, after, { format: "text" });
    assert.equal(diff.truncated, true);
    assert.ok(diff.entries.length <= 2);
  } finally {
    if (previous === undefined) {
      delete process.env.ARTIFACTY_MAX_DIFF_ENTRIES;
    } else {
      process.env.ARTIFACTY_MAX_DIFF_ENTRIES = previous;
    }
  }
});

test("bundle diff diffs each file with its own format strategy and reports file add/remove", () => {
  const before = JSON.stringify({
    files: [
      { path: "notes.md", content: "hello\n" },
      { path: "data.csv", content: "id,name\n1,Alice\n" },
      { path: "old.txt", content: "gone soon\n" }
    ]
  });
  const after = JSON.stringify({
    files: [
      { path: "notes.md", content: "hello world\n" },
      { path: "data.csv", content: "id,name\n1,Alicia\n" },
      { path: "new.txt", content: "brand new\n" }
    ]
  });

  const diff = createStructuredDiff(before, after, { format: "bundle" });

  assert.equal(diff.kind, "bundle");
  const removedFile = diff.entries.find((entry) => entry.op === "removed" && entry.file === "old.txt");
  assert.ok(removedFile);
  const addedFile = diff.entries.find((entry) => entry.op === "added" && entry.file === "new.txt");
  assert.ok(addedFile);

  const csvEntry = diff.entries.find((entry) => entry.file === "data.csv" && entry.op === "changed");
  assert.ok(csvEntry, "expected a changed cell entry for data.csv");
  assert.equal(csvEntry.kind, "csv");

  const mdEntry = diff.entries.find((entry) => entry.file === "notes.md" && entry.op === "changed");
  assert.ok(mdEntry, "expected a changed line entry for notes.md");
  assert.equal(mdEntry.kind, "lines");
});

test("renderUnifiedDiffText produces a compact human-readable summary", () => {
  const diff = createStructuredDiff("a\nb\n", "a\nc\n", { format: "text" });
  const text = renderUnifiedDiffText(diff);
  assert.ok(text.includes("- b"));
  assert.ok(text.includes("+ c"));
});
