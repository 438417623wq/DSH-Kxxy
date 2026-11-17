/**
 * 极简 semver 比较器 —— 只为「构建期能否满足 peer 区间」这一个问题存在。
 *
 * 为什么不用 `semver` 包：`tools/` 底下所有脚本都是**零依赖**的，直接在
 * 干净的 Node 上跑（构建机甚至没有 `npm install` 这一步）。为了一个比较
 * 引入第三方包，会让「拉下仓库就能构建」这个前提失效。
 *
 * 为什么需要它（真机事故 v0.9.62）：移动端 UI 插件 `dsh-web-mobile@3.3.5`
 * 声明 `@deepseek-ai/dsh-client-* >=0.2.2-rc.1 <0.3.0-0`，而 `.cache/app.asar`
 * 那次抓到的是引擎 `0.2.1-rc.5`。构建一路绿灯（补丁、打包、签名全过），装上
 * 手机后引擎只是往 engine.log 写一行
 *
 *     dsh: skipping profile bundle "dsh-web-mobile": Plugin dsh-web-mobile@3.3.5
 *     is incompatible with dsh 0.2.1-rc.5: requirements {...}
 *
 * 然后把插件**静默跳过** —— 界面上就是「UI 出来了、工作区永远空」。这类
 * 失败必须在构建期炸掉，所以补上这个断言。
 *
 * 支持的区间语法就是 dsh 实际用到的那几种：`>=`、`>`、`<=`、`<`、`=`、
 * 空格连接的合取、`||` 连接的析取。**不认识的写法直接抛错**，不猜。
 */

/** 把 `1.2.3-rc.4+build` 拆成可比较的结构；不合法返回 null。 */
function parse(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    String(version).trim(),
  );
  if (m === null) return null;
  return {
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] === undefined ? [] : m[4].split("."),
  };
}

/** 标准 semver 排序：先比数字段；相等时有预发布标记的**更低**。 */
export function compareVersions(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  if (pa === null) throw new Error(`不是合法版本号：${a}`);
  if (pb === null) throw new Error(`不是合法版本号：${b}`);
  for (let i = 0; i < 3; i += 1) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  // `1.0.0` > `1.0.0-rc.1`：正式版高于同号预发布。
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i += 1) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    // 段数少的一方更低：`rc.1` < `rc.1.2`
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (nx !== ny) {
      // 数字标识符恒低于字母标识符（semver 规范第 11.4.3 条）。
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** 单个比较子（`>=0.2.2-rc.1` 这种）。 */
function testComparator(version, token) {
  const m = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(token.trim());
  if (m === null) throw new Error(`无法解析的版本约束：${token}`);
  const op = m[1] ?? "=";
  const target = m[2].trim();
  if (/^[\^~*x]/.test(target) || target.includes(" - ")) {
    throw new Error(
      `semver-lite 不支持这个区间写法：${token}。` +
        `要么改用 >=/< 展开，要么在这里补实现 —— 不要静默放行。`,
    );
  }
  const c = compareVersions(version, target);
  switch (op) {
    case ">=":
      return c >= 0;
    case ">":
      return c > 0;
    case "<=":
      return c <= 0;
    case "<":
      return c < 0;
    case "=":
      return c === 0;
    default:
      throw new Error(`未知比较符：${op}`);
  }
}

/** `satisfies("0.2.2-rc.3", ">=0.2.2-rc.1 <0.3.0-0")` → true */
export function satisfiesRange(version, range) {
  const text = String(range).trim();
  if (text === "" || text === "*") return true;
  return text.split("||").some((alt) => {
    const t = alt.trim();
    if (t === "") return false;
    return t.split(/\s+/).every((token) => testComparator(version, token));
  });
}
