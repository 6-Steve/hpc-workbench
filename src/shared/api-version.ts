/**
 * preload 接口版本号。
 *
 * 为什么需要：Electron 的 **preload 脚本不参与热更新**。改了 `src/preload/index.ts`
 * 之后渲染层会立刻刷新、拿着新代码去调新方法，但窗口里跑的仍是旧 preload，
 * 于是一律报 `window.hpc.xxx is not a function`——看起来像 bug，其实只是没重启。
 *
 * 光靠"记得重启"不管用（已经踩过两次：dryRunJob、readJobLog）。所以：
 *   - preload 把这个常量挂到 `window.hpc.apiVersion`
 *   - 渲染层拿自己编译进来的期望值去比
 *   - 不一致就顶上一条横幅，直接告诉用户去重启
 *
 * **加/改/删任何一个 `window.hpc` 上的方法，都要把这个数字 +1。**
 * 数字变大本身没有意义，它只是一个"preload 与渲染层是不是同一次编译"的标记。
 *
 * 放在 shared 下是因为两边都要 import：preload 在 node 侧打包，
 * 渲染层在 web 侧打包，同一个文件会被分别编进两个 bundle——这正是要的效果。
 */
export const PRELOAD_API_VERSION = 29
