/**
 * What `scripts/deploy-dev.sh` refuses to do.
 *
 * The script exists because deploying by hand destroyed two files the host owns, so its value is entirely
 * in its refusals — and a refusal nobody exercises is a comment. Nothing here touches a host: `ssh` and
 * `rsync` are stubs on `PATH` that record their argv and answer from fixtures, so every path below is the
 * real script making a real decision about a plan it was handed.
 *
 * Two controls run beside the refusals, because a script that refused everything would satisfy them all:
 * the application's own files must actually be transferred, and every host-owned name must actually reach
 * `rsync` as an `--exclude`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SCRIPT = path.resolve(import.meta.dirname, "../deploy-dev.sh");

interface Sandbox {
  readonly tree: string;
  readonly log: string;
  readonly out: string;
  readonly env: Record<string, string>;
}

/**
 * A working tree, a stub `PATH`, and the fixtures the stubs answer from.
 *
 * The tree is a real git repository with one tracked source file, because the script asks git for the
 * commit it is about to deploy and digests `apps/` and `packages/` to record what the bytes were. A
 * fake git would make those two answers untestable, which are the two the manifest exists for.
 */
function sandbox(fixtures: {
  readonly protected?: readonly string[];
  readonly plan?: string;
  readonly container?: string;
  readonly image?: string;
  readonly retainFails?: boolean;
  readonly buildRc?: string;
}): Sandbox {
  const root = mkdtempSync(path.join(tmpdir(), "deploy-dev-"));
  const tree = path.join(root, "tree");
  const bin = path.join(root, "bin");
  const out = path.join(root, "out");
  mkdirSync(path.join(tree, "apps", "web", "src"), { recursive: true });
  mkdirSync(path.join(tree, "packages", "db", "src"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(tree, "apps", "web", "src", "app.ts"), "export const a = 1;\n");
  writeFileSync(path.join(tree, "packages", "db", "src", "db.ts"), "export const b = 2;\n");
  writeFileSync(path.join(tree, "compose.yaml"), "services: {}\n");

  const git = (...args: readonly string[]): void => {
    execFileSync("git", args, { cwd: tree, stdio: "ignore" });
  };
  git("init", "--quiet");
  git("config", "user.email", "test@example.test");
  git("config", "user.name", "Test");
  git("add", ".");
  git("commit", "--quiet", "-m", "fixture");

  const log = path.join(root, "calls.log");
  writeFileSync(log, "");

  // The last argument is the remote command, because the script invokes `ssh … "$HOST" "<command>"`.
  // Answers are matched on the command rather than on argument position, so a change in the ssh flags
  // does not quietly turn every branch into the fall-through.
  writeFileSync(
    path.join(bin, "ssh"),
    `#!/usr/bin/env bash
cmd="\${@: -1}"
printf 'SSH|%s\\n' "$cmd" >> "$STUB_LOG"
case "$cmd" in
  *"ls -A"*)                            printf '%s\\n' $STUB_PROTECTED ;;
  *"compose ps -q web"*)                printf '%s\\n' "$STUB_CONTAINER" ;;
  *"inspect -f '{{.Config.Image}}'"*)   printf '%s\\n' "$STUB_IMAGE" ;;
  *"image inspect -f '{{.Id}}'"*)
      case "$cmd" in
        *:latest*) printf '%s\\n' "sha256:deadbeef" ;;
        *) [ "\${STUB_RETAIN_FAILS:-0}" = "1" ] && exit 1 || printf '%s\\n' "sha256:deadbeef" ;;
      esac ;;
  *"docker tag"*)                       printf 'TAG|%s\\n' "$cmd" >> "$STUB_LOG" ;;
  *"keepsay-dev-build.sh"*)             cat > "$STUB_OUT/build.sh" 2>/dev/null || true ;;
  *"test -f /tmp/keepsay-dev-build.rc"*) exit 0 ;;
  *"cat /tmp/keepsay-dev-build.rc"*)    printf '%s\\n' "\${STUB_BUILD_RC:-0}" ;;
  *tail*)                               printf 'BUILD_RC=0\\nUP_RC=0\\n' ;;
  *deployed.json*)                      cat > "$STUB_OUT/manifest.json" ;;
  *)                                    : ;;
esac
`,
  );
  writeFileSync(
    path.join(bin, "rsync"),
    `#!/usr/bin/env bash
printf 'RSYNC|%s\\n' "$*" >> "$STUB_LOG"
for a in "$@"; do
  if [ "$a" = "--dry-run" ]; then printf '%s' "$STUB_PLAN"; exit 0; fi
done
exit 0
`,
  );
  chmodSync(path.join(bin, "ssh"), 0o755);
  chmodSync(path.join(bin, "rsync"), 0o755);

  return {
    tree,
    log,
    out,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: root,
      STUB_LOG: log,
      STUB_OUT: out,
      STUB_PROTECTED: (fixtures.protected ?? []).join(" "),
      STUB_PLAN: fixtures.plan ?? "",
      STUB_CONTAINER: fixtures.container ?? "c0ffee",
      STUB_IMAGE: fixtures.image ?? "omnichannel-staging-app:latest",
      ...(fixtures.retainFails === true ? { STUB_RETAIN_FAILS: "1" } : {}),
      ...(fixtures.buildRc === undefined ? {} : { STUB_BUILD_RC: fixtures.buildRc }),
    },
  };
}

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly calls: string;
}

