// bb-plugin-rtk — Rewrite Terminal Kommand for BB.
//
// Port of ogallotti/rtk-hermes: an opt-in shell tool that rewrites the
// agent's shell commands through the `rtk` CLI proxy for token savings on
// verbose output (builds, tests, git diffs, package manager output).
//
// This plugin ONLY affects commands the agent explicitly sends through the
// `rtk_shell` tool — it does not touch bb's built-in terminal. It requires
// the external `rtk` CLI to be installed. It is an unrestricted shell tool:
// commands run with the project's working directory and full user privileges.
//
// Registers `rtk_shell` as a native agent tool:
//   rtk_shell "git status" → rewrites → runs through rtk → returns filtered output
import { type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { exec as execCb, execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";

const execAsync = promisify(execCb);
const execFileAsync = promisify(execFileCb);

// ─── Rewrite policy (ported from ogallotti/rtk-hermes) ───────────────
//
// `rtk rewrite` exit codes: 0 = rewrite allowed, 1 = no equivalent,
// 2 = deny, 3 = ask/confirm. Codes 0 and 3 both put a valid rewritten
// command on stdout. Anything else — and a timeout or a missing binary —
// is fail-open: the original command runs unchanged.

export interface RewriteDecision {
  command: string;
  rewrote: boolean;
  note?: string;
}

export function decideRewrite(
  exitCode: number | null,
  stdout: string,
  original: string,
): RewriteDecision {
  const candidate = (stdout ?? "").trim();
  if ((exitCode === 0 || exitCode === 3) && candidate && candidate !== original.trim()) {
    return { command: candidate, rewrote: true };
  }
  const notes: Record<number, string> = {
    0: "RTK left the command unchanged",
    1: "no RTK equivalent",
    2: "rewrite denied by RTK",
    3: "RTK left the command unchanged",
  };
  const note =
    exitCode === null
      ? "RTK rewrite failed or timed out"
      : (notes[exitCode] ?? `unexpected rewrite exit ${exitCode}`);
  return { command: original, rewrote: false, note };
}

// ─── Settings ────────────────────────────────────────────────────────

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("bb-plugin-rtk loaded");

  const settings = bb.settings.define({
    rtkPath: {
      type: "string" as const,
      label: "RTK binary path",
      default: "",
      description: "Absolute path to the rtk binary. Empty = auto-detect with `which rtk`.",
    },
  });

  let { rtkPath } = await settings.get();

  settings.onChange((next) => {
    rtkPath = next.rtkPath;
    bb.log.info(`[rtk] rtkPath updated → ${rtkPath || "(auto-detect)"}`);
  });

  // Resolve the rtk binary: explicit setting wins, otherwise `which rtk`.
  // Returns a clear error message when rtk is not installed.
  async function resolveRtkPath(): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
    if (rtkPath && rtkPath.trim()) {
      const p = rtkPath.trim();
      if (existsSync(p)) return { ok: true, path: p };
      return {
        ok: false,
        message: `rtk not installed at "${p}". Set the "RTK binary path" setting (check with \`which rtk\`).`,
      };
    }
    try {
      const { stdout } = await execAsync("which rtk", { timeout: 5_000 });
      const p = stdout.trim();
      if (p) return { ok: true, path: p };
    } catch {
      // fall through
    }
    return {
      ok: false,
      message: "rtk is not installed. Install the rtk CLI first (see https://github.com/ogallotti/rtk-hermes), then set the RTK binary path in plugin settings if it is not on PATH.",
    };
  }

  // ── Agent tool: rtk_shell ─────────────────────────────────────────

  bb.agents.registerTool({
    name: "rtk_shell",
    description:
      "Run a shell command through RTK for filtered output (token savings on verbose commands). " +
      "Wraps your command: rtk_shell('git diff') rewrites and runs through rtk, " +
      "returning only the meaningful output. Use for verbose commands: builds, tests, " +
      "git diffs, cargo/build output, package installs. Requires the external rtk CLI. " +
      "This tool does NOT change bb's built-in terminal — only commands sent through rtk_shell " +
      "are filtered. It is an unrestricted shell tool: use with the same care as the terminal. " +
      "For commands where you need unfiltered output (reading files, listing directories), use the terminal tool instead.",
    parameters: z.object({
      command: z
        .string()
        .min(1)
        .describe(
          "The shell command to run. Do NOT prefix with 'rtk' — this tool wraps it for you.",
        ),
    }),
    async execute({ command }, { threadId, projectId }) {
      try {
        const resolved = await resolveRtkPath();
        if (!resolved.ok) return `rtk_shell: ${resolved.message}`;
        const rtk = resolved.path;

        const cwd = await threadCwd(bb, threadId, projectId);
        bb.log.info(`[rtk] thread ${threadId}${cwd ? ` (cwd: ${cwd})` : ""}: ${command}`);

        // Step 1: rewrite — get the optimized command string. execFile rather
        // than a shell, so the command needs no escaping. A non-zero exit is
        // expected here (1 = no equivalent, 2 = deny), not an error.
        let rewriteCode: number | null = null;
        let rewriteStdout = "";
        try {
          const r = await execFileAsync(rtk, ["rewrite", command], {
            cwd,
            timeout: 5_000,
            maxBuffer: 64 * 1024,
          });
          rewriteCode = 0;
          rewriteStdout = r.stdout;
        } catch (err: any) {
          rewriteCode = typeof err.code === "number" ? err.code : null;
          rewriteStdout = err.stdout ?? "";
        }

        const decision = decideRewrite(rewriteCode, rewriteStdout, command);
        if (decision.rewrote) {
          bb.log.info(`[rtk] thread ${threadId}: rewrote → ${decision.command}`);
        } else {
          bb.log.info(`[rtk] thread ${threadId}: running unchanged (${decision.note})`);
        }

        // Step 2: execute the chosen command as a shell command.
        // `rtk rewrite` returns e.g. "rtk git diff" — run that verbatim.
        const { stdout, stderr } = await execAsync(decision.command, {
          cwd,
          timeout: 300_000,
          maxBuffer: 2 * 1024 * 1024,
        });

        const parts: string[] = [];
        if (stdout) parts.push(stdout.trimEnd());
        if (stderr) parts.push(`\n[stderr]\n${stderr.trimEnd()}`);
        return parts.join("") || "(no output)";
      } catch (err: any) {
        const stdout = err.stdout?.trim() ?? "";
        const stderr = err.stderr?.trim() ?? "";
        const parts: string[] = [];
        if (stdout) parts.push(stdout);
        if (stderr) parts.push(`\n[exit ${err.code ?? 1}]\n${stderr}`);
        return parts.join("") || `rtk_shell: command failed (exit ${err.code ?? "unknown"})`;
      }
    },
  });

  // ── Cleanup ──────────────────────────────────────────────────────

  bb.onDispose(() => {
    bb.log.info("bb-plugin-rtk disposed");
  });
}
/** The directory this thread actually works in: its environment's path, not
 *  the project root. A worktree or an attached workspace is a different
 *  directory from the project, and resolving paths against the project puts
 *  files in the wrong tree. */
export async function threadCwd(bb: BbPluginApi, threadId: string, projectId: string): Promise<string> {
  const asPath = (v: any): string | null =>
    v && typeof v === "object" && typeof v.path === "string" && v.path.trim() ? v.path : null;
  try {
    const t: any = await bb.sdk.threads.get({ threadId } as any);
    const thread = t?.thread ?? t;
    const envId = thread?.environmentId;
    if (envId) {
      const e: any = await bb.sdk.environments.get({ environmentId: envId } as any);
      const p = asPath(e?.environment ?? e);
      if (p) return p;
    }
  } catch {
    // fall through to the project
  }
  try {
    const p: any = await bb.sdk.projects.get({ projectId } as any);
    const sources = (p?.project ?? p)?.sources ?? [];
    const src = Array.isArray(sources) ? sources.find((s: any) => s.type === "local_path") : null;
    if (src?.path) return src.path;
  } catch {
    // fall through to the server cwd
  }
  return process.cwd();
}
