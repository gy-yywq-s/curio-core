const MAX_LCS_CELLS = 1_000_000;
const CONTEXT_LINES = 3;

function sourceLines(source) {
  const normalized = String(source || "").replace(/\r\n?/g, "\n");
  return normalized === "" ? [] : normalized.split("\n");
}

function fallbackDiff(before, after) {
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  return [
    ...before.slice(0, prefix).map((text) => ({ kind: "same", text })),
    ...before.slice(prefix, before.length - suffix).map((text) => ({ kind: "remove", text })),
    ...after.slice(prefix, after.length - suffix).map((text) => ({ kind: "add", text })),
    ...before.slice(before.length - suffix).map((text) => ({ kind: "same", text })),
  ];
}

function fullLineDiff(before, after) {
  if ((before.length + 1) * (after.length + 1) > MAX_LCS_CELLS) {
    return fallbackDiff(before, after);
  }

  const width = after.length + 1;
  const lengths = new Uint32Array((before.length + 1) * width);
  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      const index = left * width + right;
      lengths[index] =
        before[left] === after[right]
          ? lengths[(left + 1) * width + right + 1] + 1
          : Math.max(lengths[(left + 1) * width + right], lengths[left * width + right + 1]);
    }
  }

  const result = [];
  let left = 0;
  let right = 0;
  while (left < before.length || right < after.length) {
    if (left < before.length && right < after.length && before[left] === after[right]) {
      result.push({ kind: "same", text: before[left] });
      left += 1;
      right += 1;
    } else if (
      right < after.length &&
      (left >= before.length ||
        lengths[left * width + right + 1] >= lengths[(left + 1) * width + right])
    ) {
      result.push({ kind: "add", text: after[right] });
      right += 1;
    } else {
      result.push({ kind: "remove", text: before[left] });
      left += 1;
    }
  }
  return result;
}

function withLineNumbers(lines) {
  let beforeLine = 0;
  let afterLine = 0;
  return lines.map((line) => {
    if (line.kind !== "add") beforeLine += 1;
    if (line.kind !== "remove") afterLine += 1;
    return {
      ...line,
      beforeLine: line.kind === "add" ? null : beforeLine,
      afterLine: line.kind === "remove" ? null : afterLine,
    };
  });
}

function compactContext(lines) {
  const compacted = [];
  for (let index = 0; index < lines.length;) {
    if (lines[index].kind !== "same") {
      compacted.push(lines[index]);
      index += 1;
      continue;
    }
    let end = index;
    while (end < lines.length && lines[end].kind === "same") end += 1;
    const run = lines.slice(index, end);
    if (run.length > CONTEXT_LINES * 2 + 2) {
      compacted.push(...run.slice(0, CONTEXT_LINES));
      compacted.push({ kind: "skip", count: run.length - CONTEXT_LINES * 2 });
      compacted.push(...run.slice(-CONTEXT_LINES));
    } else {
      compacted.push(...run);
    }
    index = end;
  }
  return compacted;
}

export function diffLines(beforeSource, afterSource) {
  return compactContext(
    withLineNumbers(fullLineDiff(sourceLines(beforeSource), sourceLines(afterSource))),
  );
}
