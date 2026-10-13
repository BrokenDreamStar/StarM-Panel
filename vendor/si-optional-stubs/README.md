# systeminformation 可选原生依赖的占位模块

`systeminformation` 在 macOS 上会 `try { require('osx-temperature-sensor') }` /
`require('macos-temperature-sensor')` 去读 CPU / GPU 温度（`lib/cpu.js`、`lib/graphics.js`）。
这两个包是可选原生依赖，本项目**不安装**（原生模块会破坏单文件交叉编译，见 docs/DESIGN.md
ADR-001），于是每次调用都会走到「模块解析失败」的分支。

在 **bun 的 `--watch` / `--hot` 模式**下，Bun 的 CJS 解析器在解析失败时会把
`node_modules/systeminformation/lib` 这个目录 fd 泄漏掉一个：`si.cpuTemperature()`
每次泄漏 2 个、`si.graphics()` 每次泄漏 1 个。首页主循环 1s 一次、GPU 采样 3s 一次，
即约 2.3 个 fd/s。跑上几小时后进程 fd 耗尽，`si.*` 开始既不 resolve 也不 reject，
静态信息整块降级成空 —— 表现就是「首页只剩 CPU / RAM / SYS 三张卡，而且添加卡片里
一个可选设备都没有」。

这里放两个**纯 JS 占位模块**，让 require 能正常解析（返回「读不到温度」），
从根上不触发 Bun 的解析失败路径：

- 行为与现状一致：本来就拿不到 macOS 温度，占位模块返回空对象，`si` 照样给出 null；
- 纯 JS、无原生代码，`bun build --compile` 可以照常打包；
- 只在**解析层**兜底，不改变任何采样逻辑。

若哪天 Bun 修了这个解析器泄漏，或真的需要 macOS 温度，删掉这两个依赖即可。