/**
 * Runs the script and returns its status and both streams.
 *
 * `spawnSync` rather than `execFileSync`: the latter returns stdout only, and surfaces stderr nowhere on
 * a successful exit — which is exactly where this script writes the dirty-tree warning. The first version
 * of this harness therefore asserted against an empty string and reported the script as broken when the
 * warning had in fact been printed.
 */
function attempt(box: Sandbox, extra: Record<string, string> = {}): Run {
  const result = spawnSync("bash", [SCRIPT], {
    cwd: box.tree,
    env: {
      ...box.env,
      KEEPSAY_DEV_HOST: "deploy@host.invalid",
      KEEPSAY_DEV_KEY: "/dev/null",
      KEEPSAY_DEV_DIR: "/opt/stack",
      KEEPSAY_DEV_ARTEFACTS: "/root/artefacts",
      ...extra,
    },
    encoding: "utf8",
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    calls: existsSync(box.log) ? readFileSync(box.log, "utf8") : "",
  };
}

const APP_PLAN = ">f+++++++ apps/web/src/app.ts\n>f+++++++ packages/db/src/db.ts\n";

describe("the development deploy script's refusals", () => {
  it("refuses, and reaches no host, when the host is not configured", () => {
    const box = sandbox({ protected: ["compose.yaml"], plan: APP_PLAN });
    const result = attempt(box, { KEEPSAY_DEV_HOST: "" });

    expect(result.status).not.toBe(0);
    // The point is not the exit code but that nothing was contacted before the refusal.
    expect(result.calls).toBe("");
  });

  it("refuses when the host's artefact list is empty, rather than protecting nothing", () => {
    const box = sandbox({ protected: [], plan: APP_PLAN });
    const result = attempt(box);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("nothing would be protected");
    // It asked the host and then stopped: no transfer was planned or performed.
    expect(result.calls).toContain("SSH|ls -A");
    expect(result.calls).not.toContain("RSYNC|");
  });

  it("refuses when the plan would delete a host-owned file", () => {
    const box = sandbox({
      protected: ["compose.yaml", "Dockerfile"],
      plan: `*deleting compose.yaml\n${APP_PLAN}`,
    });
    const result = attempt(box);

    expect(result.status).toBe(3);
    expect(result.stderr).toContain("compose.yaml");
    // Only the dry run ran. Nothing was transferred.
    expect(result.calls).toContain("--dry-run");
    expect(result.calls.split("\n").filter((line) => line.startsWith("RSYNC|") && !line.includes("--dry-run"))).toEqual([]);
  });

  it("refuses when the plan would rewrite a host-owned file", () => {
    const box = sandbox({ protected: ["nginx.conf"], plan: `>f..t.... nginx.conf\n${APP_PLAN}` });

    expect(attempt(box).status).toBe(3);
  });

  /**
   * The case the previous implementation missed. It interpolated each protected name into a regular
   * expression, so a name carrying a metacharacter did not match the plan line that deleted it —
   * measured before this test existed: `backup(1).sql` was not detected while `compose.yaml` was.
   */
  it("refuses for a host-owned name containing regular-expression metacharacters", () => {
    const box = sandbox({ protected: ["backup(1).sql"], plan: `*deleting backup(1).sql\n${APP_PLAN}` });
    const result = attempt(box);

    expect(result.status).toBe(3);
    expect(result.stderr).toContain("backup(1).sql");
  });

  /** The other direction of the same change: a name must not match a path that merely resembles it. */
  it("does not treat a different file as the protected one", () => {
    const box = sandbox({ protected: [".env"], plan: `*deleting aenv\n${APP_PLAN}` });

    expect(attempt(box).status).not.toBe(3);
  });

  it("refuses a transfer that would change nothing, because it proves no filter", () => {
    const box = sandbox({ protected: ["compose.yaml"], plan: "" });
    const result = attempt(box);

    expect(result.status).toBe(4);
    expect(result.stderr).toContain("nothing to transfer");
  });

  it("refuses when no running container could have its image retained", () => {
    const box = sandbox({ protected: ["compose.yaml"], plan: APP_PLAN, container: "" });
    const result = attempt(box);

    expect(result.status).toBe(5);
    expect(result.stderr).toContain("rollback");
    expect(result.calls).not.toContain("RSYNC|-az --delete --exclude");
  });

  it("refuses when the retained tag cannot be read back after tagging", () => {
    const box = sandbox({ protected: ["compose.yaml"], plan: APP_PLAN, retainFails: true });
    const result = attempt(box);

    expect(result.status).toBe(6);
    expect(result.stderr).toContain("rollback is not available");
  });
});

describe("the development deploy script's gates and records", () => {
  it("stops after the plan when asked for a dry run, having changed nothing", () => {
    const box = sandbox({ protected: ["compose.yaml"], plan: APP_PLAN });
    const result = attempt(box, { KEEPSAY_DEV_DRY_RUN: "1" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("nothing was transferred");
    // No image was retained and no real transfer happened: the gate is before both.
    expect(result.calls).not.toContain("TAG|");
    expect(result.calls.split("\n").filter((line) => line.startsWith("RSYNC|") && !line.includes("--dry-run"))).toEqual([]);
  });

  it("retains the running image under a dated tag before replacing it", () => {
    const box = sandbox({ protected: ["compose.yaml"], plan: APP_PLAN });
    const result = attempt(box);

    expect(result.status).toBe(0);
    const tagged = result.calls.split("\n").find((line) => line.startsWith("TAG|"));
    expect(tagged).toBeDefined();
    // A dated tag, not a second `latest`: the point is that it cannot be overwritten by the next deploy.
    expect(tagged).toMatch(/docker tag 'omnichannel-staging-app:latest' 'omnichannel-staging-app:\d{8}T\d{6}Z'/u);
  });

  it("records the commit, the tree's digest and the rollback target", () => {
    const box = sandbox({ protected: ["compose.yaml"], plan: APP_PLAN });
    const result = attempt(box);

    expect(result.status).toBe(0);
    const manifest = JSON.parse(readFileSync(path.join(box.out, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(manifest["source_sha"]).toMatch(/^[0-9a-f]{40}$/u);
    expect(manifest["source_dirty"]).toBe(false);
    expect(manifest["source_digest"]).toMatch(/^[0-9a-f]{40}$/u);
    expect(manifest["previous_image"]).toBe("omnichannel-staging-app:latest");
    expect(manifest["retained_tag"]).toMatch(/^omnichannel-staging-app:\d{8}T\d{6}Z$/u);
  });

  it("says the tree was dirty rather than naming a commit the bytes do not match", () => {
    const box = sandbox({ protected: ["compose.yaml"], plan: APP_PLAN });
    writeFileSync(path.join(box.tree, "apps", "web", "src", "app.ts"), "export const a = 99;\n");
    const result = attempt(box);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("dirty");
    const manifest = JSON.parse(readFileSync(path.join(box.out, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(manifest["source_dirty"]).toBe(true);
  });

  it("writes no manifest when the build fails, and still names the rollback target", () => {
    const box = sandbox({ protected: ["compose.yaml"], plan: APP_PLAN, buildRc: "1" });
    const result = attempt(box);

    expect(result.status).toBe(1);
    expect(existsSync(path.join(box.out, "manifest.json"))).toBe(false);
    expect(result.stderr).toContain("docker tag");
  });

  it("computes the digest without shasum, which only Linux lacks", () => {
    const box = sandbox({ protected: ["compose.yaml"], plan: APP_PLAN });
    // A PATH holding the stubs and the coreutils directory but no `shasum`, so the fallback is the only
    // way the digest can be produced at all. Without the fallback this run fails instead of differing.
    const stubs = box.env["PATH"]?.split(":")[0] ?? "";
    const result = attempt(box, { PATH: `${stubs}:/usr/bin:/bin:/usr/sbin:/sbin` });

    expect(result.status).toBe(0);
    const manifest = JSON.parse(readFileSync(path.join(box.out, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(manifest["source_digest"]).toMatch(/^[0-9a-f]{40}$/u);
  });
});

describe("the controls that keep those refusals honest", () => {
  it("transfers the application's own files", () => {
    const box = sandbox({ protected: ["compose.yaml"], plan: APP_PLAN });
    const result = attempt(box);

    expect(result.status).toBe(0);
    const real = result.calls.split("\n").filter((line) => line.startsWith("RSYNC|") && !line.includes("--dry-run"));
    expect(real).toHaveLength(1);
    // Nothing under apps/ or packages/ is excluded, so the plan the dry run produced is what is sent.
    expect(real[0]).not.toContain("--exclude apps");
    expect(real[0]).not.toContain("--exclude packages");
  });

  it("passes every host-owned name to rsync as an exclusion", () => {
    const names = ["compose.yaml", "Dockerfile", "nginx.conf", "backup(1).sql"];
    const box = sandbox({ protected: names, plan: APP_PLAN });
    const result = attempt(box);

    expect(result.status).toBe(0);
    const real = result.calls.split("\n").filter((line) => line.startsWith("RSYNC|") && !line.includes("--dry-run"));
    expect(real).toHaveLength(1);
    for (const name of names) {
      expect(real[0]).toContain(`--exclude ${name}`);
    }
  });

  it("excludes the environment files, which is what preserves the invite-only sign-in", () => {
    const box = sandbox({ protected: ["compose.yaml"], plan: APP_PLAN });
    const result = attempt(box);

    const real = result.calls.split("\n").filter((line) => line.startsWith("RSYNC|") && !line.includes("--dry-run"));
    // `AUTH_SIGN_IN_ACCESS` and the allowlist live in the host's `.env`. A deploy that overwrote it would
    // reopen registration silently, which is why this is asserted rather than left to the static list.
    expect(real[0]).toContain("--exclude .env");
    expect(real[0]).toContain("--exclude .env.*");
  });
});
