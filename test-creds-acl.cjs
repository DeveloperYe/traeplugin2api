// 回归测试：凭据文件 ACL 收紧不得把当前用户锁在外面
// 覆盖用户实际踩到的坑：/grant:r 只授 Administrators+SYSTEM → 非管理员进程读不到自己的 token-cache.json
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { execFileSync } = require("child_process");

const REPO = "D:/Users/Administrator/Documents/deepseek-harness/work/trae2api-release";
const credsMod = require(REPO + "/lib/creds.cjs");
const { tightenAcl, aclPrincipals, aclPrincipalNames, Creds } = credsMod;

const user = process.env.USERNAME || os.userInfo().username;
const domain = process.env.USERDOMAIN || "";
let pass = 0, fail = 0;
const ck = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
};

console.log("=== A) 主体清单必须包含当前用户（这是本次 bug 的核心）===");
const principals = aclPrincipals();
console.log("  当前用户: " + (domain ? domain + "\\" : "") + user);
console.log("  主体清单: " + principals.join(", "));
ck("含当前用户名", principals.some((p) => p.toLowerCase().startsWith(user.toLowerCase() + ":")), principals.join(","));
ck("含 SYSTEM（SID 表达）", principals.includes("*S-1-5-18:F"));
ck("含 Administrators（SID 表达）", principals.includes("*S-1-5-32-544:F"));
ck("有域时含 域\\用户", !domain || principals.some((p) => p.toLowerCase().startsWith((domain + "\\" + user).toLowerCase())));
ck("aclPrincipalNames 去掉 :F", aclPrincipalNames().every((n) => !n.endsWith(":F")));

console.log("\n=== B) 真实收紧一个临时文件：仍可读 + ACL 里能看到自己 ===");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "t2a-acl-"));
const f1 = path.join(tmpDir, "a.txt");
fs.writeFileSync(f1, "secret-payload", "utf8");
const okTighten = tightenAcl(f1);
ck("tightenAcl 返回 true", okTighten === true);
ck("收紧后仍能读回内容", fs.readFileSync(f1, "utf8") === "secret-payload");
const aclOut = execFileSync("icacls", [f1], { encoding: "utf8", windowsHide: true });
console.log("  icacls 输出:");
aclOut.split("\n").filter((l) => l.trim()).forEach((l) => console.log("    " + l.trim()));
ck("ACL 含当前用户", aclOut.toLowerCase().includes(user.toLowerCase()), aclOut);
ck("继承已去除（无 (I) 标记）", !aclOut.includes("(I)"), aclOut);
ck("ACL 含 SYSTEM", /SYSTEM/i.test(aclOut));

console.log("\n=== C) 复现用户那个故障：显式 deny 当前用户 → 读失败 → 自动补授后可读 ===");
const f2 = path.join(tmpDir, "b.txt");
fs.writeFileSync(f2, JSON.stringify({ jwt: "x", jwtExp: 1, fresh: "y", freshExp: 2 }), "utf8");
// 先收紧成「正常」状态，再加一条显式拒绝（模拟被锁死的老 ACL）
tightenAcl(f2);
try {
  execFileSync("icacls", [f2, "/deny", user + ":(R)"], { windowsHide: true, stdio: "ignore" });
} catch (e) {
  console.log("  （无法设置 deny，跳过 C 段：" + e.message.split("\n")[0] + "）");
}
let blocked = false;
try { fs.readFileSync(f2, "utf8"); } catch (e) { blocked = true; console.log("  读取被拒: " + e.code); }
if (blocked) {
  ck("deny 生效（确实读不到）", true);
} else {
  console.log("  ⚠ 当前进程是管理员/持有备份特权，deny 未生效 —— C 段降级为「逻辑存在性」检查");
}
// 无论 deny 是否生效，都必须能被 tightenAcl 修回可读
const repaired = tightenAcl(f2);
ck("tightenAcl 修回可读", repaired === true && fs.readFileSync(f2, "utf8").includes("jwt"));

console.log("\n=== D) 端到端：_loadTokenCache 遇到权限错误会自动补授 ===");
const TOKEN_FILE = path.join(REPO, "data", "token-cache.json");
const bak = fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE) : null;
fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
const payload = { jwt: "e30.e30.sig", jwtExp: Date.now() + 3600e3, fresh: "f", freshExp: Date.now() + 7200e3, host: "h", savedAt: Date.now() };
fs.writeFileSync(TOKEN_FILE, JSON.stringify(payload), "utf8");
tightenAcl(TOKEN_FILE);
const creds = new Creds({ log: (m) => console.log("    " + m) });
const loaded = creds._loadTokenCache();
ck("_loadTokenCache 能读到刚写的缓存", loaded && loaded.jwt === payload.jwt);
console.log("\n=== E) 关键回归：老 ACL 文件（自己读不到）能被 _loadTokenCache 自动修复 ===");
fs.writeFileSync(TOKEN_FILE, JSON.stringify(payload), "utf8");
tightenAcl(TOKEN_FILE);
let denied = false;
try { execFileSync("icacls", [TOKEN_FILE, "/deny", user + ":(R)"], { windowsHide: true, stdio: "ignore" }); denied = true; } catch {}
if (denied) {
  let preBlocked = false;
  try { fs.readFileSync(TOKEN_FILE, "utf8"); } catch (e) { preBlocked = true; }
  ck("构造出「读不到」的老状态", preBlocked);
  const logs = [];
  const c2 = new Creds({ log: (m) => logs.push(m) });
  const got = c2._loadTokenCache();
  ck("_loadTokenCache 自动修复后拿到数据", !!got && got.jwt === payload.jwt);
  ck("日志里有补授记录", logs.some((l) => l.includes("补授")), logs.join(" | "));
  const acl2 = execFileSync("icacls", [TOKEN_FILE], { encoding: "utf8", windowsHide: true });
  ck("修复后 ACL 含当前用户", acl2.toLowerCase().includes(user.toLowerCase()));
  ck("修复后无显式 deny", !acl2.includes("(DENY)") && !acl2.includes("(N)"), acl2);
} else {
  console.log("  （无法设置 deny，跳过 E 段）");
}

if (bak) fs.writeFileSync(TOKEN_FILE, bak); else fs.rmSync(TOKEN_FILE, { force: true });

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log("\n合计 " + (pass + fail) + " 项：" + pass + " 通过, " + fail + " 失败");
process.exit(fail ? 1 : 0);
