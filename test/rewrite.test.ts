// Rewrite-policy tests, ported from ogallotti/rtk-hermes (src/rtk_hermes/__init__.py,
// v1.2.3). Upstream only accepts a rewrite when `rtk rewrite` exits 0 or 3 AND
// prints a command different from the original; every other outcome runs the
// original command unchanged.
//
// Run: node --test test/rewrite.test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { decideRewrite } from "../server.ts";

test("exit 0 with a different command is a rewrite", () => {
  const d = decideRewrite(0, "rtk git status\n", "git status");
  assert.equal(d.rewrote, true);
  assert.equal(d.command, "rtk git status");
});

test("exit 3 (ask/confirm) still carries a usable rewrite", () => {
  const d = decideRewrite(3, "rtk cargo test\n", "cargo test");
  assert.equal(d.rewrote, true);
  assert.equal(d.command, "rtk cargo test");
});

test("exit 1 means no equivalent, so the original runs", () => {
  const d = decideRewrite(1, "", "ls -la");
  assert.equal(d.rewrote, false);
  assert.equal(d.command, "ls -la");
  assert.equal(d.note, "no RTK equivalent");
});

test("exit 2 is a denied rewrite, not a denied command", () => {
  const d = decideRewrite(2, "rtk rm -rf build\n", "rm -rf build");
  assert.equal(d.rewrote, false);
  assert.equal(d.command, "rm -rf build");
  assert.equal(d.note, "rewrite denied by RTK");
});

test("an unchanged command from exit 0 is not a rewrite", () => {
  const d = decideRewrite(0, "git status", "git status");
  assert.equal(d.rewrote, false);
  assert.equal(d.command, "git status");
});

test("empty stdout on exit 0 is not a rewrite", () => {
  const d = decideRewrite(0, "   \n", "make");
  assert.equal(d.rewrote, false);
  assert.equal(d.command, "make");
});

test("a failed or timed-out rewrite is fail-open", () => {
  const d = decideRewrite(null, "", "make -j8");
  assert.equal(d.rewrote, false);
  assert.equal(d.command, "make -j8");
  assert.match(d.note ?? "", /failed or timed out/);
});

test("an unknown exit code is fail-open and named", () => {
  const d = decideRewrite(7, "whatever", "make");
  assert.equal(d.rewrote, false);
  assert.equal(d.command, "make");
  assert.equal(d.note, "unexpected rewrite exit 7");
});

test("live rtk, when installed, produces a decision this policy accepts", (t) => {
  const candidates = ["/opt/homebrew/bin/rtk", "/usr/local/bin/rtk"];
  const rtk = candidates.find((p) => existsSync(p));
  if (!rtk) {
    t.skip("rtk not installed");
    return;
  }
  let code: number | null = null;
  let stdout = "";
  try {
    stdout = execFileSync(rtk, ["rewrite", "git diff"], { encoding: "utf8", timeout: 5000 });
    code = 0;
  } catch (err: any) {
    code = typeof err.status === "number" ? err.status : null;
    stdout = err.stdout?.toString() ?? "";
  }
  const d = decideRewrite(code, stdout, "git diff");
  // Either a real rewrite is offered, or the original is kept — never a crash,
  // and never an empty command.
  assert.ok(d.command.trim().length > 0);
  if (d.rewrote) assert.match(d.command, /^rtk\b/);
  else assert.equal(d.command, "git diff");
});
